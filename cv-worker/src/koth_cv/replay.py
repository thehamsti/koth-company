from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Any, Protocol

import cv2
import numpy as np
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .runner import snapshot_from_payload
from .state_machine import DecisionEngine, Observation


class ReplayDetector(Protocol):
    def detect(self, frame: np.ndarray) -> Observation: ...


class ReplayStep(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    label: str | None = None
    frame: str = Field(min_length=1)
    repeat: int = Field(default=1, ge=1, le=1_000)
    state: dict[str, Any]
    expected_actions: list[dict[str, Any] | None] | None = Field(
        default=None,
        alias="expectedActions",
    )

    @model_validator(mode="after")
    def expected_actions_match_repeat(self) -> "ReplayStep":
        if self.expected_actions is not None and len(self.expected_actions) != self.repeat:
            raise ValueError("expectedActions must contain one entry per repeated frame")
        return self


class ReplayManifest(BaseModel):
    steps: list[ReplayStep] = Field(min_length=1)


class ReplayMismatchError(RuntimeError):
    pass


def load_replay_manifest(path: Path) -> ReplayManifest:
    return ReplayManifest.model_validate_json(path.read_text())


def replay_manifest(
    path: Path,
    detector: ReplayDetector,
    *,
    worker_id: str = "replay",
) -> list[dict[str, Any]]:
    manifest = load_replay_manifest(path)
    engine = DecisionEngine()
    output: list[dict[str, Any]] = []
    index = 0

    for step in manifest.steps:
        frame_path = (path.parent / step.frame).resolve()
        frame = cv2.imread(str(frame_path))
        if frame is None:
            raise ValueError(f"Replay frame is unreadable: {frame_path}")
        snapshot = snapshot_from_payload(step.state)

        for iteration in range(step.repeat):
            observation = detector.detect(frame)
            decision = engine.observe(observation, snapshot)
            action = (
                {**decision, "eventId": snapshot.event_id, "workerId": worker_id}
                if decision
                else None
            )
            if step.expected_actions is not None:
                expected = step.expected_actions[iteration]
                if action != expected:
                    label = step.label or step.frame
                    raise ReplayMismatchError(
                        f"Replay mismatch at {label} iteration {iteration + 1}: "
                        f"expected {expected!r}, got {action!r}"
                    )
            output.append(
                {
                    "index": index,
                    "label": step.label,
                    "frame": str(frame_path),
                    "iteration": iteration + 1,
                    "observation": asdict(observation),
                    "action": action,
                }
            )
            index += 1

    return output
