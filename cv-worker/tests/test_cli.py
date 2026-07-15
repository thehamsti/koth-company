import json
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest
from click import unstyle
from typer.testing import CliRunner

from koth_cv import cli
from koth_cv.client import AutomationState, AutomationStreamUpdate
from koth_cv.config import Layout, Region, save_layout
from koth_cv.journal import ActionJournal
from koth_cv.runner import Worker
from koth_cv.state_machine import Observation


REQUIRED_REGIONS = (
    "overlay",
    "start",
    "result",
)
REQUIRED_TEMPLATES: tuple[str, ...] = ()


class FiniteSource:
    def __init__(self, count: int) -> None:
        self.values = [np.zeros((10, 10, 3), dtype=np.uint8) for _ in range(count)]

    def frames(self) -> Iterator[np.ndarray]:
        return iter(self.values)


class UnexpectedSource:
    def frames(self) -> Iterator[np.ndarray]:
        raise AssertionError("idle automation cannot open the Twitch stream")


class TrackingSource:
    def __init__(self) -> None:
        self.sessions = 0
        self.closed = 0

    def frames(self) -> Iterator[np.ndarray]:
        self.sessions += 1
        try:
            while True:
                yield np.zeros((10, 10, 3), dtype=np.uint8)
        finally:
            self.closed += 1


class FakeClock:
    def __init__(self, now: float = 100.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class ScriptedFeed:
    def __init__(
        self,
        clock: FakeClock,
        updates: list[tuple[float, AutomationStreamUpdate]],
    ) -> None:
        self.clock = clock
        self.updates = updates
        self.timeouts: list[float | None] = []
        self.started = False
        self.closed = False

    def start(self) -> None:
        self.started = True

    def next(self, timeout: float | None) -> AutomationStreamUpdate | None:
        self.timeouts.append(timeout)
        if self.updates:
            delay, update = self.updates[0]
            if timeout is None or delay <= timeout:
                self.clock.advance(delay)
                self.updates.pop(0)
                return update
            self.clock.advance(timeout)
            self.updates[0] = (delay - timeout, update)
            return None
        if timeout is not None:
            self.clock.advance(timeout)
        return None

    def close(self) -> None:
        self.closed = True


def automation_update(
    revision: str,
    *,
    status: str = "running",
    worker_id: str | None = "worker:1",
    enabled: bool = True,
    event: bool = True,
) -> AutomationStreamUpdate:
    return AutomationStreamUpdate(
        state=AutomationState(
            revision=revision,
            payload={
                "event": {"id": "event", "status": "live"} if event else None,
                "automation": (
                    {"status": status, "enabled": enabled, "workerId": worker_id} if event else None
                ),
                "contestants": [],
                "activeArena": None,
            },
        )
    )


def write_complete_layout(tmp_path: Path, *, extra_template: str | None = None) -> Path:
    template_dir = tmp_path / "templates"
    template_dir.mkdir()
    templates = {name: f"templates/{name}.png" for name in REQUIRED_TEMPLATES}
    for template in templates.values():
        (tmp_path / template).write_bytes(b"template")
    if extra_template:
        templates[extra_template] = f"templates/{extra_template}.png"
    region = Region(x=0, y=0, width=0.1, height=0.1)
    path = tmp_path / "layout.yaml"
    save_layout(
        Layout(
            regions={name: region for name in REQUIRED_REGIONS},
            templates=templates,
        ),
        path,
    )
    return path


def test_cli_exposes_operator_workflow_commands() -> None:
    result = CliRunner().invoke(cli.app, ["--help"])

    assert result.exit_code == 0
    for command in ("calibrate", "doctor", "run", "record", "replay"):
        assert command in result.stdout


def test_run_rejects_any_missing_template_file_before_capture(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = write_complete_layout(tmp_path, extra_template="overlay")
    capture_started = False

    class UnexpectedSource:
        def __init__(self, *_args: object) -> None:
            nonlocal capture_started
            capture_started = True

    monkeypatch.setenv("KOTH_CV_LAYOUT", str(path))
    monkeypatch.setenv("PREDICTION_CV_SECRET", "secret")
    monkeypatch.setattr(cli, "TwitchSource", UnexpectedSource)

    result = CliRunner().invoke(cli.app, ["run"])

    assert result.exit_code == 2
    assert "template-file:overlay" in result.output
    assert capture_started is False


@pytest.mark.parametrize("status", ["completed", "cancelled"])
def test_doctor_rejects_non_runnable_event_states(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, status: str
) -> None:
    path = write_complete_layout(tmp_path)

    class StubSource:
        def __init__(self, *_args: object) -> None:
            pass

        def capture(self) -> np.ndarray:
            return np.zeros((1080, 1920, 3), dtype=np.uint8)

    class StubOcrReader:
        def read(self, _frame: np.ndarray) -> list[tuple[str, float]]:
            return []

        def read_with_boxes(
            self, _frame: np.ndarray
        ) -> list[tuple[str, float, tuple[int, int, int, int]]]:
            return [
                ("Leaderboard:", 0.99, (0, 0, 30, 5)),
                ("Current player:", 0.99, (0, 10, 35, 5)),
                ("Hydra", 0.99, (0, 16, 15, 5)),
                ("Wins: 0", 0.99, (20, 16, 15, 5)),
                ("Queue:", 0.99, (0, 25, 20, 5)),
            ]

    class StubClient:
        def state(self) -> dict[str, object]:
            return {"event": {"name": "Finished KOTH", "status": status}}

    monkeypatch.setenv("KOTH_CV_LAYOUT", str(path))
    monkeypatch.setattr(cli, "TwitchSource", StubSource)
    monkeypatch.setattr(cli, "RapidOcrReader", StubOcrReader)
    monkeypatch.setattr(cli, "automation_client", StubClient)

    result = CliRunner().invoke(cli.app, ["doctor"])

    assert result.exit_code == 2
    assert f"not runnable (status: {status})" in result.output


def test_doctor_rejects_a_stream_without_the_koth_overlay(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    path = write_complete_layout(tmp_path)

    class StubSource:
        def __init__(self, *_args: object) -> None:
            pass

        def capture(self) -> np.ndarray:
            return np.zeros((1080, 1920, 3), dtype=np.uint8)

    class EmptyOcrReader:
        def read(self, _frame: np.ndarray) -> list[tuple[str, float]]:
            return []

        def read_with_boxes(
            self, _frame: np.ndarray
        ) -> list[tuple[str, float, tuple[int, int, int, int]]]:
            return []

    class UnexpectedClient:
        def state(self) -> dict[str, object]:
            raise AssertionError("doctor should reject the stream before contacting the server")

    monkeypatch.setenv("KOTH_CV_LAYOUT", str(path))
    monkeypatch.setattr(cli, "TwitchSource", StubSource)
    monkeypatch.setattr(cli, "RapidOcrReader", EmptyOcrReader)
    monkeypatch.setattr(cli, "automation_client", UnexpectedClient)

    result = CliRunner().invoke(cli.app, ["doctor"])

    assert result.exit_code == 2
    assert "KOTH overlay not detected" in result.output
    for anchor in ("Leaderboard", "Current player", "Queue"):
        assert anchor in result.output


def test_default_worker_identity_includes_pid(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(cli.socket, "gethostname", lambda: "hydramist-mac")
    monkeypatch.setattr(cli.os, "getpid", lambda: 4242)

    assert cli.default_worker_id() == "hydramist-mac:4242"


def test_run_rejects_takeover_in_dry_run() -> None:
    result = CliRunner().invoke(cli.app, ["run", "--dry-run", "--takeover"])

    assert result.exit_code == 2
    output = " ".join(unstyle(result.output).split())
    assert "--takeover cannot be used with --dry-run" in output


def test_loop_reconciles_lost_pause_response_before_paused_readiness(tmp_path: Path) -> None:
    class PausingClient:
        def __init__(self) -> None:
            self.actions: list[tuple[dict[str, object], str]] = []
            self.paused = False

        def state(self) -> dict[str, object]:
            raise AssertionError("the frame loop must not poll automation state")

        def action(self, action: dict[str, object], idempotency_key: str) -> dict[str, object]:
            self.actions.append((action, idempotency_key))
            if action["type"] == "pause" and not self.paused:
                self.paused = True
                raise RuntimeError("server applied pause but response was lost")
            return {"id": None}

    class AmbiguousDetector:
        def __init__(self) -> None:
            self.calls = 0

        def detect(self, _frame: np.ndarray) -> Observation:
            self.calls += 1
            return Observation(metadata={"pauseReason": "Ambiguous arena result"})

    client = PausingClient()
    detector = AmbiguousDetector()
    journal = ActionJournal(tmp_path / "pending-pause.json")
    worker = Worker(
        client=client,
        detector=detector,
        journal=journal,
        worker_id="worker:1",
    )
    clock = FakeClock()
    feed = ScriptedFeed(
        clock,
        [
            (0, automation_update("revision-1")),
            (0, automation_update("revision-2", status="paused")),
        ],
    )

    cli._run_worker_frames(
        FiniteSource(2),
        client=client,
        worker=worker,
        worker_id="worker:1",
        dry_run=False,
        fps=2,
        takeover=False,
        monotonic=clock,
        state_feed=feed,
        max_iterations=2,
    )

    assert client.paused is True
    assert detector.calls == 1
    pause_actions = [item for item in client.actions if item[0]["type"] == "pause"]
    assert len(pause_actions) == 2
    assert pause_actions[0][1] == pause_actions[1][1]
    assert json.dumps(pause_actions[0][0], sort_keys=True) == json.dumps(
        pause_actions[1][0], sort_keys=True
    )
    assert journal.pending() is None
    assert feed.started is True
    assert feed.closed is True


def test_loop_fails_closed_on_stream_loss_and_recovers_vision_failures(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    class FlakyClient:
        def state(self) -> dict[str, object]:
            raise AssertionError("the frame loop must not poll automation state")

        def action(self, _action: dict[str, object], _idempotency_key: str) -> dict[str, object]:
            raise AssertionError("dry run must not send actions")

    class FlakyDetector:
        def __init__(self) -> None:
            self.calls = 0

        def detect(self, _frame: np.ndarray) -> Observation:
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("OCR temporarily unavailable")
            return Observation()

    client = FlakyClient()
    detector = FlakyDetector()
    worker = Worker(
        client=client,
        detector=detector,
        journal=ActionJournal(tmp_path / "flaky-loop.json"),
        worker_id="worker:1",
        dry_run=True,
    )
    clock = FakeClock()
    feed = ScriptedFeed(
        clock,
        [
            (0, automation_update("revision-1")),
            (
                0.25,
                AutomationStreamUpdate(
                    state=None,
                    error=RuntimeError("API temporarily unavailable"),
                ),
            ),
            (0.25, automation_update("revision-2")),
        ],
    )
    caplog.set_level("WARNING", logger="koth_cv.cli")

    cli._run_worker_frames(
        FiniteSource(3),
        client=client,
        worker=worker,
        worker_id="worker:1",
        dry_run=True,
        fps=2,
        takeover=False,
        monotonic=clock,
        state_feed=feed,
        max_iterations=3,
    )

    assert detector.calls == 2
    assert "read the automation event stream" in caplog.text
    assert "process a vision frame" in caplog.text
    assert "retrying" in caplog.text


def test_loop_waits_on_the_stream_when_there_is_no_event(tmp_path: Path) -> None:
    class IdleClient:
        def state(self) -> dict[str, object]:
            raise AssertionError("the frame loop must not poll automation state")

        def action(self, _action: dict[str, object], _idempotency_key: str) -> dict[str, object]:
            raise AssertionError("a missing event cannot receive automation actions")

    class UnexpectedDetector:
        def detect(self, _frame: np.ndarray) -> Observation:
            raise AssertionError("idle state cannot process vision frames")

    client = IdleClient()
    worker = Worker(
        client=client,
        detector=UnexpectedDetector(),
        journal=ActionJournal(tmp_path / "idle-loop.json"),
        worker_id="worker:idle",
    )
    clock = FakeClock()
    feed = ScriptedFeed(
        clock,
        [(0, automation_update("revision-1", event=False))],
    )

    cli._run_worker_frames(
        UnexpectedSource(),
        client=client,
        worker=worker,
        worker_id="worker:idle",
        dry_run=False,
        fps=5,
        takeover=False,
        monotonic=clock,
        state_feed=feed,
        max_iterations=2,
    )

    assert feed.timeouts == [None, None]


@pytest.mark.parametrize(
    "update",
    [
        automation_update("revision-1", status="disabled", enabled=False),
        automation_update("revision-1", worker_id="another-worker"),
    ],
)
def test_loop_does_not_heartbeat_or_capture_an_unowned_session(
    tmp_path: Path,
    update: AutomationStreamUpdate,
) -> None:
    class QuietClient:
        def state(self) -> dict[str, object]:
            raise AssertionError("the frame loop must not poll automation state")

        def action(self, _action: dict[str, object], _key: str) -> dict[str, object]:
            raise AssertionError("an unowned session cannot receive heartbeats")

    client = QuietClient()
    clock = FakeClock()
    feed = ScriptedFeed(clock, [(0, update)])
    worker = Worker(
        client=client,
        detector=lambda _frame: Observation(),
        journal=ActionJournal(tmp_path / "unowned-loop.json"),
        worker_id="worker:1",
    )

    cli._run_worker_frames(
        UnexpectedSource(),
        client=client,
        worker=worker,
        worker_id="worker:1",
        dry_run=False,
        fps=2,
        takeover=False,
        monotonic=clock,
        state_feed=feed,
        max_iterations=2,
    )

    assert feed.timeouts == [None, None]


def test_loop_keeps_five_second_heartbeats_while_automation_is_paused(
    tmp_path: Path,
) -> None:
    class PausedClient:
        def __init__(self) -> None:
            self.actions: list[dict[str, object]] = []

        def state(self) -> dict[str, object]:
            raise AssertionError("the frame loop must not poll automation state")

        def action(self, action: dict[str, object], _idempotency_key: str) -> dict[str, object]:
            self.actions.append(action)
            return {"id": None}

    class UnexpectedDetector:
        def detect(self, _frame: np.ndarray) -> Observation:
            raise AssertionError("paused automation cannot process vision frames")

    client = PausedClient()
    worker = Worker(
        client=client,
        detector=UnexpectedDetector(),
        journal=ActionJournal(tmp_path / "paused-loop.json"),
        worker_id="worker:paused",
    )
    clock = FakeClock()
    feed = ScriptedFeed(
        clock,
        [
            (
                0,
                automation_update(
                    "revision-1",
                    status="paused",
                    worker_id="worker:paused",
                ),
            )
        ],
    )

    cli._run_worker_frames(
        UnexpectedSource(),
        client=client,
        worker=worker,
        worker_id="worker:paused",
        dry_run=False,
        fps=5,
        takeover=False,
        monotonic=clock,
        state_feed=feed,
        max_iterations=2,
    )

    assert [action["type"] for action in client.actions] == ["heartbeat", "heartbeat"]
    assert clock.now == 105


def test_loop_closes_capture_while_paused_and_reopens_after_streamed_resume(
    tmp_path: Path,
) -> None:
    class TransitionClient:
        def __init__(self) -> None:
            self.actions: list[dict[str, object]] = []

        def state(self) -> dict[str, object]:
            raise AssertionError("the frame loop must not poll automation state")

        def action(self, action: dict[str, object], _idempotency_key: str) -> dict[str, object]:
            self.actions.append(action)
            return {"id": None}

    class CountingDetector:
        def __init__(self) -> None:
            self.calls = 0

        def detect(self, _frame: np.ndarray) -> Observation:
            self.calls += 1
            return Observation()

    client = TransitionClient()
    detector = CountingDetector()
    source = TrackingSource()
    worker = Worker(
        client=client,
        detector=detector,
        journal=ActionJournal(tmp_path / "transition-loop.json"),
        worker_id="worker:transition",
    )
    clock = FakeClock()
    feed = ScriptedFeed(
        clock,
        [
            (0, automation_update("revision-1", worker_id="worker:transition")),
            (
                0.25,
                automation_update(
                    "revision-2",
                    status="paused",
                    worker_id="worker:transition",
                ),
            ),
            (0.25, automation_update("revision-3", worker_id="worker:transition")),
        ],
    )

    cli._run_worker_frames(
        source,
        client=client,
        worker=worker,
        worker_id="worker:transition",
        dry_run=False,
        fps=2,
        takeover=False,
        monotonic=clock,
        state_feed=feed,
        max_iterations=3,
    )

    assert detector.calls == 2
    assert source.sessions == 2
    assert source.closed == 2
    assert [action["type"] for action in client.actions] == ["heartbeat"]


def test_loop_closes_capture_when_the_event_stream_disconnects(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    class FailingClient:
        def state(self) -> dict[str, object]:
            raise AssertionError("the frame loop must not poll automation state")

        def action(self, _action: dict[str, object], _idempotency_key: str) -> dict[str, object]:
            return {"id": None}

    class QuietDetector:
        def detect(self, _frame: np.ndarray) -> Observation:
            return Observation()

    client = FailingClient()
    source = TrackingSource()
    worker = Worker(
        client=client,
        detector=QuietDetector(),
        journal=ActionJournal(tmp_path / "state-failure-loop.json"),
        worker_id="worker:failure",
    )
    clock = FakeClock()
    feed = ScriptedFeed(
        clock,
        [
            (0, automation_update("revision-1", worker_id="worker:failure")),
            (
                0.25,
                AutomationStreamUpdate(
                    state=None,
                    error=RuntimeError("production API unavailable"),
                ),
            ),
        ],
    )
    caplog.set_level("WARNING", logger="koth_cv.cli")

    cli._run_worker_frames(
        source,
        client=client,
        worker=worker,
        worker_id="worker:failure",
        dry_run=False,
        fps=2,
        takeover=False,
        monotonic=clock,
        state_feed=feed,
        max_iterations=2,
    )

    assert source.sessions == 1
    assert source.closed == 1
    assert "read the automation event stream" in caplog.text


def test_takeover_retries_until_first_successful_heartbeat_then_stops(
    tmp_path: Path,
) -> None:
    class LeaseClient:
        def __init__(self) -> None:
            self.heartbeats: list[dict[str, object]] = []

        def state(self) -> dict[str, object]:
            raise AssertionError("the frame loop must not poll automation state")

        def action(self, action: dict[str, object], _idempotency_key: str) -> dict[str, object]:
            self.heartbeats.append(dict(action))
            if len(self.heartbeats) == 1:
                raise RuntimeError("existing lease is not stale yet")
            return {"id": None}

    class QuietDetector:
        def __init__(self) -> None:
            self.calls = 0

        def detect(self, _frame: np.ndarray) -> Observation:
            self.calls += 1
            return Observation()

    client = LeaseClient()
    detector = QuietDetector()
    source = TrackingSource()
    worker = Worker(
        client=client,
        detector=detector,
        journal=ActionJournal(tmp_path / "takeover-loop.json"),
        worker_id="worker:2",
    )
    clock = FakeClock()
    feed = ScriptedFeed(
        clock,
        [
            (
                0,
                automation_update(
                    "revision-1",
                    status="stale",
                    worker_id="worker:1",
                ),
            ),
            (5, automation_update("revision-2", worker_id="worker:2")),
        ],
    )

    cli._run_worker_frames(
        source,
        client=client,
        worker=worker,
        worker_id="worker:2",
        dry_run=False,
        fps=2,
        takeover=True,
        monotonic=clock,
        state_feed=feed,
        max_iterations=3,
    )

    assert [heartbeat.get("takeover", False) for heartbeat in client.heartbeats] == [
        True,
        True,
    ]
    assert detector.calls == 2
    assert source.sessions == 1
    assert source.closed == 1


def test_transient_logging_is_rate_limited(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level("WARNING", logger="koth_cv.cli")
    last_logged: dict[str, float] = {}

    for now in (1.0, 2.0, 31.0):
        cli._log_transient_failure(
            last_logged,
            operation="fetch automation state",
            error=RuntimeError("offline"),
            now=now,
            worker_id="worker:3",
        )

    assert caplog.text.count("fetch automation state") == 2
