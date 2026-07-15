import json
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest
from typer.testing import CliRunner

from koth_cv import cli
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
    assert "--takeover cannot be used with --dry-run" in result.output


def test_loop_reconciles_lost_pause_response_before_paused_readiness(tmp_path: Path) -> None:
    class PausingClient:
        def __init__(self) -> None:
            self.actions: list[tuple[dict[str, object], str]] = []
            self.paused = False

        def state(self) -> dict[str, object]:
            return {
                "event": {"id": "event", "status": "live"},
                "automation": {"status": "paused" if self.paused else "running"},
                "contestants": [],
                "activeArena": None,
            }

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
    times = iter([1.0, 2.0])

    cli._run_worker_frames(
        FiniteSource(2),
        client=client,
        worker=worker,
        worker_id="worker:1",
        dry_run=False,
        fps=2,
        takeover=False,
        monotonic=lambda: next(times),
        sleep=lambda _seconds: None,
        max_iterations=2,
    )

    assert client.paused is True
    assert detector.calls == 1
    assert len(client.actions) == 2
    assert client.actions[0][1] == client.actions[1][1]
    assert json.dumps(client.actions[0][0], sort_keys=True) == json.dumps(
        client.actions[1][0], sort_keys=True
    )
    assert client.actions[0][0]["type"] == "pause"
    assert journal.pending() is None


def test_loop_continues_across_state_and_vision_failures(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    class FlakyClient:
        def __init__(self) -> None:
            self.state_calls = 0

        def state(self) -> dict[str, object]:
            self.state_calls += 1
            if self.state_calls == 1:
                raise RuntimeError("API temporarily unavailable")
            return {
                "event": {"id": "event", "status": "live"},
                "automation": {"status": "running"},
                "contestants": [],
                "activeArena": None,
            }

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
    times = iter([1.0, 6.0, 7.0])
    caplog.set_level("WARNING", logger="koth_cv.cli")

    cli._run_worker_frames(
        FiniteSource(3),
        client=client,
        worker=worker,
        worker_id="worker:1",
        dry_run=True,
        fps=2,
        takeover=False,
        monotonic=lambda: next(times),
        sleep=lambda _seconds: None,
        max_iterations=3,
    )

    assert client.state_calls == 3
    assert detector.calls == 2
    assert "fetch automation state" in caplog.text
    assert "process a vision frame" in caplog.text
    assert "retrying on a later frame" in caplog.text


def test_loop_polls_missing_event_state_every_five_seconds(tmp_path: Path) -> None:
    class IdleClient:
        def __init__(self) -> None:
            self.state_calls = 0

        def state(self) -> dict[str, object]:
            self.state_calls += 1
            return {"event": None, "automation": None}

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
    times = iter([100.0, 101.0, 102.0, 104.9, 105.0])

    cli._run_worker_frames(
        UnexpectedSource(),
        client=client,
        worker=worker,
        worker_id="worker:idle",
        dry_run=False,
        fps=5,
        takeover=False,
        monotonic=lambda: next(times),
        sleep=lambda _seconds: None,
        max_iterations=5,
    )

    assert client.state_calls == 2


def test_loop_keeps_five_second_heartbeats_while_automation_is_paused(
    tmp_path: Path,
) -> None:
    class PausedClient:
        def __init__(self) -> None:
            self.state_calls = 0
            self.actions: list[dict[str, object]] = []

        def state(self) -> dict[str, object]:
            self.state_calls += 1
            return {
                "event": {"id": "event", "status": "live"},
                "automation": {"status": "paused"},
                "contestants": [],
                "activeArena": None,
            }

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
    times = iter([100.0, 101.0, 104.9, 105.0])

    cli._run_worker_frames(
        UnexpectedSource(),
        client=client,
        worker=worker,
        worker_id="worker:paused",
        dry_run=False,
        fps=5,
        takeover=False,
        monotonic=lambda: next(times),
        sleep=lambda _seconds: None,
        max_iterations=4,
    )

    assert client.state_calls == 4
    assert [action["type"] for action in client.actions] == ["heartbeat", "heartbeat"]


def test_loop_closes_capture_while_paused_and_reopens_after_heartbeat(
    tmp_path: Path,
) -> None:
    class TransitionClient:
        def __init__(self) -> None:
            self.state_calls = 0
            self.status = "running"
            self.actions: list[dict[str, object]] = []

        def state(self) -> dict[str, object]:
            self.state_calls += 1
            if self.state_calls == 2:
                self.status = "paused"
            return {
                "event": {"id": "event", "status": "live"},
                "automation": {"status": self.status},
                "contestants": [],
                "activeArena": None,
            }

        def action(self, action: dict[str, object], _idempotency_key: str) -> dict[str, object]:
            self.actions.append(action)
            self.status = "running"
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
    times = iter([1.0, 2.0, 3.0, 7.0])

    cli._run_worker_frames(
        source,
        client=client,
        worker=worker,
        worker_id="worker:transition",
        dry_run=False,
        fps=2,
        takeover=False,
        monotonic=lambda: next(times),
        sleep=lambda _seconds: None,
        max_iterations=4,
    )

    assert detector.calls == 2
    assert source.sessions == 2
    assert source.closed == 2
    assert [action["type"] for action in client.actions] == ["heartbeat"]


def test_loop_closes_capture_when_state_refresh_fails(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    class FailingClient:
        def __init__(self) -> None:
            self.state_calls = 0

        def state(self) -> dict[str, object]:
            self.state_calls += 1
            if self.state_calls == 2:
                raise RuntimeError("production API unavailable")
            return {
                "event": {"id": "event", "status": "live"},
                "automation": {"status": "running"},
                "contestants": [],
                "activeArena": None,
            }

        def action(self, _action: dict[str, object], _idempotency_key: str) -> dict[str, object]:
            raise AssertionError("heartbeat is not due in this test")

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
    times = iter([1.0, 2.0])
    caplog.set_level("WARNING", logger="koth_cv.cli")

    cli._run_worker_frames(
        source,
        client=client,
        worker=worker,
        worker_id="worker:failure",
        dry_run=False,
        fps=2,
        takeover=False,
        monotonic=lambda: next(times),
        sleep=lambda _seconds: None,
        max_iterations=2,
    )

    assert source.sessions == 1
    assert source.closed == 1
    assert "fetch automation state" in caplog.text


def test_takeover_retries_until_first_successful_heartbeat_then_stops(
    tmp_path: Path,
) -> None:
    class LeaseClient:
        def __init__(self) -> None:
            self.heartbeats: list[dict[str, object]] = []

        def state(self) -> dict[str, object]:
            return {
                "event": {"id": "event", "status": "live"},
                "automation": {"status": "running"},
                "contestants": [],
                "activeArena": None,
            }

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
    times = iter([10.0, 16.0, 22.0])

    cli._run_worker_frames(
        source,
        client=client,
        worker=worker,
        worker_id="worker:2",
        dry_run=False,
        fps=2,
        takeover=True,
        monotonic=lambda: next(times),
        sleep=lambda _seconds: None,
        max_iterations=3,
    )

    assert [heartbeat.get("takeover", False) for heartbeat in client.heartbeats] == [
        True,
        True,
        False,
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
