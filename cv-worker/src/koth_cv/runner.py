from __future__ import annotations

import base64
import logging
import uuid
from dataclasses import asdict
from typing import Any, Protocol

import cv2
import numpy as np

from .journal import ActionJournal
from .detection import name_identity
from .state_machine import DecisionEngine, Observation, ServerSnapshot


class ActionClient(Protocol):
    def action(self, action: dict[str, Any], idempotency_key: str) -> dict[str, Any]: ...


class Detector(Protocol):
    def detect(self, frame: np.ndarray) -> Observation: ...


class RetryableWorkerError(RuntimeError):
    pass


class PendingActionConflictError(RuntimeError):
    pass


logger = logging.getLogger(__name__)


def automation_ready(status: str, *, dry_run: bool) -> bool:
    return dry_run or status == "running"


def snapshot_from_payload(payload: dict[str, Any]) -> ServerSnapshot:
    event = payload.get("event")
    if not isinstance(event, dict):
        raise ValueError("No KOTH event is available")
    active_arena = payload.get("activeArena")
    contestants = payload.get("contestants", [])
    contestants_by_id = {str(item["id"]): item for item in contestants}
    available_contestants = [
        item for item in contestants if item.get("status") in {None, "queued", "active"}
    ]
    unavailable_names = frozenset(
        name_identity(str(item["displayName"]))
        for item in contestants
        if item.get("status") not in {None, "queued", "active"}
    )
    arena_contestant = (
        contestants_by_id.get(str(active_arena.get("contestantId"))) if active_arena else None
    )
    return ServerSnapshot(
        event_id=str(event["id"]),
        event_status=str(event["status"]),
        contestants={str(item["displayName"]): str(item["id"]) for item in available_contestants},
        arena_id=str(active_arena["id"]) if active_arena else None,
        arena_status=str(active_arena["status"]) if active_arena else None,
        arena_contestant_name=(str(arena_contestant["displayName"]) if arena_contestant else None),
        arena_contestant_wins=(int(arena_contestant["wins"]) if arena_contestant else None),
        unavailable_contestant_names=unavailable_names,
    )


def evidence_data_url(frame: np.ndarray) -> str:
    preview = cv2.resize(frame, (960, 540))
    ok, encoded = cv2.imencode(".jpg", preview, [cv2.IMWRITE_JPEG_QUALITY, 55])
    if not ok:
        raise RuntimeError("Could not encode automation evidence")
    value = base64.b64encode(encoded).decode()
    if len(value) > 240_000:
        preview = cv2.resize(frame, (640, 360))
        ok, encoded = cv2.imencode(".jpg", preview, [cv2.IMWRITE_JPEG_QUALITY, 45])
        if not ok:
            raise RuntimeError("Could not encode automation evidence")
        value = base64.b64encode(encoded).decode()
    return f"data:image/jpeg;base64,{value}"


class Worker:
    def __init__(
        self,
        *,
        client: ActionClient,
        detector: Detector,
        journal: ActionJournal,
        worker_id: str,
        dry_run: bool = False,
    ) -> None:
        self.client = client
        self.detector = detector
        self.journal = journal
        self.worker_id = worker_id
        self.dry_run = dry_run
        self.engine = DecisionEngine()
        self.last_observation: Observation | None = None

    def heartbeat_observation(self) -> dict[str, Any]:
        observation = self.last_observation
        if observation is None:
            return {"stream": "connected"}
        return {
            "stream": "connected",
            "roster": list(observation.roster),
            "activeName": observation.active_name,
            "currentWins": observation.current_wins,
            "arenaActive": observation.arena_active,
            "resultVisible": observation.result_visible,
            **observation.metadata,
        }

    def recover_pending(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        pending = self.journal.pending()
        if not pending:
            return None
        pending_event_id = pending.action.get("eventId")
        event = payload.get("event")
        current_event_id = event.get("id") if isinstance(event, dict) else None
        action_type = pending.action.get("type", "unknown")
        if not isinstance(pending_event_id, str):
            raise PendingActionConflictError(
                f"Pending {action_type} action has no eventId; journal retained at "
                f"{self.journal.path} for inspection"
            )
        if current_event_id != pending_event_id:
            current = str(current_event_id) if current_event_id else "no current event"
            archived = self.journal.archive()
            logger.warning(
                "Archived obsolete pending %s action for event %s because the server reports %s: %s",
                action_type,
                pending_event_id,
                current,
                archived,
            )
            return None
        recovery_action = {**pending.action, "workerId": self.worker_id}
        try:
            self.client.action(recovery_action, pending.idempotency_key)
        except Exception as exc:
            raise RetryableWorkerError(
                f"pending {action_type} action delivery failed: {exc}"
            ) from exc
        self.journal.acknowledge(pending.idempotency_key)
        return recovery_action

    def process(self, frame: np.ndarray, payload: dict[str, Any]) -> dict[str, Any] | None:
        try:
            snapshot = snapshot_from_payload(payload)
        except (KeyError, TypeError, ValueError) as exc:
            raise RetryableWorkerError(f"automation state could not be processed: {exc}") from exc
        try:
            observation = self.detector.detect(frame)
            self.last_observation = observation
        except Exception as exc:
            raise RetryableWorkerError(f"vision detection failed: {exc}") from exc
        decision = self.engine.observe(observation, snapshot)
        if not decision:
            return None
        action = {
            **decision,
            "eventId": snapshot.event_id,
            "workerId": self.worker_id,
        }
        if decision["type"] == "pause":
            action["observation"] = asdict(observation)
            try:
                action["evidenceImage"] = evidence_data_url(frame)
            except Exception as exc:
                raise RetryableWorkerError(f"pause evidence encoding failed: {exc}") from exc
        if self.dry_run:
            return action
        pending = self.journal.stage(action)
        try:
            if decision["type"] != "pause":
                self.client.action(
                    {
                        "type": "heartbeat",
                        "eventId": snapshot.event_id,
                        "workerId": self.worker_id,
                        "observation": self.heartbeat_observation(),
                    },
                    str(uuid.uuid4()),
                )
            self.client.action(pending.action, pending.idempotency_key)
        except Exception as exc:
            raise RetryableWorkerError(f"{decision['type']} action delivery failed: {exc}") from exc
        self.journal.acknowledge(pending.idempotency_key)
        return action
