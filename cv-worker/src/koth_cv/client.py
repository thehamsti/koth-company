from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from typing import Any

import httpx


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
