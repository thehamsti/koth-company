from koth_cv.state_machine import DecisionEngine, Observation, ServerSnapshot


EVENT_ID = "00000000-0000-4000-8000-000000000001"
CONTESTANT_ID = "00000000-0000-4000-8000-000000000002"
ARENA_ID = "00000000-0000-4000-8000-000000000003"
NEXT_ARENA_ID = "00000000-0000-4000-8000-000000000004"


def snapshot(
    *,
    event_status: str = "live",
    arena_status: str | None = None,
    arena_id: str = ARENA_ID,
    wins: int = 2,
) -> ServerSnapshot:
    return ServerSnapshot(
        event_id=EVENT_ID,
        event_status=event_status,
        contestants={"Hydra": CONTESTANT_ID},
        arena_id=arena_id if arena_status else None,
        arena_status=arena_status,
        arena_contestant_name="Hydra" if arena_status else None,
        arena_contestant_wins=wins if arena_status else None,
    )


def test_adds_a_stable_draft_roster_name() -> None:
    engine = DecisionEngine()
    state = snapshot(event_status="draft")

    for _ in range(2):
        assert engine.observe(Observation(roster=("Newplayer",)), state) is None

    assert engine.observe(Observation(roster=("Newplayer",)), state) == {
        "type": "add_contestant",
        "displayName": "Newplayer",
    }


def test_activates_a_synced_draft_when_current_player_is_stable() -> None:
    engine = DecisionEngine()
    state = ServerSnapshot(
        event_id=EVENT_ID,
        event_status="draft",
        contestants={
            "Hydra": CONTESTANT_ID,
            "Rival": "00000000-0000-4000-8000-000000000005",
        },
        arena_id=None,
        arena_status=None,
    )
    observation = Observation(roster=("Hydra", "Rival"), active_name="Hydra", current_wins=2)

    for _ in range(3):
        assert engine.observe(observation, state) is None

    assert engine.observe(observation, state) == {"type": "activate_event"}


def test_removes_a_contestant_only_after_ten_visible_absent_roster_reads() -> None:
    engine = DecisionEngine()
    state = ServerSnapshot(
        event_id=EVENT_ID,
        event_status="draft",
        contestants={
            "Hydra": CONTESTANT_ID,
            "Rival": "00000000-0000-4000-8000-000000000005",
            "Third": "00000000-0000-4000-8000-000000000006",
        },
        arena_id=None,
        arena_status=None,
    )

    assert engine.observe(Observation(roster=("Hydra", "Rival", "Third")), state) is None

    for _ in range(9):
        assert engine.observe(Observation(roster=("Rival", "Third")), state) is None

    assert engine.observe(Observation(roster=("Rival", "Third")), state) == {
        "type": "remove_contestant",
        "contestantId": CONTESTANT_ID,
    }


def test_does_not_remove_a_contestant_seen_during_the_absence_window() -> None:
    engine = DecisionEngine()
    state = ServerSnapshot(
        event_id=EVENT_ID,
        event_status="draft",
        contestants={
            "Hydra": CONTESTANT_ID,
            "Rival": "00000000-0000-4000-8000-000000000005",
            "Third": "00000000-0000-4000-8000-000000000006",
        },
        arena_id=None,
        arena_status=None,
    )

    for roster in [
        ("Hydra", "Rival", "Third"),
        ("Rival", "Third"),
        ("Rival", "Third"),
        ("Rival", "Third"),
        ("HYDRA", "Rival", "Third"),
        ("Rival", "Third"),
        ("Rival", "Third"),
        ("Rival", "Third"),
        ("Rival", "Third"),
        ("Rival", "Third"),
    ]:
        assert engine.observe(Observation(roster=roster), state) is None


def test_empty_or_unseen_queue_pages_never_remove_server_contestants() -> None:
    engine = DecisionEngine()
    state = ServerSnapshot(
        event_id=EVENT_ID,
        event_status="draft",
        contestants={
            "Hydra": CONTESTANT_ID,
            "Rival": "00000000-0000-4000-8000-000000000005",
            "Third": "00000000-0000-4000-8000-000000000006",
            "Neverseen": "00000000-0000-4000-8000-000000000007",
        },
        arena_id=None,
        arena_status=None,
    )

    for _ in range(10):
        assert engine.observe(Observation(roster=()), state) is None
    for _ in range(10):
        assert engine.observe(Observation(roster=("Hydra", "Rival", "Third")), state) is None


def test_faction_queue_switch_does_not_remove_the_other_page() -> None:
    engine = DecisionEngine()
    state = ServerSnapshot(
        event_id=EVENT_ID,
        event_status="draft",
        contestants={
            "Nedj": "00000000-0000-4000-8000-000000000010",
            "Oldp": "00000000-0000-4000-8000-000000000011",
            "Kapten": "00000000-0000-4000-8000-000000000012",
            "Babiano": "00000000-0000-4000-8000-000000000013",
            "Nayressa": "00000000-0000-4000-8000-000000000014",
            "Thorfinn": "00000000-0000-4000-8000-000000000015",
        },
        arena_id=None,
        arena_status=None,
    )

    horde = Observation(roster=("Nedj", "Oldp", "Kapten"))
    alliance = Observation(roster=("Babiano", "Nayressa", "Thorfinn"))
    assert engine.observe(horde, state) is None
    for _ in range(10):
        assert engine.observe(alliance, state) is None


def test_queue_identity_ignores_ocr_accent_variation_without_changing_the_label() -> None:
    engine = DecisionEngine()
    state = ServerSnapshot(
        event_id=EVENT_ID,
        event_status="draft",
        contestants={
            "Kaptèn": CONTESTANT_ID,
            "Oldp": "00000000-0000-4000-8000-000000000005",
            "Nedj": "00000000-0000-4000-8000-000000000006",
        },
        arena_id=None,
        arena_status=None,
    )

    assert engine.observe(Observation(roster=("Kaptèn", "Oldp", "Nedj")), state) is None
    for _ in range(3):
        assert engine.observe(Observation(roster=("Kapten", "Oldp", "Nedj")), state) is None


def test_syncs_live_queue_order_and_rezzes_an_eliminated_contestant() -> None:
    rival_id = "00000000-0000-4000-8000-000000000005"
    engine = DecisionEngine()
    state = ServerSnapshot(
        event_id=EVENT_ID,
        event_status="live",
        contestants={"Hydra": CONTESTANT_ID},
        arena_id=None,
        arena_status=None,
        unavailable_contestant_names=frozenset({"rival"}),
        all_contestants={"Hydra": CONTESTANT_ID, "Rival": rival_id},
        queued_contestant_names=("Hydra",),
    )
    observation = Observation(queue=("Rival", "LateSignup", "Hydra"))

    assert engine.observe(observation, state) is None
    assert engine.observe(observation, state) is None
    assert engine.observe(observation, state) == {
        "type": "sync_queue",
        "contestantIds": [rival_id, CONTESTANT_ID],
    }


def test_live_identity_ignores_ocr_accent_variation() -> None:
    engine = DecisionEngine()
    state = ServerSnapshot(
        event_id=EVENT_ID,
        event_status="live",
        contestants={"Kaptèn": CONTESTANT_ID},
        arena_id=None,
        arena_status=None,
    )

    for name in ("Kaptèn", "Kapten", "Kaptèn"):
        assert engine.observe(Observation(active_name=name), state) is None
    assert engine.observe(Observation(active_name="Kapten"), state) == {
        "type": "open_arena",
        "contestantId": CONTESTANT_ID,
    }


def test_live_identity_suppresses_an_accent_variant_of_an_unavailable_contestant() -> None:
    engine = DecisionEngine()
    state = ServerSnapshot(
        event_id=EVENT_ID,
        event_status="live",
        contestants={"Rival": "00000000-0000-4000-8000-000000000005"},
        arena_id=None,
        arena_status=None,
        unavailable_contestant_names=frozenset({"kapten"}),
    )

    for name in ("Kaptèn", "Kapten", "Kaptèn", "Kapten"):
        assert engine.observe(Observation(active_name=name), state) is None


def test_same_queue_page_removes_only_the_previously_seen_missing_name() -> None:
    engine = DecisionEngine()
    missing_id = "00000000-0000-4000-8000-000000000012"
    state = ServerSnapshot(
        event_id=EVENT_ID,
        event_status="draft",
        contestants={
            "Nedj": "00000000-0000-4000-8000-000000000010",
            "Oldp": "00000000-0000-4000-8000-000000000011",
            "Kapten": missing_id,
            "Smashmysick": "00000000-0000-4000-8000-000000000013",
            "Suezqt": "00000000-0000-4000-8000-000000000014",
        },
        arena_id=None,
        arena_status=None,
    )

    assert (
        engine.observe(
            Observation(roster=("Nedj", "Oldp", "Kapten", "Smashmysick", "Suezqt")),
            state,
        )
        is None
    )
    for _ in range(9):
        assert (
            engine.observe(
                Observation(roster=("Nedj", "Oldp", "Smashmysick", "Suezqt")),
                state,
            )
            is None
        )
    assert engine.observe(Observation(roster=("Nedj", "Oldp", "Smashmysick", "Suezqt")), state) == {
        "type": "remove_contestant",
        "contestantId": missing_id,
    }
    assert (
        engine.observe(Observation(roster=("Nedj", "Oldp", "Smashmysick", "Suezqt")), state) is None
    )


def test_truncated_same_page_prefix_does_not_remove_unread_trailing_names() -> None:
    engine = DecisionEngine()
    state = ServerSnapshot(
        event_id=EVENT_ID,
        event_status="draft",
        contestants={
            "Nedj": "00000000-0000-4000-8000-000000000010",
            "Oldp": "00000000-0000-4000-8000-000000000011",
            "Kapten": "00000000-0000-4000-8000-000000000012",
            "Magiavende": "00000000-0000-4000-8000-000000000013",
            "Eanky": "00000000-0000-4000-8000-000000000014",
        },
        arena_id=None,
        arena_status=None,
    )

    assert (
        engine.observe(
            Observation(roster=("Nedj", "Oldp", "Kapten", "Magiavende", "Eanky")),
            state,
        )
        is None
    )
    for _ in range(10):
        assert engine.observe(Observation(roster=("Nedj", "Oldp", "Kapten")), state) is None


def test_removed_queue_name_can_rejoin_after_three_new_same_page_reads() -> None:
    engine = DecisionEngine()
    removed_id = "00000000-0000-4000-8000-000000000012"
    state = ServerSnapshot(
        event_id=EVENT_ID,
        event_status="draft",
        contestants={
            "Nedj": "00000000-0000-4000-8000-000000000010",
            "Oldp": "00000000-0000-4000-8000-000000000011",
            "Kaptèn": removed_id,
            "Smashmysick": "00000000-0000-4000-8000-000000000013",
        },
        arena_id=None,
        arena_status=None,
    )
    full_page = Observation(roster=("Nedj", "Oldp", "Kapten", "Smashmysick"))
    missing_page = Observation(roster=("Nedj", "Oldp", "Smashmysick"))

    assert engine.observe(full_page, state) is None
    for _ in range(9):
        assert engine.observe(missing_page, state) is None
    assert engine.observe(missing_page, state) == {
        "type": "remove_contestant",
        "contestantId": removed_id,
    }

    removed_state = ServerSnapshot(
        event_id=EVENT_ID,
        event_status="draft",
        contestants={
            "Nedj": "00000000-0000-4000-8000-000000000010",
            "Oldp": "00000000-0000-4000-8000-000000000011",
            "Smashmysick": "00000000-0000-4000-8000-000000000013",
        },
        arena_id=None,
        arena_status=None,
    )
    assert engine.observe(full_page, removed_state) is None
    assert engine.observe(full_page, removed_state) is None
    assert engine.observe(full_page, removed_state) == {
        "type": "add_contestant",
        "displayName": "Kapten",
    }


def test_opens_arena_after_four_of_six_active_name_reads() -> None:
    engine = DecisionEngine()
    state = snapshot()

    for name in ["Hydra", None, "Hydra", "Hydra", None]:
        assert engine.observe(Observation(active_name=name, current_wins=2), state) is None

    assert engine.observe(Observation(active_name="Hydra", current_wins=2), state) == {
        "type": "open_arena",
        "contestantId": CONTESTANT_ID,
        "baselineWins": 2,
    }


def test_hidden_overlay_clears_accumulated_observations() -> None:
    engine = DecisionEngine()
    state = snapshot()

    for _ in range(3):
        assert engine.observe(Observation(active_name="Hydra"), state) is None
    assert engine.observe(Observation(metadata={"overlayVisible": False}), state) is None
    for _ in range(3):
        assert engine.observe(Observation(active_name="Hydra"), state) is None

    assert engine.observe(Observation(active_name="Hydra"), state) == {
        "type": "open_arena",
        "contestantId": CONTESTANT_ID,
    }


def test_server_state_change_clears_stale_active_name() -> None:
    engine = DecisionEngine()
    idle = snapshot()

    for _ in range(3):
        assert engine.observe(Observation(active_name="Hydra"), idle) is None
    assert engine.observe(Observation(active_name="Hydra"), idle) == {
        "type": "open_arena",
        "contestantId": CONTESTANT_ID,
    }

    assert engine.observe(Observation(), snapshot(arena_status="open")) is None
    assert engine.observe(Observation(), idle) is None


def test_pauses_on_a_stable_unknown_live_contestant() -> None:
    engine = DecisionEngine()
    state = snapshot()

    for _ in range(3):
        engine.observe(Observation(active_name="Unknown"), state)

    assert engine.observe(Observation(active_name="Unknown"), state) == {
        "type": "pause",
        "reason": "Unknown live contestant: Unknown",
    }


def test_ignores_a_stale_eliminated_player_then_opens_the_next_contestant() -> None:
    engine = DecisionEngine()
    state = ServerSnapshot(
        event_id=EVENT_ID,
        event_status="live",
        contestants={"Rival": "00000000-0000-4000-8000-000000000005"},
        arena_id=None,
        arena_status=None,
        unavailable_contestant_names=frozenset({"hydra"}),
    )

    for _ in range(4):
        assert engine.observe(Observation(active_name="Hydra"), state) is None
    for _ in range(3):
        assert engine.observe(Observation(active_name="Rival"), state) is None
    assert engine.observe(Observation(active_name="Rival"), state) == {
        "type": "open_arena",
        "contestantId": "00000000-0000-4000-8000-000000000005",
    }


def test_starts_an_open_arena_after_three_active_frames() -> None:
    engine = DecisionEngine()
    state = snapshot(arena_status="open")

    assert engine.observe(Observation(arena_active=True), state) is None
    assert engine.observe(Observation(arena_active=True), state) is None
    assert engine.observe(Observation(arena_active=True), state) == {
        "type": "start_arena",
        "arenaId": ARENA_ID,
    }


def test_new_arena_requires_new_start_frames() -> None:
    engine = DecisionEngine()
    first = snapshot(arena_status="open")

    for _ in range(2):
        assert engine.observe(Observation(arena_active=True), first) is None
    assert engine.observe(Observation(arena_active=True), first) == {
        "type": "start_arena",
        "arenaId": ARENA_ID,
    }

    assert engine.observe(Observation(), snapshot(arena_status="locked")) is None
    second = snapshot(arena_status="open", arena_id=NEXT_ARENA_ID)
    for _ in range(2):
        assert engine.observe(Observation(arena_active=True), second) is None
    assert engine.observe(Observation(arena_active=True), second) == {
        "type": "start_arena",
        "arenaId": NEXT_ARENA_ID,
    }


def test_records_only_three_consecutive_high_confidence_results() -> None:
    engine = DecisionEngine()
    state = snapshot(arena_status="locked")

    win = Observation(
        active_name="Hydra",
        current_wins=3,
        result_visible=True,
        result_confidence=0.95,
    )
    assert engine.observe(win, state) is None
    assert (
        engine.observe(
            Observation(
                active_name="Hydra",
                current_wins=3,
                result_visible=True,
                result_confidence=0.89,
            ),
            state,
        )
        is None
    )
    assert engine.observe(win, state) is None
    assert engine.observe(win, state) is None
    assert engine.observe(win, state) == {
        "type": "record_result",
        "arenaId": ARENA_ID,
        "contestantWon": True,
    }


def test_result_identity_ignores_ocr_accent_variation() -> None:
    engine = DecisionEngine()
    state = ServerSnapshot(
        event_id=EVENT_ID,
        event_status="live",
        contestants={"Kaptèn": CONTESTANT_ID},
        arena_id=ARENA_ID,
        arena_status="locked",
        arena_contestant_name="Kaptèn",
        arena_contestant_wins=2,
    )
    result = Observation(
        active_name="Kapten",
        current_wins=3,
        result_visible=True,
        result_confidence=0.99,
    )

    assert engine.observe(result, state) is None
    assert engine.observe(result, state) is None
    assert engine.observe(result, state) == {
        "type": "record_result",
        "arenaId": ARENA_ID,
        "contestantWon": True,
    }


def test_new_arena_requires_new_result_frames() -> None:
    for contestant_won in (True, False):
        engine = DecisionEngine()
        first = snapshot(arena_status="locked")

        observation = Observation(
            active_name="Hydra",
            current_wins=3 if contestant_won else 2,
            result_visible=True,
            result_confidence=0.99,
        )
        for _ in range(2):
            assert engine.observe(observation, first) is None
        assert engine.observe(observation, first) == {
            "type": "record_result",
            "arenaId": ARENA_ID,
            "contestantWon": contestant_won,
        }

        assert engine.observe(Observation(), snapshot()) is None
        second = snapshot(arena_status="locked", arena_id=NEXT_ARENA_ID)
        for _ in range(2):
            assert engine.observe(observation, second) is None
        assert engine.observe(observation, second) == {
            "type": "record_result",
            "arenaId": NEXT_ARENA_ID,
            "contestantWon": contestant_won,
        }


def test_pauses_on_an_ambiguous_result() -> None:
    engine = DecisionEngine()

    assert engine.observe(
        Observation(metadata={"pauseReason": "Ambiguous arena result"}),
        snapshot(arena_status="locked"),
    ) == {"type": "pause", "reason": "Ambiguous arena result"}


def test_pauses_after_three_result_frames_without_a_readable_counter() -> None:
    engine = DecisionEngine()
    state = snapshot(arena_status="locked")
    observation = Observation(
        active_name="Hydra",
        result_visible=True,
        result_confidence=0.99,
    )

    assert engine.observe(observation, state) is None
    assert engine.observe(observation, state) is None
    assert engine.observe(observation, state) == {
        "type": "pause",
        "reason": "Could not read the current player's win counter at arena result",
    }


def test_pauses_when_result_counter_skips_more_than_one_win() -> None:
    engine = DecisionEngine()
    state = snapshot(arena_status="locked", wins=7)
    observation = Observation(
        active_name="Hydra",
        current_wins=9,
        result_visible=True,
        result_confidence=0.99,
    )

    assert engine.observe(observation, state) is None
    assert engine.observe(observation, state) is None
    assert engine.observe(observation, state) == {
        "type": "pause",
        "reason": "Current player's win counter changed unexpectedly",
    }
