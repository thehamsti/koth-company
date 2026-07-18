import { describe, expect, test } from "bun:test";
import { automationAction } from "./contracts";

const eventId = "00000000-0000-4000-8000-000000000001";
const arenaId = "00000000-0000-4000-8000-000000000002";
const contestantId = "00000000-0000-4000-8000-000000000003";

describe("automation action contract", () => {
  test("accepts a result tied to an exact arena", () => {
    expect(
      automationAction.parse({
        type: "record_result",
        eventId,
        workerId: "hydramist-mac",
        arenaId,
        contestantWon: true,
      }),
    ).toMatchObject({ type: "record_result", arenaId, contestantWon: true });
  });

  test("rejects oversized evidence images", () => {
    expect(() =>
      automationAction.parse({
        type: "pause",
        eventId,
        workerId: "hydramist-mac",
        reason: "ambiguous result",
        evidenceImage: "x".repeat(250_001),
      }),
    ).toThrow();
  });

  test("accepts explicit worker takeover on a heartbeat", () => {
    expect(
      automationAction.parse({
        type: "heartbeat",
        eventId,
        workerId: "replacement-worker",
        takeover: true,
      }),
    ).toMatchObject({ type: "heartbeat", takeover: true });
  });

  test("accepts automatic event activation and an observed arena baseline", () => {
    expect(
      automationAction.parse({
        type: "activate_event",
        eventId,
        workerId: "hydramist-mac",
      }),
    ).toMatchObject({ type: "activate_event" });
    expect(
      automationAction.parse({
        type: "open_arena",
        eventId,
        workerId: "hydramist-mac",
        contestantId,
        baselineWins: 2,
      }),
    ).toMatchObject({ type: "open_arena", baselineWins: 2 });
  });

  test("accepts removing a contestant from a draft roster", () => {
    expect(
      automationAction.parse({
        type: "remove_contestant",
        eventId,
        workerId: "hydramist-mac",
        contestantId,
      }),
    ).toMatchObject({ type: "remove_contestant", contestantId });
  });
});
