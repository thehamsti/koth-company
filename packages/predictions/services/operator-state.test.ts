import { describe, expect, test } from "bun:test";
import {
  validateOperatorTransition,
  type OperatorCommand,
  type OperatorTransitionState,
} from "./operator-state";

const eventId = "event-1";
const contestantId = "contestant-1";
const arenaId = "arena-1";

const contestant = {
  id: contestantId,
  eventId,
  displayName: "Hydra",
  status: "active",
  wins: 2,
} as const;

const openArena = {
  id: arenaId,
  eventId,
  contestantId,
  ordinal: 1,
  status: "open",
} as const;

function liveState(overrides: Partial<OperatorTransitionState> = {}): OperatorTransitionState {
  return {
    event: { id: eventId, status: "live" },
    contestant,
    arena: null,
    activeArena: null,
    automation: null,
    ...overrides,
  };
}

function validate(command: OperatorCommand, state = liveState()): void {
  validateOperatorTransition(command, state);
}

describe("operator command transitions", () => {
  test("allows the transitions exposed by the control UI", () => {
    expect(() =>
      validate(
        { type: "add_contestant", eventId, displayName: "Hydra" },
        liveState({ event: { id: eventId, status: "draft" } }),
      ),
    ).not.toThrow();
    expect(() => validate({ type: "open_arena", eventId, contestantId })).not.toThrow();
    expect(() =>
      validate(
        { type: "start_arena", eventId, arenaId },
        liveState({ arena: openArena, activeArena: openArena }),
      ),
    ).not.toThrow();
    const lockedArena = { ...openArena, status: "locked" as const };
    expect(() =>
      validate(
        { type: "record_result", eventId, arenaId, contestantWon: true },
        liveState({ arena: lockedArena, activeArena: lockedArena }),
      ),
    ).not.toThrow();
  });

  test("enforces the event lifecycle", () => {
    expect(() => validate({ type: "add_contestant", eventId, displayName: "Late" })).toThrow(
      "draft event",
    );
    expect(() => validate({ type: "activate_event", eventId })).toThrow(
      "Only draft events can be activated",
    );
    expect(() =>
      validate(
        { type: "complete_event", eventId },
        liveState({ event: { id: eventId, status: "completed" } }),
      ),
    ).toThrow("requires a live event");
    expect(() =>
      validate({ type: "open_arena", eventId, contestantId }, liveState({ event: null })),
    ).toThrow("Event not found");
  });

  test("only removes queued contestants from their draft event", () => {
    const draft = liveState({
      event: { id: eventId, status: "draft" },
      contestant: { ...contestant, status: "queued" },
    });
    expect(() =>
      validate({ type: "remove_contestant", eventId, contestantId }, draft),
    ).not.toThrow();
    expect(() =>
      validate({ type: "remove_contestant", eventId, contestantId }, liveState()),
    ).toThrow("draft event");
    expect(() =>
      validate(
        { type: "remove_contestant", eventId, contestantId },
        { ...draft, contestant: { ...contestant, eventId: "event-2", status: "queued" } },
      ),
    ).toThrow("does not belong");
  });

  test("rejects foreign or unavailable contestants", () => {
    expect(() =>
      validate(
        { type: "open_arena", eventId, contestantId },
        liveState({ contestant: { ...contestant, eventId: "event-2" } }),
      ),
    ).toThrow("does not belong to this event");
    expect(() =>
      validate(
        { type: "open_arena", eventId, contestantId },
        liveState({ contestant: { ...contestant, status: "eliminated" } }),
      ),
    ).toThrow("not available");
    expect(() =>
      validate({ type: "create_threshold", eventId, contestantId, threshold: 2 }, liveState()),
    ).toThrow("greater than the contestant's current wins");
  });

  test("prevents concurrent and out-of-order arena changes", () => {
    expect(() =>
      validate(
        { type: "open_arena", eventId, contestantId },
        liveState({ activeArena: openArena }),
      ),
    ).toThrow("Resolve the active arena first");
    expect(() =>
      validate(
        { type: "start_arena", eventId, arenaId },
        liveState({ arena: { ...openArena, eventId: "event-2" }, activeArena: openArena }),
      ),
    ).toThrow("Arena does not belong to this event");
    expect(() =>
      validate(
        { type: "start_arena", eventId, arenaId },
        liveState({
          arena: openArena,
          activeArena: { ...openArena, id: "arena-2", ordinal: 2 },
        }),
      ),
    ).toThrow("does not match the active arena");
    expect(() =>
      validate(
        { type: "record_result", eventId, arenaId, contestantWon: true },
        liveState({ arena: openArena, activeArena: openArena }),
      ),
    ).toThrow("locked arena");
  });

  test("only corrects settled results when no arena is active", () => {
    expect(() =>
      validate(
        { type: "correct_result", eventId, arenaId, contestantWon: false },
        liveState({ arena: openArena }),
      ),
    ).toThrow("settled arena result");
    expect(() =>
      validate(
        { type: "correct_result", eventId, arenaId, contestantWon: false },
        liveState({ arena: { ...openArena, status: "settled" }, activeArena: openArena }),
      ),
    ).toThrow("Resolve the active arena before correcting");
  });

  test("requires explicit valid automation transitions", () => {
    expect(() =>
      validate(
        { type: "set_automation", eventId, enabled: true },
        liveState({ automation: { enabled: true, paused: true } }),
      ),
    ).toThrow("resume it explicitly");
    expect(() =>
      validate(
        { type: "pause_automation", eventId },
        liveState({ automation: { enabled: false, paused: false } }),
      ),
    ).toThrow("not enabled");
    expect(() =>
      validate(
        { type: "resume_automation", eventId },
        liveState({ automation: { enabled: true, paused: false } }),
      ),
    ).toThrow("Only paused automation");
  });
});
