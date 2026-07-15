import json
from collections.abc import Iterable
from pathlib import Path

import cv2
import numpy as np
import pytest

from koth_cv.replay import ReplayMismatchError, replay_manifest
from koth_cv.state_machine import Observation


EVENT_ID = "00000000-0000-4000-8000-000000000001"
CONTESTANT_ID = "00000000-0000-4000-8000-000000000002"
ARENA_ID = "00000000-0000-4000-8000-000000000003"
NEXT_ARENA_ID = "00000000-0000-4000-8000-000000000004"


class SequenceDetector:
    def __init__(self, observations: Iterable[Observation]) -> None:
        self.observations = iter(observations)

    def detect(self, _frame: np.ndarray) -> Observation:
        return next(self.observations)


def state(
    *,
    status: str,
    wins: int = 0,
    arena_id: str | None = None,
    arena_status: str | None = None,
) -> dict[str, object]:
    return {
        "event": {"id": EVENT_ID, "status": status},
        "contestants": [
            {"id": CONTESTANT_ID, "displayName": "Hydra", "wins": wins},
        ],
        "activeArena": (
            {
                "id": arena_id,
                "status": arena_status,
                "contestantId": CONTESTANT_ID,
            }
            if arena_id and arena_status
            else None
        ),
    }


def action(action_type: str, **values: object) -> dict[str, object]:
    return {
        "type": action_type,
        **values,
        "eventId": EVENT_ID,
        "workerId": "replay",
    }


def write_manifest(tmp_path: Path, steps: list[dict[str, object]]) -> Path:
    frame = np.zeros((10, 10, 3), dtype=np.uint8)
    assert cv2.imwrite(str(tmp_path / "frame.jpg"), frame)
    path = tmp_path / "replay.json"
    path.write_text(json.dumps({"steps": steps}))
    return path


def test_replay_asserts_an_accelerated_win_then_loss_lifecycle(tmp_path: Path) -> None:
    draft = state(status="draft")
    live = state(status="live")
    open_first = state(status="live", arena_id=ARENA_ID, arena_status="open")
    locked_first = state(status="live", arena_id=ARENA_ID, arena_status="locked")
    open_second = state(
        status="live",
        wins=1,
        arena_id=NEXT_ARENA_ID,
        arena_status="open",
    )
    locked_second = state(
        status="live",
        wins=1,
        arena_id=NEXT_ARENA_ID,
        arena_status="locked",
    )
    steps = [
        {
            "label": "draft roster",
            "frame": "frame.jpg",
            "repeat": 3,
            "state": draft,
            "expectedActions": [
                None,
                None,
                action("add_contestant", displayName="Newplayer"),
            ],
        },
        {
            "label": "first active contestant",
            "frame": "frame.jpg",
            "repeat": 4,
            "state": live,
            "expectedActions": [
                None,
                None,
                None,
                action("open_arena", contestantId=CONTESTANT_ID),
            ],
        },
        {
            "label": "first start",
            "frame": "frame.jpg",
            "repeat": 3,
            "state": open_first,
            "expectedActions": [
                None,
                None,
                action("start_arena", arenaId=ARENA_ID),
            ],
        },
        {
            "label": "win result",
            "frame": "frame.jpg",
            "repeat": 3,
            "state": locked_first,
            "expectedActions": [
                None,
                None,
                action("record_result", arenaId=ARENA_ID, contestantWon=True),
            ],
        },
        {
            "label": "second start",
            "frame": "frame.jpg",
            "repeat": 3,
            "state": open_second,
            "expectedActions": [
                None,
                None,
                action("start_arena", arenaId=NEXT_ARENA_ID),
            ],
        },
        {
            "label": "loss result",
            "frame": "frame.jpg",
            "repeat": 3,
            "state": locked_second,
            "expectedActions": [
                None,
                None,
                action("record_result", arenaId=NEXT_ARENA_ID, contestantWon=False),
            ],
        },
    ]
    observations = [
        *[Observation(roster=("Newplayer",)) for _ in range(3)],
        *[Observation(active_name="Hydra") for _ in range(4)],
        *[Observation(arena_active=True) for _ in range(3)],
        *[
            Observation(
                active_name="Hydra",
                current_wins=1,
                result_visible=True,
                result_confidence=1,
            )
            for _ in range(3)
        ],
        *[Observation(arena_active=True) for _ in range(3)],
        *[
            Observation(
                active_name="Hydra",
                current_wins=1,
                result_visible=True,
                result_confidence=1,
            )
            for _ in range(3)
        ],
    ]

    results = replay_manifest(write_manifest(tmp_path, steps), SequenceDetector(observations))

    actions = [result["action"] for result in results if result["action"]]
    assert [entry["type"] for entry in actions] == [
        "add_contestant",
        "open_arena",
        "start_arena",
        "record_result",
        "start_arena",
        "record_result",
    ]
    results_only = [entry for entry in actions if entry["type"] == "record_result"]
    assert results_only[0]["contestantWon"] is True
    assert results_only[1]["contestantWon"] is False


def test_replay_fails_on_the_first_action_mismatch(tmp_path: Path) -> None:
    manifest = write_manifest(
        tmp_path,
        [
            {
                "label": "wrong expectation",
                "frame": "frame.jpg",
                "state": state(status="live"),
                "expectedActions": [action("pause", reason="unexpected")],
            }
        ],
    )

    with pytest.raises(ReplayMismatchError, match="wrong expectation iteration 1"):
        replay_manifest(manifest, SequenceDetector([Observation()]))
