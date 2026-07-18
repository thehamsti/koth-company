from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pytest

from koth_cv.config import Layout, Region
from koth_cv.journal import ActionJournal
from koth_cv.runner import Worker
from koth_cv.vision import VisionDetector


EVENT_ID = "00000000-0000-4000-8000-000000000001"
CONTESTANT_ID = "00000000-0000-4000-8000-000000000002"
ARENA_ID = "00000000-0000-4000-8000-000000000003"
AMBIGUOUS_ARENA_ID = "00000000-0000-4000-8000-000000000004"

FRAME_WIDTH = 160
FRAME_HEIGHT = 120
EMPTY_MARKER = 240
OVERLAY_MARKER = 200
ROSTER_MARKER = 30
HYDRA_MARKER = 40
UNKNOWN_MARKER = 50
COUNTER_ZERO_MARKER = 60
COUNTER_ONE_MARKER = 65
COUNTER_SEVEN_MARKER = 70
COUNTER_EIGHT_MARKER = 80
COUNTER_NINE_MARKER = 90
START_MARKER = 100
PURPLE_RESULT_MARKER = 110
GOLD_RESULT_MARKER = 120


class MarkerOcr:
    def read(self, image: np.ndarray) -> list[tuple[str, float]]:
        marker = int(image[0, 0, 0])
        return {
            START_MARKER: [("Shadowsights spawns in 95 sec", 0.99)],
            PURPLE_RESULT_MARKER: [("Purple Team Wins", 0.99)],
            GOLD_RESULT_MARKER: [("Gold Team Wins", 0.99)],
        }.get(marker, [])

    def read_with_boxes(
        self, image: np.ndarray
    ) -> list[tuple[str, float, tuple[int, int, int, int]]]:
        if int(image[0, 0, 0]) != OVERLAY_MARKER:
            return []
        roster_marker = int(image[1, 0, 0])
        active_marker = int(image[2, 0, 0])
        counter_marker = int(image[3, 0, 0])
        active_name = {
            HYDRA_MARKER: "Hydra",
            UNKNOWN_MARKER: "Unknown",
        }.get(active_marker)
        counter = {
            COUNTER_ZERO_MARKER: 0,
            COUNTER_ONE_MARKER: 1,
            COUNTER_SEVEN_MARKER: 7,
            COUNTER_EIGHT_MARKER: 8,
            COUNTER_NINE_MARKER: 9,
        }.get(counter_marker)
        detections = [
            ("Leaderboard:", 0.99, (0, 0, 30, 5)),
            ("Current player:", 0.99, (0, 10, 35, 5)),
            ("Queue:", 0.99, (0, 25, 20, 5)),
        ]
        if active_name:
            detections.append((active_name, 0.99, (0, 16, 15, 5)))
        if counter is not None:
            detections.append((f"Wins: {counter}", 0.99, (20, 16, 15, 5)))
        if roster_marker == ROSTER_MARKER:
            detections.append(("1. Hydra", 0.99, (0, 31, 20, 5)))
        return detections


class SyntheticStream:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.regions = {
            "overlay": Region(x=0, y=0, width=1, height=0.45),
            "start": Region(x=0, y=0.5, width=0.2, height=0.2),
            "result": Region(x=0.5, y=0.5, width=0.2, height=0.2),
        }
        rng = np.random.default_rng(20260714)
        self.base = rng.integers(
            0,
            256,
            (FRAME_HEIGHT, FRAME_WIDTH, 3),
            dtype=np.uint8,
        )
        layout = Layout(
            width=FRAME_WIDTH,
            height=FRAME_HEIGHT,
            regions=self.regions,
        )
        self.detector = VisionDetector(layout, MarkerOcr())

    def frame(
        self,
        *,
        roster: bool = False,
        active_name: str | None = None,
        start: bool = False,
        current_wins: int | None = None,
        result_team: str | None = None,
    ) -> np.ndarray:
        frame = self.base.copy()
        self._fill(frame, "overlay", EMPTY_MARKER)
        frame[0, 0] = OVERLAY_MARKER
        frame[1, 0] = ROSTER_MARKER if roster else EMPTY_MARKER
        active_marker = {
            "Hydra": HYDRA_MARKER,
            "Unknown": UNKNOWN_MARKER,
            None: EMPTY_MARKER,
        }[active_name]
        frame[2, 0] = active_marker
        counter_marker = {
            None: EMPTY_MARKER,
            0: COUNTER_ZERO_MARKER,
            1: COUNTER_ONE_MARKER,
            7: COUNTER_SEVEN_MARKER,
            8: COUNTER_EIGHT_MARKER,
            9: COUNTER_NINE_MARKER,
        }[current_wins]
        frame[3, 0] = counter_marker
        result_marker = {
            None: EMPTY_MARKER,
            "purple": PURPLE_RESULT_MARKER,
            "gold": GOLD_RESULT_MARKER,
        }[result_team]
        self._fill(frame, "start", START_MARKER if start else EMPTY_MARKER)
        self._fill(frame, "result", result_marker)
        return frame

    def _fill(self, frame: np.ndarray, name: str, marker: int) -> None:
        x, y, width, height = self.regions[name].pixels(FRAME_WIDTH, FRAME_HEIGHT)
        frame[y : y + height, x : x + width] = marker


class FakeAutomationClient:
    def __init__(self, *, fail_after_apply: set[str] | None = None) -> None:
        self.event_status = "draft"
        self.contestants: list[dict[str, Any]] = []
        self.active_arena: dict[str, str] | None = None
        self.results: list[bool] = []
        self.paused = False
        self.attempts: list[tuple[dict[str, Any], str]] = []
        self.applied_actions: list[dict[str, Any]] = []
        self._responses: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
        self._fail_after_apply = set(fail_after_apply or ())

    def state_payload(self) -> dict[str, Any]:
        return {
            "event": {"id": EVENT_ID, "status": self.event_status},
            "contestants": [dict(contestant) for contestant in self.contestants],
            "activeArena": dict(self.active_arena) if self.active_arena else None,
        }

    def activate_event(self) -> None:
        self.event_status = "live"

    def seed_locked_arena(self, *, wins: int = 7) -> None:
        self.event_status = "live"
        self.contestants = [{"id": CONTESTANT_ID, "displayName": "Hydra", "wins": wins}]
        self.active_arena = {
            "id": AMBIGUOUS_ARENA_ID,
            "status": "locked",
            "contestantId": CONTESTANT_ID,
        }

    def action(self, action: dict[str, Any], idempotency_key: str) -> dict[str, Any]:
        attempted = dict(action)
        self.attempts.append((attempted, idempotency_key))
        if existing := self._responses.get(idempotency_key):
            previous_action, response = existing
            assert attempted == previous_action
            return response

        self._apply(attempted)
        response = {"id": f"domain-event-{len(self.applied_actions)}"}
        self._responses[idempotency_key] = (attempted, response)
        action_type = str(action["type"])
        if action_type in self._fail_after_apply:
            self._fail_after_apply.remove(action_type)
            raise RuntimeError("server applied action but response was lost")
        return response

    def _apply(self, action: dict[str, Any]) -> None:
        action_type = action["type"]
        if action_type == "heartbeat":
            return
        if action_type == "add_contestant":
            assert self.event_status == "draft"
            self.contestants.append(
                {"id": CONTESTANT_ID, "displayName": str(action["displayName"]), "wins": 0}
            )
        elif action_type == "remove_contestant":
            assert self.event_status == "draft"
            self.contestants = [
                contestant
                for contestant in self.contestants
                if contestant["id"] != action["contestantId"]
            ]
        elif action_type == "open_arena":
            assert self.event_status == "live"
            assert self.active_arena is None
            assert action["contestantId"] == CONTESTANT_ID
            self.active_arena = {
                "id": ARENA_ID,
                "status": "open",
                "contestantId": CONTESTANT_ID,
            }
        elif action_type == "start_arena":
            assert self.active_arena == {
                "id": ARENA_ID,
                "status": "open",
                "contestantId": CONTESTANT_ID,
            }
            assert action["arenaId"] == ARENA_ID
            self.active_arena["status"] = "locked"
        elif action_type == "record_result":
            assert self.active_arena == {
                "id": ARENA_ID,
                "status": "locked",
                "contestantId": CONTESTANT_ID,
            }
            assert action["arenaId"] == ARENA_ID
            contestant_won = bool(action["contestantWon"])
            self.results.append(contestant_won)
            if contestant_won:
                self.contestants[0]["wins"] = int(self.contestants[0]["wins"]) + 1
            self.active_arena = None
        elif action_type == "pause":
            self.paused = True
        else:
            raise AssertionError(f"Unexpected automation action: {action_type}")
        self.applied_actions.append(action)


@pytest.fixture
def synthetic_stream(tmp_path: Path) -> SyntheticStream:
    return SyntheticStream(tmp_path / "vision")


def test_full_vision_worker_lifecycle_recovers_exactly_once_and_pauses_safely(
    tmp_path: Path,
    synthetic_stream: SyntheticStream,
) -> None:
    client = FakeAutomationClient(fail_after_apply={"open_arena"})
    journal_path = tmp_path / "action-journal.json"
    worker = Worker(
        client=client,
        detector=synthetic_stream.detector,
        journal=ActionJournal(journal_path),
        worker_id="hydramist-test",
    )

    draft_frame = synthetic_stream.frame(roster=True)
    assert worker.process(draft_frame, client.state_payload()) is None
    assert worker.process(draft_frame, client.state_payload()) is None
    assert worker.process(draft_frame, client.state_payload()) == {
        "type": "add_contestant",
        "displayName": "Hydra",
        "status": "queued",
        "wins": 0,
        "queuePosition": 1,
        "eventId": EVENT_ID,
        "workerId": "hydramist-test",
    }
    assert client.contestants == [{"id": CONTESTANT_ID, "displayName": "Hydra", "wins": 0}]

    client.activate_event()
    active_frame = synthetic_stream.frame(active_name="Hydra")
    for _ in range(3):
        assert worker.process(active_frame, client.state_payload()) is None
    with pytest.raises(RuntimeError, match="response was lost"):
        worker.process(active_frame, client.state_payload())

    pending = ActionJournal(journal_path).pending()
    assert pending is not None
    assert pending.action["type"] == "open_arena"
    assert client.active_arena == {
        "id": ARENA_ID,
        "status": "open",
        "contestantId": CONTESTANT_ID,
    }

    worker = Worker(
        client=client,
        detector=synthetic_stream.detector,
        journal=ActionJournal(journal_path),
        worker_id="hydramist-test",
    )
    worker.recover_pending(client.state_payload())

    assert ActionJournal(journal_path).pending() is None
    open_attempts = [attempt for attempt in client.attempts if attempt[0]["type"] == "open_arena"]
    assert len(open_attempts) == 2
    assert open_attempts[0][1] == open_attempts[1][1]
    assert len([action for action in client.applied_actions if action["type"] == "open_arena"]) == 1

    start_frame = synthetic_stream.frame(start=True)
    assert worker.process(start_frame, client.state_payload()) is None
    assert worker.process(start_frame, client.state_payload()) is None
    assert worker.process(start_frame, client.state_payload()) == {
        "type": "start_arena",
        "arenaId": ARENA_ID,
        "eventId": EVENT_ID,
        "workerId": "hydramist-test",
    }

    result_frame = synthetic_stream.frame(
        active_name="Hydra",
        current_wins=1,
        result_team="purple",
    )
    assert worker.process(result_frame, client.state_payload()) is None
    assert worker.process(result_frame, client.state_payload()) is None
    assert worker.process(result_frame, client.state_payload()) == {
        "type": "record_result",
        "arenaId": ARENA_ID,
        "contestantWon": True,
        "eventId": EVENT_ID,
        "workerId": "hydramist-test",
    }
    assert client.results == [True]
    assert client.active_arena is None

    unknown_frame = synthetic_stream.frame(active_name="Unknown")
    for _ in range(3):
        assert worker.process(unknown_frame, client.state_payload()) is None
    pause = worker.process(unknown_frame, client.state_payload())

    assert pause is not None
    assert pause["type"] == "pause"
    assert pause["reason"] == "Unknown live contestant: Unknown"
    assert pause["observation"]["active_name"] == "Unknown"
    assert pause["observation"]["metadata"]["overlayVisible"] is True
    assert pause["evidenceImage"].startswith("data:image/jpeg;base64,")
    assert len(pause["evidenceImage"]) <= 250_000
    assert client.paused is True
    assert worker.process(unknown_frame, client.state_payload()) is None
    assert ActionJournal(journal_path).pending() is None

    assert [action["type"] for action in client.applied_actions] == [
        "add_contestant",
        "open_arena",
        "start_arena",
        "record_result",
        "pause",
    ]
    mutation_keys = {
        idempotency_key
        for action, idempotency_key in client.attempts
        if action["type"] != "heartbeat"
    }
    assert len(mutation_keys) == len(client.applied_actions)


def test_empty_queue_does_not_remove_an_unmatched_draft_server_roster(
    tmp_path: Path,
    synthetic_stream: SyntheticStream,
) -> None:
    client = FakeAutomationClient()
    client.contestants = [{"id": CONTESTANT_ID, "displayName": "Hydra", "wins": 0}]
    worker = Worker(
        client=client,
        detector=synthetic_stream.detector,
        journal=ActionJournal(tmp_path / "remove-contestant-journal.json"),
        worker_id="hydramist-test",
    )
    empty_queue = synthetic_stream.frame()

    for _ in range(10):
        assert worker.process(empty_queue, client.state_payload()) is None

    assert client.contestants == [{"id": CONTESTANT_ID, "displayName": "Hydra", "wins": 0}]
    assert ActionJournal(tmp_path / "remove-contestant-journal.json").pending() is None


@pytest.mark.parametrize(
    ("team", "observed_wins", "contestant_won"),
    [
        ("purple", 8, True),
        ("gold", 8, True),
        ("purple", 7, False),
        ("gold", 7, False),
    ],
)
def test_team_color_does_not_determine_the_current_contestant_result(
    tmp_path: Path,
    synthetic_stream: SyntheticStream,
    team: str,
    observed_wins: int,
    contestant_won: bool,
) -> None:
    client = FakeAutomationClient()
    client.seed_locked_arena()
    worker = Worker(
        client=client,
        detector=synthetic_stream.detector,
        journal=ActionJournal(tmp_path / f"{team}-{observed_wins}-journal.json"),
        worker_id="hydramist-test",
        dry_run=True,
    )
    frame = synthetic_stream.frame(
        active_name="Hydra",
        current_wins=observed_wins,
        result_team=team,
    )

    assert worker.process(frame, client.state_payload()) is None
    assert worker.process(frame, client.state_payload()) is None
    action = worker.process(frame, client.state_payload())

    assert action == {
        "type": "record_result",
        "arenaId": AMBIGUOUS_ARENA_ID,
        "contestantWon": contestant_won,
        "eventId": EVENT_ID,
        "workerId": "hydramist-test",
    }


def test_unexpected_result_counter_pauses_instead_of_recording(
    tmp_path: Path,
    synthetic_stream: SyntheticStream,
) -> None:
    client = FakeAutomationClient()
    client.seed_locked_arena(wins=7)
    worker = Worker(
        client=client,
        detector=synthetic_stream.detector,
        journal=ActionJournal(tmp_path / "unexpected-counter-journal.json"),
        worker_id="hydramist-test",
    )
    frame = synthetic_stream.frame(
        active_name="Hydra",
        current_wins=9,
        result_team="gold",
    )

    assert worker.process(frame, client.state_payload()) is None
    assert worker.process(frame, client.state_payload()) is None
    action = worker.process(frame, client.state_payload())

    assert action is not None
    assert action["type"] == "pause"
    assert action["reason"] == "Current player's win counter changed unexpectedly"
    assert action["observation"]["current_wins"] == 9
    assert action["observation"]["metadata"]["resultText"] == "Gold Team Wins"
    assert client.paused is True
    assert [applied["type"] for applied in client.applied_actions] == ["pause"]
