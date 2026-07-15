from koth_cv.detection import (
    StableVote,
    normalize_name,
    normalize_roster_name,
    parse_roster_names,
)


def test_normalize_name_preserves_identity_characters() -> None:
    assert normalize_name("  Hydra-Mist  ") == "Hydra-Mist"


def test_normalize_roster_name_removes_queue_rank_and_status() -> None:
    assert normalize_roster_name("1. Nedj") == "Nedj"
    assert normalize_roster_name("2.") == ""
    assert normalize_roster_name("7.1") == ""
    assert normalize_roster_name("Queue is closed") == ""


def test_parse_roster_names_requires_numbered_rows() -> None:
    assert parse_roster_names(["1. Nedj", "2.", "Oldp", "Queue", "is closed", "Damage Done"]) == (
        "Nedj",
        "Oldp",
    )


def test_parse_roster_names_stops_before_tooltip_numbers_and_labels() -> None:
    queue = [item for rank in range(1, 13) for item in (f"{rank}.", f"Player{rank}")]

    assert parse_roster_names([*queue, "70", "NPC", "Target:"]) == tuple(
        f"Player{rank}" for rank in range(1, 13)
    )


def test_parse_roster_names_omits_rows_after_a_rank_gap() -> None:
    assert parse_roster_names(["1. Hydra", "3. Tooltip", "4. Target"]) == ("Hydra",)


def test_stable_vote_requires_three_matching_values_in_five_frames() -> None:
    vote = StableVote(window=5, minimum=3)

    assert vote.push("Hydra") is None
    assert vote.push("Hydra") is None
    assert vote.push("Other") is None
    assert vote.push("Hydra") == "Hydra"


def test_stable_vote_does_not_fuzzy_merge_names() -> None:
    vote = StableVote(window=5, minimum=3)

    for value in ["Hydra", "Hydrá", "Hydra", "Hydrá", "Hydra"]:
        result = vote.push(value)

    assert result == "Hydra"
