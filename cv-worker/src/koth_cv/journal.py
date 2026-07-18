from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class PendingAction:
    idempotency_key: str
    action: dict[str, Any]


class ActionJournal:
    def __init__(self, path: Path) -> None:
        self.path = path

    def stage(self, action: dict[str, Any]) -> PendingAction:
        current = self.pending()
        if current:
            return current
        pending = PendingAction(idempotency_key=str(uuid.uuid4()), action=action)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4()}.tmp")
        try:
            temporary.write_text(json.dumps(asdict(pending), separators=(",", ":")))
            temporary.replace(self.path)
        finally:
            temporary.unlink(missing_ok=True)
        return pending

    def pending(self) -> PendingAction | None:
        if not self.path.exists():
            return None
        try:
            value = json.loads(self.path.read_text())
            if not isinstance(value, dict):
                raise TypeError
            idempotency_key = value["idempotency_key"]
            action = value["action"]
            if not isinstance(idempotency_key, str) or not isinstance(action, dict):
                raise TypeError
            return PendingAction(idempotency_key=idempotency_key, action=action)
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            raise RuntimeError(
                f"Corrupt action journal at {self.path}. Move it aside for inspection, or delete it "
                "only after verifying whether the pending action reached the server."
            ) from exc

    def archive(self) -> Path | None:
        if not self.path.exists():
            return None
        archived = self.path.with_name(
            f"{self.path.stem}.stale-{uuid.uuid4()}{self.path.suffix}"
        )
        self.path.replace(archived)
        return archived

    def acknowledge(self, idempotency_key: str) -> None:
        current = self.pending()
        if current and current.idempotency_key == idempotency_key:
            self.path.unlink()
