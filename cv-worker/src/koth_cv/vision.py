from __future__ import annotations

import re
from typing import Protocol

import numpy as np
from rapidocr import EngineType, LangDet, LangRec, ModelType, OCRVersion, RapidOCR

from .config import Layout, Region
from .detection import name_identity, normalize_roster_name
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
                "EngineConfig.onnxruntime.intra_op_num_threads": 2,
                "EngineConfig.onnxruntime.inter_op_num_threads": 1,
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

    @staticmethod
    def _positioned_roster(
        detections: list[tuple[str, tuple[int, int, int, int]]],
    ) -> tuple[str, ...]:
        combined_names: dict[int, str] = {}
        rank_boxes: dict[int, tuple[int, int, int, int]] = {}
        candidates: list[tuple[str, tuple[int, int, int, int]]] = []
        for text, box in detections:
            value = re.sub(r"\s+", " ", text).strip()
            combined = re.fullmatch(r"(\d+)[.)]\s*(.+)", value)
            if combined:
                name = normalize_roster_name(combined.group(2))
                if name:
                    combined_names.setdefault(int(combined.group(1)), name)
                continue
            rank_only = re.fullmatch(r"(\d+)[.)]?", value)
            if rank_only:
                rank = int(rank_only.group(1))
                previous = rank_boxes.get(rank)
                if previous is None or box[0] < previous[0]:
                    rank_boxes[rank] = box
                continue
            name = normalize_roster_name(value)
            if name and re.search(r"[a-z]", name, re.IGNORECASE):
                candidates.append((name, box))

        if not rank_boxes:
            names: list[str] = []
            expected_rank = 1
            while name := combined_names.get(expected_rank):
                names.append(name)
                expected_rank += 1
            return tuple(names)
        known_centers = {rank: box[1] + box[3] / 2 for rank, box in rank_boxes.items()}
        ordered_ranks = sorted(known_centers)
        steps = [
            (known_centers[right] - known_centers[left]) / (right - left)
            for left, right in zip(ordered_ranks, ordered_ranks[1:])
            if right > left and known_centers[right] > known_centers[left]
        ]
        row_step = float(np.median(steps)) if steps else 1.0
        rank_left = float(np.median([box[0] for box in rank_boxes.values()]))
        rank_width = float(np.median([box[2] for box in rank_boxes.values()]))
        rank_height = float(np.median([box[3] for box in rank_boxes.values()]))

        def inferred_rank_box(rank: int) -> tuple[float, float, float, float]:
            lower = max((value for value in ordered_ranks if value < rank), default=None)
            upper = min((value for value in ordered_ranks if value > rank), default=None)
            if lower is not None and upper is not None:
                fraction = (rank - lower) / (upper - lower)
                center = known_centers[lower] + fraction * (
                    known_centers[upper] - known_centers[lower]
                )
            elif lower is not None:
                center = known_centers[lower] + row_step * (rank - lower)
            elif upper is not None:
                center = known_centers[upper] - row_step * (upper - rank)
            else:
                center = 0.0
            return rank_left, center - rank_height / 2, rank_width, rank_height

        names: list[str] = []
        used_candidates: set[int] = set()
        expected_rank = 1
        last_rank = max((*rank_boxes.keys(), *combined_names.keys()))
        while expected_rank <= last_rank:
            combined_name = combined_names.get(expected_rank)
            if combined_name:
                names.append(combined_name)
                expected_rank += 1
                continue
            rank_box = rank_boxes.get(expected_rank) or inferred_rank_box(expected_rank)
            rank_center = rank_box[1] + rank_box[3] / 2
            matches = [
                (index, name, box)
                for index, (name, box) in enumerate(candidates)
                if index not in used_candidates
                and box[0] > rank_box[0] + rank_box[2] / 2
                and abs(box[1] + box[3] / 2 - rank_center) <= max(rank_box[3], box[3]) / 2
            ]
            if not matches:
                break
            index, name, _box = min(
                matches,
                key=lambda item: (
                    abs(item[2][1] + item[2][3] / 2 - rank_center),
                    item[2][0],
                ),
            )
            used_candidates.add(index)
            names.append(name)
            expected_rank += 1
        return tuple(names)

    def _overlay(
        self, frame: np.ndarray
    ) -> tuple[tuple[str, ...], tuple[str, ...], str | None, int | None, dict[str, object]] | None:
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

        prize_box = anchor("prize")
        leaderboard_box = anchor("leaderboard")
        current_player_box = anchor("currentplayer") or joined_anchor("current", "player")
        queue_box = anchor("queue")
        if not queue_box:
            return None

        overlay_metadata: dict[str, object] = {
            "zones": {
                "prize": prize_box is not None,
                "leaderboard": leaderboard_box is not None,
                "currentPlayer": current_player_box is not None,
                "queue": True,
            }
        }
        if prize_box and leaderboard_box:
            prize_values = [
                text
                for text, box in detections
                if box[1] + box[3] / 2 > prize_box[1] and box[1] + box[3] / 2 < leaderboard_box[1]
            ]
            prize_match = re.search(r"\$\s*([\d,]+)", " ".join(prize_values))
            if prize_match:
                overlay_metadata["prizeValue"] = int(prize_match.group(1).replace(",", ""))

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
        roster = self._positioned_roster(roster_detections)

        if not leaderboard_box or not current_player_box:
            return roster, roster, None, None, overlay_metadata

        leaderboard_detections = [
            (text, box)
            for text, box in detections
            if box[1] + box[3] / 2 > leaderboard_box[1] + leaderboard_box[3]
            and box[1] + box[3] / 2 < current_player_box[1]
        ]
        rows: list[list[tuple[str, tuple[int, int, int, int]]]] = []
        for item in sorted(leaderboard_detections, key=lambda entry: (entry[1][1], entry[1][0])):
            center = item[1][1] + item[1][3] / 2
            if not rows:
                rows.append([item])
                continue
            previous_centers = [box[1] + box[3] / 2 for _text, box in rows[-1]]
            tolerance = max(item[1][3], *(box[3] for _text, box in rows[-1]))
            if abs(center - sum(previous_centers) / len(previous_centers)) <= tolerance / 2:
                rows[-1].append(item)
            else:
                rows.append([item])
        leaderboard: list[dict[str, object]] = []
        for row in rows:
            values = [text for text, _box in sorted(row, key=lambda item: item[1][0])]
            wins = self._win_count(values)
            names = [
                text
                for text in values
                if "wins" not in normalized(text) and re.search(r"[a-z]", text, re.IGNORECASE)
            ]
            if names and wins is not None:
                leaderboard.append({"name": names[0], "wins": wins})
        overlay_metadata["leaderboard"] = leaderboard

        if not (leaderboard_box[1] < current_player_box[1] < queue_box[1]):
            return roster, roster, None, None, overlay_metadata

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
        leaderboard_wins = {
            name_identity(str(entry["name"])): int(entry["wins"]) for entry in leaderboard
        }
        role_entries: list[dict[str, object]] = []
        role_identities: set[str] = set()
        for queue_name in roster:
            identity = name_identity(queue_name)
            role_identities.add(identity)
            role_entries.append(
                {
                    "name": queue_name,
                    "status": "queued",
                    "wins": leaderboard_wins.get(identity, 0),
                    "queuePosition": len(role_entries) + 1,
                }
            )
        if active_name and name_identity(active_name) not in role_identities:
            role_identities.add(name_identity(active_name))
            role_entries.append(
                {
                    "name": active_name,
                    "status": "active",
                    "wins": current_wins or 0,
                    "queuePosition": len(role_entries) + 1,
                }
            )
        for entry in leaderboard:
            leaderboard_name = str(entry["name"])
            identity = name_identity(leaderboard_name)
            if identity in role_identities:
                continue
            role_identities.add(identity)
            role_entries.append(
                {
                    "name": leaderboard_name,
                    "status": "eliminated",
                    "wins": int(entry["wins"]),
                    "queuePosition": len(role_entries) + 1,
                }
            )
        overlay_metadata["participantStates"] = role_entries

        participants = [
            *(str(entry["name"]) for entry in leaderboard),
            *([active_name] if active_name else []),
            *roster,
        ]
        unique_participants: list[str] = []
        seen_participants: set[str] = set()
        for participant in participants:
            identity = name_identity(participant)
            if identity and identity not in seen_participants:
                seen_participants.add(identity)
                unique_participants.append(participant)
        return tuple(unique_participants), roster, active_name, current_wins, overlay_metadata

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
        countdown_visible = "shadowsigh" in normalized and "spawns" in normalized
        team_counter_visible = (
            "purpleteam" in normalized
            and "goldteam" in normalized
            and normalized.count("playersremaining") >= 2
        )
        if countdown_visible or team_counter_visible:
            return True, max(score for _value, score in values), text
        return False, 0.0, None

    def detect(self, frame: np.ndarray) -> Observation:
        overlay = self._overlay(frame)
        if overlay is None:
            return Observation(metadata={"overlayVisible": False})

        roster, queue, active_name, current_wins, overlay_metadata = overlay
        start_visible, start_confidence, start_text = self._start_signal(frame)
        result_visible, result_confidence, result_text = self._result_signal(frame)
        metadata: dict[str, object] = {
            **overlay_metadata,
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
            queue=queue,
            active_name=active_name,
            current_wins=current_wins,
            arena_active=start_visible,
            result_visible=result_visible,
            result_confidence=result_confidence,
            metadata=metadata,
        )
