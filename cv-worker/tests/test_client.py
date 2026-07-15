import json

import httpx
import pytest

from koth_cv.client import (
    AUTOMATION_EVENTS_PATH,
    AUTOMATION_STREAM_READ_TIMEOUT,
    AutomationClient,
    AutomationState,
    AutomationStateFeed,
    AutomationStreamUpdate,
    _reconnect_delay,
    signed_headers,
)


def test_signed_headers_match_server_contract() -> None:
    headers = signed_headers(
        secret="secret",
        method="POST",
        path="/api/predictions/automation/actions",
        body='{"type":"heartbeat"}',
        idempotency_key="arena-4-result",
        timestamp="1720000000000",
    )

    assert headers["x-cv-signature"] == (
        "7e59ecc1a6fa4c4139ffc925227cade8e235dc520755ffc41affef633262dcfa"
    )


def test_states_consumes_the_signed_automation_stream() -> None:
    payload = {
        "event": {"id": "event"},
        "automation": {"status": "running"},
        "contestants": [],
        "activeArena": None,
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.method == "GET"
        assert request.url.path == AUTOMATION_EVENTS_PATH
        assert request.headers["accept"] == "text/event-stream"
        assert request.headers["x-cv-idempotency-key"]
        assert request.headers["x-cv-signature"]
        assert request.extensions["timeout"]["read"] == AUTOMATION_STREAM_READ_TIMEOUT
        data = json.dumps(
            {
                "revision": "process-1:1",
                "emittedAt": "2026-07-14T12:00:00.000Z",
                "payload": payload,
            }
        )
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content=f": keepalive\n\nevent: stream.ready\ndata: {{}}\n\nevent: automation.state\ndata: {data}\n\n",
        )

    client = AutomationClient("http://localhost:4000", "secret")
    client.http = httpx.Client(transport=httpx.MockTransport(handler))

    assert list(client.states()) == [AutomationState(revision="process-1:1", payload=payload)]


def test_states_rejects_a_malformed_automation_event() -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            content='event: automation.state\ndata: {"revision":"process-1:1","payload":null}\n\n',
        )

    client = AutomationClient("http://localhost:4000", "secret")
    client.http = httpx.Client(transport=httpx.MockTransport(handler))

    with pytest.raises(ValueError, match="payload must be an object"):
        list(client.states())


def test_state_feed_keeps_only_the_newest_update() -> None:
    client = AutomationClient("http://localhost:4000", "secret")
    feed = AutomationStateFeed(client)
    old = AutomationStreamUpdate(
        state=AutomationState(revision="process-1:1", payload={"event": None})
    )
    newest = AutomationStreamUpdate(
        state=AutomationState(revision="process-1:2", payload={"event": {"id": "event"}})
    )

    feed._publish(old)
    feed._publish(newest)

    assert feed.next(0) == newest
    assert feed.next(0) is None


@pytest.mark.parametrize(
    ("attempt", "expected_bounds"),
    [
        (0, (1.0, 1.0)),
        (1, (1.0, 2.0)),
        (2, (2.0, 4.0)),
        (10, (15.0, 30.0)),
    ],
)
def test_reconnect_delay_is_jittered_and_bounded(
    attempt: int,
    expected_bounds: tuple[float, float],
) -> None:
    seen_bounds: tuple[float, float] | None = None

    def take_upper(lower: float, upper: float) -> float:
        nonlocal seen_bounds
        seen_bounds = (lower, upper)
        return upper

    assert _reconnect_delay(attempt, take_upper) == expected_bounds[1]
    assert seen_bounds == expected_bounds
