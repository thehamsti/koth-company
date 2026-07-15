from __future__ import annotations

import re
import unicodedata
from collections import Counter, deque
from collections.abc import Iterable
from typing import Generic, TypeVar


T = TypeVar("T")


def normalize_name(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def name_identity(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", normalize_name(value))
    return "".join(
        character for character in normalized if not unicodedata.combining(character)
    ).casefold()


def normalize_roster_name(value: str) -> str:
    value = normalize_name(value)
    compact = value.casefold().replace(" ", "")
    if compact in {"queue", "isclosed", "queueisclosed"}:
        return ""
    if re.fullmatch(r"\d+(?:[.)]\d*)?", value):
        return ""
    return re.sub(r"^\d+[.)]\s*", "", value).strip()


def parse_roster_names(values: Iterable[str]) -> tuple[str, ...]:
    names: list[str] = []
    expected_rank = 1
    pending_rank: int | None = None
    for value in values:
        value = normalize_name(value)
        combined = re.fullmatch(r"(\d+)[.)]\s*(.+)", value)
        if combined:
            rank = int(combined.group(1))
            if rank != expected_rank:
                break
            name = normalize_roster_name(combined.group(2))
            if not name:
                break
            names.append(name)
            expected_rank += 1
            pending_rank = None
            continue
        rank_only = re.fullmatch(r"(\d+)[.)]?", value)
        if rank_only:
            rank = int(rank_only.group(1))
            if rank != expected_rank:
                break
            pending_rank = rank
        elif pending_rank == expected_rank:
            name = normalize_roster_name(value)
            if name:
                names.append(name)
                expected_rank += 1
            pending_rank = None
    return tuple(names)


class StableVote(Generic[T]):
    def __init__(self, *, window: int, minimum: int) -> None:
        self.values: deque[T | None] = deque(maxlen=window)
        self.minimum = minimum

    def push(self, value: T | None) -> T | None:
        self.values.append(value)
        counts = Counter(item for item in self.values if item is not None)
        if not counts:
            return None
        winner, count = counts.most_common(1)[0]
        return winner if count >= self.minimum else None

    def reset(self) -> None:
        self.values.clear()


class ConsecutiveValue(Generic[T]):
    def __init__(self, minimum: int) -> None:
        self.minimum = minimum
        self.value: T | None = None
        self.count = 0

    def push(self, value: T | None) -> T | None:
        if value is None:
            self.value = None
            self.count = 0
            return None
        if value == self.value:
            self.count += 1
        else:
            self.value = value
            self.count = 1
        return value if self.count >= self.minimum else None

    def reset(self) -> None:
        self.value = None
        self.count = 0
