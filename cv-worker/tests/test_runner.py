from pathlib import Path
from typing import Any

import numpy as np
import pytest

from koth_cv.journal import ActionJournal
from koth_cv.runner import (
    PendingActionConflictError,
    RetryableWorkerError,
    Worker,
    automation_ready,
    evidence_data_url,
    snapshot_from_payload,
)
from koth_cv.state_machine import Observation


class StubClient:
    def __init__(self) -> None:
        self.actions: list[tuple[dict[str, Any], str]] = []

    def action(self, action: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
        self.actions.append((action, idempotency_key))
        return {"id": "domain-event"}


class StubDetector:
    def detect(self, _frame: np.ndarray) -> Observation:
        return Observation(active_name="Hydra")


def test_snapshot_maps_server_roster_and_active_arena() -> None:
    result = snapshot_from_payload(
        {
            "event": {"id": "event", "status": "live"},
            "contestants": [{"id": "contestant", "displayName": "Hydra", "wins": 4}],
            "activeArena": {
                "id": "arena",
                "status": "locked",
                "contestantId": "contestant",
            },
        }
    )

    assert result.contestants == {"Hydra": "contestant"}
    assert result.arena_id == "arena"
    assert result.arena_contestant_name == "Hydra"
    assert result.arena_contestant_wins == 4


def test_snapshot_excludes_eliminated_contestants_from_arena_selection() -> None:
    result = snapshot_from_payload(
        {
            "event": {"id": "event", "status": "live"},
            "contestants": [
                {
                    "id": "eliminated",
                    "displayName": "Hydra",
                    "wins": 2,
                    "status": "eliminated",
                },
                {
                    "id": "queued",
                    "displayName": "Rival",
                    "wins": 0,
                    "status": "queued",
                },
            ],
            "activeArena": None,
        }
    )

    assert result.contestants == {"Rival": "queued"}
    assert result.unavailable_contestant_names == frozenset({"hydra"})


def test_snapshot_normalizes_unavailable_contestant_accents() -> None:
    result = snapshot_from_payload(
        {
            "event": {"id": "event", "status": "live"},
            "contestants": [
                {
                    "id": "eliminated",
                    "displayName": "Kaptèn",
                    "wins": 2,
                    "status": "eliminated",
                }
            ],
            "activeArena": None,
        }
    )

    assert result.unavailable_contestant_names == frozenset({"kapten"})


def test_worker_sends_a_stable_action_with_worker_identity(tmp_path: Path) -> None:
    client = StubClient()
    worker = Worker(
        client=client,
        detector=StubDetector(),
        journal=ActionJournal(tmp_path / "journal.json"),
        worker_id="hydramist-mac",
    )
    payload = {
        "event": {"id": "event", "status": "live"},
        "contestants": [{"id": "contestant", "displayName": "Hydra", "wins": 0}],
        "activeArena": None,
    }
    frame = np.zeros((100, 100, 3), dtype=np.uint8)

    for _ in range(3):
        assert worker.process(frame, payload) is None
    worker.process(frame, payload)

    assert client.actions[0][0] == {
        "type": "open_arena",
        "contestantId": "contestant",
        "eventId": "event",
        "workerId": "hydramist-mac",
    }
    assert worker.journal.pending() is None


def test_evidence_is_bounded_for_the_server_contract() -> None:
    noisy = np.random.default_rng(7).integers(0, 256, (1080, 1920, 3), dtype=np.uint8)

    evidence = evidence_data_url(noisy)

    assert evidence.startswith("data:image/jpeg;base64,")
    assert len(evidence) <= 250_000


def test_dry_run_processes_frames_without_enabling_server_automation() -> None:
    assert automation_ready("disabled", dry_run=True) is True
    assert automation_ready("disabled", dry_run=False) is False


def test_reconciles_a_lost_pause_response_even_when_server_is_now_paused(
    tmp_path: Path,
) -> None:
    client = StubClient()
    journal = ActionJournal(tmp_path / "pause-journal.json")
    pending = journal.stage(
        {
            "type": "pause",
            "eventId": "event",
            "workerId": "old-worker",
            "reason": "Ambiguous result",
        }
    )
    worker = Worker(
        client=client,
        detector=StubDetector(),
        journal=journal,
        worker_id="new-worker",
    )

    recovered = worker.recover_pending(
        {
            "event": {"id": "event", "status": "live"},
            "automation": {"status": "paused"},
        }
    )

    assert recovered == pending.action
    assert client.actions == [(pending.action, pending.idempotency_key)]
    assert journal.pending() is None


def test_pending_action_is_retained_when_current_event_does_not_match(tmp_path: Path) -> None:
    client = StubClient()
    journal = ActionJournal(tmp_path / "mismatch-journal.json")
    pending = journal.stage(
        {
            "type": "record_result",
            "eventId": "old-event",
            "workerId": "old-worker",
        }
    )
    worker = Worker(
        client=client,
        detector=StubDetector(),
        journal=journal,
        worker_id="new-worker",
    )

    with pytest.raises(PendingActionConflictError, match=r"old-event.*new-event.*retained"):
        worker.recover_pending({"event": {"id": "new-event", "status": "live"}})

    assert client.actions == []
    assert journal.pending() == pending


def test_vision_errors_are_marked_retryable_without_staging_an_action(tmp_path: Path) -> None:
    class FailingDetector:
        def detect(self, _frame: np.ndarray) -> Observation:
            raise RuntimeError("OCR model temporarily unavailable")

    worker = Worker(
        client=StubClient(),
        detector=FailingDetector(),
        journal=ActionJournal(tmp_path / "vision-journal.json"),
        worker_id="worker",
    )

    with pytest.raises(RetryableWorkerError, match="vision detection failed.*OCR model"):
        worker.process(
            np.zeros((10, 10, 3), dtype=np.uint8),
            {
                "event": {"id": "event", "status": "live"},
                "contestants": [],
                "activeArena": None,
            },
        )

    assert worker.journal.pending() is None
