import { describe, expect, test } from "bun:test";
import { ingestionProposal } from "./contracts";

const eventId = "00000000-0000-4000-8000-000000000001";
const arenaId = "00000000-0000-4000-8000-000000000002";

describe("ingestion proposal contract", () => {
  test("accepts an arena result tied to an exact arena", () => {
    expect(
      ingestionProposal.parse({
        eventId,
        kind: "arena_result",
        confidence: 0.98,
        payload: { arenaId, contestantWon: true },
      }),
    ).toEqual({
      eventId,
      kind: "arena_result",
      confidence: 0.98,
      evidence: {},
      payload: { arenaId, contestantWon: true },
    });
  });

  test("rejects proposal kinds that operator review cannot apply", () => {
    const result = ingestionProposal.safeParse({
      eventId,
      kind: "queue",
      confidence: 0.98,
      payload: { contestants: ["Hydra"] },
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ["kind"],
        message: 'Only "arena_result" ingestion proposals are supported.',
      }),
    );
  });

  test("rejects malformed arena results before review", () => {
    const result = ingestionProposal.safeParse({
      eventId,
      kind: "arena_result",
      confidence: 0.98,
      payload: { arenaId: "not-an-arena", contestantWon: "yes" },
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual([
      "payload.arenaId",
      "payload.contestantWon",
    ]);
  });
});
