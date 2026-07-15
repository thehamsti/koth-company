from __future__ import annotations

import hashlib
import hmac
import json
import logging
import random
import time
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from queue import Empty, Full, Queue
from threading import Event, Thread
from typing import Any

import httpx
from httpx_sse import connect_sse


AUTOMATION_EVENTS_PATH = "/api/predictions/automation/events"
AUTOMATION_STREAM_READ_TIMEOUT = 30.0
logger = logging.getLogger(__name__)


def signed_headers(
    *,
    secret: str,
    method: str,
    path: str,
    body: str,
    idempotency_key: str,
    timestamp: str | None = None,
) -> dict[str, str]:
    request_timestamp = timestamp or str(int(time.time() * 1000))
    canonical = "\n".join([method.upper(), path, request_timestamp, idempotency_key, body])
    signature = hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()
    return {
        "x-cv-timestamp": request_timestamp,
        "x-cv-idempotency-key": idempotency_key,
        "x-cv-signature": signature,
    }


class AutomationClient:
    def __init__(self, server_url: str, secret: str, timeout: float = 10.0) -> None:
        if server_url.startswith("http://") and not server_url.startswith(
            ("http://localhost", "http://127.0.0.1")
        ):
            raise ValueError("Remote automation servers must use HTTPS")
        self.server_url = server_url.rstrip("/")
        self.secret = secret
        self.timeout = timeout
        self.http = httpx.Client(timeout=timeout)

    def state(self) -> dict[str, Any]:
        path = "/api/predictions/automation/state"
        headers = signed_headers(
            secret=self.secret,
            method="GET",
            path=path,
            body="",
            idempotency_key=str(uuid.uuid4()),
        )
        response = self.http.get(f"{self.server_url}{path}", headers=headers)
        response.raise_for_status()
        return response.json()

    def action(self, action: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
        path = "/api/predictions/automation/actions"
        body = json.dumps(action, separators=(",", ":"), ensure_ascii=False)
        headers = signed_headers(
            secret=self.secret,
            method="POST",
            path=path,
            body=body,
            idempotency_key=idempotency_key,
        )
        response = self.http.post(
            f"{self.server_url}{path}",
            content=body,
            headers={**headers, "content-type": "application/json"},
        )
        response.raise_for_status()
        return response.json()

    def states(self) -> Iterator[AutomationState]:
        headers = signed_headers(
            secret=self.secret,
            method="GET",
            path=AUTOMATION_EVENTS_PATH,
            body="",
            idempotency_key=str(uuid.uuid4()),
        )
        stream_timeout = httpx.Timeout(self.timeout, read=AUTOMATION_STREAM_READ_TIMEOUT)
        with connect_sse(
            self.http,
            "GET",
            f"{self.server_url}{AUTOMATION_EVENTS_PATH}",
            headers=headers,
            timeout=stream_timeout,
        ) as event_source:
            event_source.response.raise_for_status()
            for event in event_source.iter_sse():
                if event.event != "automation.state":
                    continue
                envelope = event.json()
                if (
                    not isinstance(envelope, dict)
                    or not isinstance(envelope.get("revision"), str)
                    or not isinstance(envelope.get("payload"), dict)
                ):
                    raise ValueError("automation.state payload must be an object")
                yield AutomationState(
                    revision=envelope["revision"],
                    payload=envelope["payload"],
                )


@dataclass(frozen=True)
class AutomationState:
    revision: str
    payload: dict[str, Any]


@dataclass(frozen=True)
class AutomationStreamUpdate:
    state: AutomationState | None
    error: Exception | None = None


def _reconnect_delay(
    attempt: int,
    jitter: Callable[[float, float], float] = random.uniform,
) -> float:
    ceiling = min(30.0, 2.0 ** min(attempt, 5))
    return jitter(max(1.0, ceiling / 2), ceiling)


class AutomationStateFeed:
    def __init__(
        self,
        client: AutomationClient,
        *,
        jitter: Callable[[float, float], float] = random.uniform,
    ) -> None:
        self.client = client
        self.jitter = jitter
        self.updates: Queue[AutomationStreamUpdate] = Queue(maxsize=1)
        self.stop_event = Event()
        self.thread = Thread(target=self._run, name="automation-state-stream", daemon=True)

    def start(self) -> None:
        self.thread.start()

    def next(self, timeout: float | None) -> AutomationStreamUpdate | None:
        try:
            return self.updates.get(timeout=timeout)
        except Empty:
            return None

    def close(self) -> None:
        self.stop_event.set()
        self.thread.join(timeout=1)

    def _publish(self, update: AutomationStreamUpdate) -> None:
        try:
            self.updates.put_nowait(update)
            return
        except Full:
            pass
        try:
            self.updates.get_nowait()
        except Empty:
            pass
        self.updates.put_nowait(update)

    def _run(self) -> None:
        attempt = 0
        while not self.stop_event.is_set():
            try:
                received_state = False
                for state in self.client.states():
                    if self.stop_event.is_set():
                        return
                    received_state = True
                    attempt = 0
                    self._publish(AutomationStreamUpdate(state=state))
                raise httpx.ReadError("automation event stream closed")
            except Exception as exc:
                if self.stop_event.is_set():
                    return
                self._publish(AutomationStreamUpdate(state=None, error=exc))
                delay = _reconnect_delay(attempt, self.jitter)
                attempt = 0 if received_state else attempt + 1
                logger.warning(
                    "Automation state stream disconnected: %s; reconnecting in %.1fs",
                    exc,
                    delay,
                )
                self.stop_event.wait(delay)
