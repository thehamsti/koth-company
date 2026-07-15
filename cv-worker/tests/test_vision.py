import numpy as np

from koth_cv.config import Layout, Region
from koth_cv.vision import VisionDetector


OVERLAY_MARKER = 99
SHIFTED_OVERLAY_MARKER = 98
QUEUE_ONLY_MARKER = 97
START_MARKER = 30
PURPLE_RESULT_MARKER = 40
GOLD_RESULT_MARKER = 50


class StubOcr:
    def read(self, image: np.ndarray) -> list[tuple[str, float]]:
        return {
            START_MARKER: [("Shadowsight", 0.97), ("spawns in 95 sec", 0.96)],
            PURPLE_RESULT_MARKER: [("Purple Team Wins", 0.97)],
            GOLD_RESULT_MARKER: [("Gold", 0.98), ("Team Wins", 0.96)],
        }.get(int(image[0, 0, 0]), [])

    def read_with_boxes(
        self, image: np.ndarray
    ) -> list[tuple[str, float, tuple[int, int, int, int]]]:
        marker = int(image[0, 0, 0])
        if marker == QUEUE_ONLY_MARKER:
            return [
                ("Queue:", 0.99, (0, 10, 20, 5)),
                ("1. Hydra", 0.96, (0, 16, 20, 5)),
                ("2. Other", 0.96, (0, 22, 20, 5)),
            ]
        if marker not in {OVERLAY_MARKER, SHIFTED_OVERLAY_MARKER}:
            return []
        offset = 15 if marker == SHIFTED_OVERLAY_MARKER else 0
        return [
            ("Leaderboard:", 0.99, (0, 0, 30, 5)),
            ("Current player:", 0.99, (0, 10 + offset, 35, 5)),
            ("Hydra", 0.99, (0, 16 + offset, 15, 5)),
            ("Wins: 8", 0.98, (20, 16 + offset, 15, 5)),
            ("Queue:", 0.99, (0, 25 + offset, 20, 5)),
            ("1. Hydra", 0.96, (0, 31 + offset, 20, 5)),
        ]


def layout() -> Layout:
    return Layout(
        width=100,
        height=100,
        regions={
            "overlay": Region(x=0, y=0, width=0.5, height=0.6),
            "start": Region(x=0.6, y=0.6, width=0.2, height=0.2),
            "result": Region(x=0.6, y=0.3, width=0.2, height=0.2),
        },
    )


def test_detector_combines_dynamic_overlay_and_start_ocr() -> None:
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    frame[0:60, 0:50] = OVERLAY_MARKER
    frame[60:80, 60:80] = START_MARKER

    observation = VisionDetector(layout(), StubOcr()).detect(frame)

    assert observation.roster == ("Hydra",)
    assert observation.active_name == "Hydra"
    assert observation.current_wins == 8
    assert observation.arena_active is True


def test_detector_derives_player_and_queue_after_their_vertical_positions_shift() -> None:
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    frame[0:60, 0:50] = SHIFTED_OVERLAY_MARKER

    observation = VisionDetector(layout(), StubOcr()).detect(frame)

    assert observation.roster == ("Hydra",)
    assert observation.active_name == "Hydra"
    assert observation.current_wins == 8
    assert observation.metadata["overlayVisible"] is True


def test_detector_returns_no_signals_when_dynamic_overlay_anchors_are_missing() -> None:
    frame = np.zeros((100, 100, 3), dtype=np.uint8)

    observation = VisionDetector(layout(), StubOcr()).detect(frame)

    assert observation.roster == ()
    assert observation.active_name is None
    assert observation.arena_active is False
    assert observation.result_visible is False
    assert observation.metadata == {"overlayVisible": False}


def test_detector_reads_a_draft_queue_without_live_player_sections() -> None:
    frame = np.zeros((100, 100, 3), dtype=np.uint8)
    frame[0:60, 0:50] = QUEUE_ONLY_MARKER

    observation = VisionDetector(layout(), StubOcr()).detect(frame)

    assert observation.roster == ("Hydra", "Other")
    assert observation.active_name is None
    assert observation.current_wins is None
    assert observation.metadata["overlayVisible"] is True


def test_detector_exposes_team_neutral_result_and_current_win_counter() -> None:
    for marker, title in (
        (PURPLE_RESULT_MARKER, "Purple Team Wins"),
        (GOLD_RESULT_MARKER, "Gold Team Wins"),
    ):
        frame = np.zeros((100, 100, 3), dtype=np.uint8)
        frame[0:60, 0:50] = OVERLAY_MARKER
        frame[30:50, 60:80] = marker

        observation = VisionDetector(layout(), StubOcr()).detect(frame)

        assert observation.active_name == "Hydra"
        assert observation.current_wins == 8
        assert observation.result_visible is True
        assert observation.result_confidence >= 0.96
        assert observation.metadata["resultText"] == title
