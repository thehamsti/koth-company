from __future__ import annotations

import re
from typing import Protocol

import numpy as np
from rapidocr import EngineType, LangDet, LangRec, ModelType, OCRVersion, RapidOCR

from .config import Layout, Region
from .detection import parse_roster_names
from .state_machine import Observation


class OcrReader(Protocol):
    def read(self, image: np.ndarray) -> list[tuple[str, float]]: ...
    def read_with_boxes(
        self, image: np.ndarray
    ) -> list[tuple[str, float, tuple[int, int, int, int]]]: ...


class RapidOcrReader:
    def __init__(self) -> None:
        self.engine = RapidOCR(
            params={
                "Det.engine_type": EngineType.ONNXRUNTIME,
                "Det.lang_type": LangDet.CH,
                "Det.model_type": ModelType.MOBILE,
                "Det.ocr_version": OCRVersion.PPOCRV5,
                "Rec.engine_type": EngineType.ONNXRUNTIME,
                "Rec.lang_type": LangRec.EN,
                "Rec.model_type": ModelType.MOBILE,
                "Rec.ocr_version": OCRVersion.PPOCRV5,
                "Global.log_level": "error",
            }
        )

    def read(self, image: np.ndarray) -> list[tuple[str, float]]:
        result = self.engine(image)
        if result.txts is None or result.scores is None:
            return []
        return list(zip(result.txts, result.scores, strict=True))

    def read_with_boxes(
        self, image: np.ndarray
    ) -> list[tuple[str, float, tuple[int, int, int, int]]]:
        result = self.engine(image)
        if result.txts is None or result.scores is None or result.boxes is None:
            return []
        detections: list[tuple[str, float, tuple[int, int, int, int]]] = []
        for text, score, box in zip(result.txts, result.scores, result.boxes, strict=True):
            xs = box[:, 0]
            ys = box[:, 1]
            x = int(xs.min())
            y = int(ys.min())
            w = int(xs.max() - xs.min())
            h = int(ys.max() - ys.min())
            detections.append((text, score, (x, y, w, h)))
        return detections


def crop(frame: np.ndarray, region: Region) -> np.ndarray:
    height, width = frame.shape[:2]
    x, y, crop_width, crop_height = region.pixels(width, height)
    return frame[y : y + crop_height, x : x + crop_width]


class VisionDetector:
    def __init__(self, layout: Layout, ocr: OcrReader | None = None) -> None:
        self.layout = layout
        self.ocr = ocr or RapidOcrReader()

    def _ocr(self, frame: np.ndarray, region_name: str) -> list[tuple[str, float]]:
        region = self.layout.regions.get(region_name)
        if not region:
            return []
        return [(text, score) for text, score in self.ocr.read(crop(frame, region)) if score >= 0.8]

    @staticmethod
    def _win_count(values: list[str]) -> int | None:
        combined = " ".join(values)
        match = re.search(r"\bwins?\D{0,3}(\d{1,3})\b", combined, re.IGNORECASE)
        if match:
            return int(match.group(1))
        if len(values) == 1 and re.fullmatch(r"\s*\d{1,3}\s*", values[0]):
            return int(values[0])
        return None

    def _overlay(self, frame: np.ndarray) -> tuple[tuple[str, ...], str | None, int | None] | None:
        region = self.layout.regions.get("overlay")
        if not region:
            return None
        image = crop(frame, region)
        detections = [
            (text, box) for text, score, box in self.ocr.read_with_boxes(image) if score >= 0.8
        ]

        def normalized(text: str) -> str:
            return re.sub(r"[^a-z0-9]", "", text.casefold())

        def anchor(name: str) -> tuple[int, int, int, int] | None:
            return next((box for text, box in detections if normalized(text) == name), None)

        def joined_anchor(first: str, second: str) -> tuple[int, int, int, int] | None:
            first_box = anchor(first)
            second_box = anchor(second)
            if not first_box or not second_box:
                return None
            first_center = first_box[1] + first_box[3] / 2
            second_center = second_box[1] + second_box[3] / 2
            if abs(first_center - second_center) > max(first_box[3], second_box[3]):
                return None
            left = min(first_box[0], second_box[0])
            top = min(first_box[1], second_box[1])
            right = max(first_box[0] + first_box[2], second_box[0] + second_box[2])
            bottom = max(first_box[1] + first_box[3], second_box[1] + second_box[3])
            return left, top, right - left, bottom - top

        leaderboard_box = anchor("leaderboard")
        current_player_box = anchor("currentplayer") or joined_anchor("current", "player")
        queue_box = anchor("queue")
        if not queue_box:
            return None

        roster_detections = [
            (text, box)
            for text, box in detections
            if box[1] + box[3] / 2 > queue_box[1] + queue_box[3]
        ]
        vertical_order = sorted(roster_detections, key=lambda item: (item[1][1], item[1][0]))
        gap_threshold = max(queue_box[3] * 2, int(image.shape[0] * 0.05))
        roster_bottom: int | None = None
        for index in range(1, len(vertical_order)):
            previous = vertical_order[index - 1][1]
            current = vertical_order[index][1]
            if current[1] - (previous[1] + previous[3]) > gap_threshold:
                roster_bottom = current[1]
                break
        if roster_bottom is not None:
            roster_detections = [item for item in roster_detections if item[1][1] < roster_bottom]
        roster = parse_roster_names(text for text, _box in roster_detections)

        if not leaderboard_box or not current_player_box:
            return roster, None, None
        if not (leaderboard_box[1] < current_player_box[1] < queue_box[1]):
            return roster, None, None

        active_detections = [
            (text, box)
            for text, box in detections
            if box[1] + box[3] / 2 > current_player_box[1] + current_player_box[3]
            and box[1] + box[3] / 2 < queue_box[1] + queue_box[3] / 2
        ]
        wins_detection = next(
            (
                (text, box)
                for text, box in active_detections
                if re.search(r"wins?\D{0,3}\d{1,3}", text, re.IGNORECASE)
            ),
            None,
        )
        current_wins = self._win_count([text for text, _box in active_detections])
        name_candidates = [
            (text, box)
            for text, box in active_detections
            if "wins" not in normalized(text) and re.search(r"[a-z]", text, re.IGNORECASE)
        ]
        active_name: str | None = None
        if name_candidates:
            if wins_detection:
                _, wins_box = wins_detection
                wins_center = wins_box[1] + wins_box[3] / 2
                active_name = min(
                    name_candidates,
                    key=lambda item: (
                        abs(item[1][1] + item[1][3] / 2 - wins_center),
                        item[1][0],
                    ),
                )[0]
            else:
                active_name = min(name_candidates, key=lambda item: (item[1][1], item[1][0]))[0]
        return roster, active_name, current_wins

    def _result_signal(self, frame: np.ndarray) -> tuple[bool, float, str | None]:
        values = self._ocr(frame, "result")
        text = " ".join(value for value, _score in values)
        normalized = re.sub(r"[^a-z]", "", text.casefold())
        if "teamwins" in normalized:
            return True, max(score for _value, score in values), text
        return False, 0.0, None

    def _start_signal(self, frame: np.ndarray) -> tuple[bool, float, str | None]:
        values = self._ocr(frame, "start")
        text = " ".join(value for value, _score in values)
        normalized = re.sub(r"[^a-z]", "", text.casefold())
        if "shadowsigh" in normalized and "spawns" in normalized:
            return True, max(score for _value, score in values), text
        return False, 0.0, None

    def detect(self, frame: np.ndarray) -> Observation:
        overlay = self._overlay(frame)
        if overlay is None:
            return Observation(metadata={"overlayVisible": False})

        roster, active_name, current_wins = overlay
        start_visible, start_confidence, start_text = self._start_signal(frame)
        result_visible, result_confidence, result_text = self._result_signal(frame)
        metadata: dict[str, object] = {
            "overlayVisible": True,
            "startVisible": start_visible,
            "startConfidence": round(start_confidence, 4),
            "currentWins": current_wins,
            "resultVisible": result_visible,
            "resultConfidence": round(result_confidence, 4),
        }
        if result_text:
            metadata["resultText"] = result_text
        if start_text:
            metadata["startText"] = start_text
        return Observation(
            roster=roster,
            active_name=active_name,
            current_wins=current_wins,
            arena_active=start_visible,
            result_visible=result_visible,
            result_confidence=result_confidence,
            metadata=metadata,
        )
