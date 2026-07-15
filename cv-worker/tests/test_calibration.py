from pathlib import Path

import numpy as np

from koth_cv.calibration import CalibrationStore, autocalibrate_regions
from koth_cv.config import Region, load_layout


def test_calibration_saves_an_ocr_region_without_a_pixel_template(tmp_path: Path) -> None:
    path = tmp_path / "layout.yaml"
    store = CalibrationStore(path)

    store.save("start", Region(x=0.5, y=0.5, width=0.25, height=0.25))

    layout = load_layout(path)
    assert layout.regions["start"].x == 0.5
    assert layout.templates == {}


class StubBoxOcr:
    def __init__(self, detections: list[tuple[str, float, tuple[int, int, int, int]]]) -> None:
        self.detections = detections

    def read(self, _image: np.ndarray) -> list[tuple[str, float]]:
        return [(text, score) for text, score, _ in self.detections]

    def read_with_boxes(
        self, _image: np.ndarray
    ) -> list[tuple[str, float, tuple[int, int, int, int]]]:
        return self.detections


def _box(
    text: str, score: float, x: int, y: int, w: int, h: int
) -> tuple[str, float, tuple[int, int, int, int]]:
    return (text, score, (x, y, w, h))


def test_autocalibrate_detects_roster_and_current_player_fields_from_anchors() -> None:
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    ocr = StubBoxOcr(
        [
            _box("Leaderboard:", 0.99, 1400, 50, 300, 40),
            _box("Current player:", 0.99, 1400, 100, 240, 35),
            _box("Hydramist", 0.95, 1450, 140, 200, 40),
            _box("Wins: 7", 0.98, 1660, 140, 100, 40),
            _box("Queue:", 0.98, 1400, 200, 200, 40),
            _box("PlayerOne", 0.93, 1450, 260, 180, 35),
            _box("PlayerTwo", 0.91, 1450, 310, 180, 35),
            _box("PlayerThree", 0.90, 1450, 360, 180, 35),
            _box("Queue", 0.99, 1450, 410, 100, 35),
            _box("is closed", 0.99, 1560, 410, 100, 35),
            _box("Damage Done", 0.99, 1450, 900, 180, 35),
        ]
    )
    regions = autocalibrate_regions(frame, ocr)
    assert "roster" in regions
    assert "active_name" in regions
    assert "current_wins" in regions
    assert "overlay" in regions
    assert "queue_header" in regions
    assert "leaderboard_header" in regions
    roster = regions["roster"]
    active = regions["active_name"]
    current_wins = regions["current_wins"]
    overlay = regions["overlay"]
    assert roster.y > 200 / 1080
    assert roster.y + roster.height == 900 / 1080
    assert active.y >= 120 / 1080
    assert active.y + active.height < 200 / 1080
    assert current_wins.width > active.width
    assert overlay.x < active.x
    assert overlay.y < regions["leaderboard_header"].y
    assert overlay.y + overlay.height == 0.9


def test_autocalibrate_raises_when_queue_header_missing() -> None:
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    ocr = StubBoxOcr([_box("Leaderboard:", 0.99, 1400, 50, 300, 40)])
    try:
        autocalibrate_regions(frame, ocr)
        raise AssertionError("expected RuntimeError")
    except RuntimeError as exc:
        assert "Queue:" in str(exc)


def test_autocalibrate_raises_when_leaderboard_header_missing() -> None:
    frame = np.zeros((1080, 1920, 3), dtype=np.uint8)
    ocr = StubBoxOcr([_box("Queue:", 0.98, 1400, 200, 200, 40)])
    try:
        autocalibrate_regions(frame, ocr)
        raise AssertionError("expected RuntimeError")
    except RuntimeError as exc:
        assert "Leaderboard:" in str(exc)
