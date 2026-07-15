from pathlib import Path

import pytest

from koth_cv.journal import ActionJournal


def test_pending_action_survives_restart_until_acknowledged(tmp_path: Path) -> None:
    path = tmp_path / "journal.json"
    first = ActionJournal(path)

    pending = first.stage({"type": "start_arena", "arenaId": "arena"})
    recovered = ActionJournal(path).pending()

    assert recovered == pending
    ActionJournal(path).acknowledge(pending.idempotency_key)
    assert ActionJournal(path).pending() is None


def test_failed_atomic_replace_leaves_no_partial_journal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "journal.json"

    def fail_replace(_source: Path, _target: Path) -> None:
        raise OSError("disk failure")

    monkeypatch.setattr(Path, "replace", fail_replace)

    with pytest.raises(OSError, match="disk failure"):
        ActionJournal(path).stage({"type": "start_arena", "arenaId": "arena"})

    assert not path.exists()
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("contents", ["not-json", "{}", '[["valid", "json"]]'])
def test_corrupt_journal_reports_a_safe_recovery_action(tmp_path: Path, contents: str) -> None:
    path = tmp_path / "journal.json"
    path.write_text(contents)

    with pytest.raises(RuntimeError, match=r"Move it aside.*verifying") as error:
        ActionJournal(path).pending()

    assert str(path) in str(error.value)
