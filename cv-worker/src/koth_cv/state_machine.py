from __future__ import annotations

from collections import Counter, deque
from dataclasses import dataclass, field
from typing import Any

from .detection import ConsecutiveValue, StableVote, name_identity, normalize_name


@dataclass
class _RosterPage:
    names: set[str] = field(default_factory=set)
    display_names: dict[str, str] = field(default_factory=dict)
    name_order: list[str] = field(default_factory=list)
    frames: deque[tuple[str, ...]] = field(default_factory=lambda: deque(maxlen=10))

    def observe(self, names: tuple[str, ...]) -> None:
        normalized_names: list[str] = []
        for name in names:
            normalized = normalize_name(name)
            if not normalized:
                continue
            key = name_identity(normalized)
            normalized_names.append(key)
            if key not in self.names:
                self.names.add(key)
                self.display_names[key] = normalized
                self.name_order.append(key)
        self.frames.append(tuple(normalized_names))

    def forget(self, name: str) -> None:
        self.frames = deque(
            (tuple(observed for observed in frame if observed != name) for frame in self.frames),
            maxlen=10,
        )


@dataclass(frozen=True)
class Observation:
    roster: tuple[str, ...] = ()
    active_name: str | None = None
    current_wins: int | None = None
    arena_active: bool = False
    result_visible: bool = False
    result_confidence: float = 0.0
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ServerSnapshot:
    event_id: str
    event_status: str
    contestants: dict[str, str]
    arena_id: str | None
    arena_status: str | None
    arena_contestant_name: str | None = None
    arena_contestant_wins: int | None = None
    unavailable_contestant_names: frozenset[str] = frozenset()


class DecisionEngine:
    def __init__(self) -> None:
        self.roster_pages: list[_RosterPage] = []
        self.active_name = StableVote[str](window=6, minimum=4)
        self.active_labels: dict[str, str] = {}
        self.arena_active = ConsecutiveValue[bool](3)
        self.result = ConsecutiveValue[bool](3)
        self.result_issue = ConsecutiveValue[str](3)
        self.last_server_state: tuple[str, str | None, str | None] | None = None
        self.draft_server_names: set[str] | None = None
        self.emitted_for_state: set[str] = set()

    def observe(self, observation: Observation, snapshot: ServerSnapshot) -> dict[str, Any] | None:
        server_state = (
            snapshot.event_status,
            snapshot.arena_id,
            snapshot.arena_status,
        )
        if server_state != self.last_server_state:
            self.emitted_for_state.clear()
            self.roster_pages.clear()
            self.active_name.reset()
            self.active_labels.clear()
            self.arena_active.reset()
            self.result.reset()
            self.result_issue.reset()
            self.draft_server_names = None
            self.last_server_state = server_state

        if observation.metadata.get("overlayVisible") is False:
            self.roster_pages.clear()
            self.active_name.reset()
            self.active_labels.clear()
            self.arena_active.reset()
            self.result.reset()
            self.result_issue.reset()
            self.draft_server_names = None
            return None

        if snapshot.event_status == "draft":
            existing = {name_identity(name) for name in snapshot.contestants}
            if self.draft_server_names is not None:
                for removed_name in self.draft_server_names - existing:
                    for page in self.roster_pages:
                        page.forget(removed_name)
            self.draft_server_names = existing
            for name in existing:
                self.emitted_for_state.discard(f"roster:{name}")

            observed_names = tuple(
                normalized for name in observation.roster if (normalized := normalize_name(name))
            )
            observed_keys = {name_identity(name) for name in observed_names}
            if not observed_keys:
                return None

            matches = [
                (len(observed_keys & page.names), page)
                for page in self.roster_pages
                if observed_keys & page.names
            ]
            if matches:
                best_overlap = max(overlap for overlap, _page in matches)
                best_pages = [page for overlap, page in matches if overlap == best_overlap]
                if len(best_pages) != 1:
                    return None
                page = best_pages[0]
            else:
                page = _RosterPage()
                self.roster_pages.append(page)

            page.observe(observed_names)
            counts = Counter(name for frame in page.frames for name in frame)
            for name in page.name_order:
                fingerprint = f"roster:{name}"
                if (
                    counts[name] >= 3
                    and name not in existing
                    and fingerprint not in self.emitted_for_state
                ):
                    self.emitted_for_state.add(fingerprint)
                    return {
                        "type": "add_contestant",
                        "displayName": page.display_names[name],
                    }
            if len(page.frames) == page.frames.maxlen:
                for display_name, contestant_id in snapshot.contestants.items():
                    normalized = normalize_name(display_name)
                    identity = name_identity(normalized)
                    fingerprint = f"remove-roster:{contestant_id}"
                    later_names = (
                        set(page.name_order[page.name_order.index(identity) + 1 :])
                        if identity in page.names
                        else set()
                    )
                    if (
                        normalized
                        and identity in page.names
                        and counts[identity] == 0
                        and later_names
                        and all(later_names.intersection(frame) for frame in page.frames)
                        and fingerprint not in self.emitted_for_state
                    ):
                        self.emitted_for_state.add(fingerprint)
                        page.forget(identity)
                        return {"type": "remove_contestant", "contestantId": contestant_id}

            observed_active = normalize_name(observation.active_name or "")
            observed_active_identity = name_identity(observed_active) if observed_active else None
            stable_active = self.active_name.push(observed_active_identity)
            roster_is_synced = (
                len(existing) >= 2 and bool(observed_keys) and observed_keys.issubset(existing)
            )
            if (
                stable_active
                and stable_active in existing
                and roster_is_synced
                and "activate-event" not in self.emitted_for_state
            ):
                self.emitted_for_state.add("activate-event")
                return {"type": "activate_event"}
            return None

        if snapshot.event_status != "live":
            return None

        pause_reason = observation.metadata.get("pauseReason")
        if isinstance(pause_reason, str) and "ambiguous" not in self.emitted_for_state:
            self.emitted_for_state.add("ambiguous")
            return {"type": "pause", "reason": pause_reason}

        if snapshot.arena_status is None:
            observed_name = normalize_name(observation.active_name or "")
            observed_identity = name_identity(observed_name) if observed_name else None
            if observed_identity and observed_identity not in self.active_labels:
                self.active_labels[observed_identity] = observed_name
            stable_identity = self.active_name.push(observed_identity)
            if not stable_identity:
                return None
            stable_name = self.active_labels[stable_identity]
            contestant_id = next(
                (
                    contestant_id
                    for name, contestant_id in snapshot.contestants.items()
                    if name_identity(name) == stable_identity
                ),
                None,
            )
            fingerprint = f"active:{stable_identity}"
            if fingerprint in self.emitted_for_state:
                return None
            self.emitted_for_state.add(fingerprint)
            if not contestant_id:
                if stable_identity in snapshot.unavailable_contestant_names:
                    return None
                return {
                    "type": "pause",
                    "reason": f"Unknown live contestant: {stable_name}",
                }
            action: dict[str, Any] = {"type": "open_arena", "contestantId": contestant_id}
            if observation.current_wins is not None:
                action["baselineWins"] = observation.current_wins
            return action

        if snapshot.arena_status == "open":
            active = self.arena_active.push(observation.arena_active or None)
            if active and "start" not in self.emitted_for_state:
                self.emitted_for_state.add("start")
                return {"type": "start_arena", "arenaId": snapshot.arena_id}
            return None

        if snapshot.arena_status == "locked":
            if not observation.result_visible or observation.result_confidence < 0.90:
                self.result.reset()
                self.result_issue.reset()
                return None

            expected_name = normalize_name(snapshot.arena_contestant_name or "")
            observed_name = normalize_name(observation.active_name or "")
            issue: str | None = None
            qualified: bool | None = None
            if not expected_name or snapshot.arena_contestant_wins is None:
                issue = "Active arena is missing its contestant win baseline"
            elif not observed_name:
                issue = "Could not read the current player at arena result"
            elif name_identity(observed_name) != name_identity(expected_name):
                issue = "Current player does not match the active arena contestant"
            elif observation.current_wins is None:
                issue = "Could not read the current player's win counter at arena result"
            else:
                wins_delta = observation.current_wins - snapshot.arena_contestant_wins
                if wins_delta in {0, 1}:
                    qualified = wins_delta == 1
                else:
                    issue = "Current player's win counter changed unexpectedly"

            stable_issue = self.result_issue.push(issue)
            if stable_issue and "result-issue" not in self.emitted_for_state:
                self.emitted_for_state.add("result-issue")
                return {"type": "pause", "reason": stable_issue}
            result = self.result.push(qualified)
            if result is not None and "result" not in self.emitted_for_state:
                self.emitted_for_state.add("result")
                return {
                    "type": "record_result",
                    "arenaId": snapshot.arena_id,
                    "contestantWon": result,
                }
        return None
