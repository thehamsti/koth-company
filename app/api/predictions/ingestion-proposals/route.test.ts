import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const eventId = "00000000-0000-4000-8000-000000000001";
const arenaId = "00000000-0000-4000-8000-000000000002";
const proposalId = "00000000-0000-4000-8000-000000000003";
const secret = "route-test-ingestion-secret";

const insertedValues: unknown[] = [];

mock.module("@/src/predictions/db", () => ({
  predictionDb: {
    insert: () => ({
      values: (values: unknown) => {
        insertedValues.push(values);
        return {
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve([{ id: proposalId }]),
          }),
        };
      },
    }),
  },
}));

const { POST } = await import("./route");
const previousSecret = process.env.PREDICTION_INGEST_SECRET;

function signedRequest(body: unknown): Request {
  const raw = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const idempotencyKey = "proposal-route-test-1";
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${idempotencyKey}.${raw}`)
    .digest("hex");

  return new Request("http://localhost:3002/api/predictions/ingestion-proposals", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-idempotency-key": idempotencyKey,
      "x-prediction-signature": signature,
      "x-prediction-timestamp": timestamp,
    },
    body: raw,
  });
}

beforeEach(() => {
  insertedValues.length = 0;
  process.env.PREDICTION_INGEST_SECRET = secret;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.PREDICTION_INGEST_SECRET;
  else process.env.PREDICTION_INGEST_SECRET = previousSecret;
  mock.restore();
});

describe("POST /api/predictions/ingestion-proposals", () => {
  test("stores a validated arena result proposal", async () => {
    const response = await POST(
      signedRequest({
        eventId,
        kind: "arena_result",
        confidence: 0.98765,
        payload: { arenaId, contestantWon: false },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: proposalId, duplicate: false });
    expect(insertedValues).toEqual([
      {
        eventId,
        kind: "arena_result",
        confidence: "0.9877",
        evidence: {},
        payload: { arenaId, contestantWon: false },
        idempotencyKey: "proposal-route-test-1",
      },
    ]);
  });

  test("returns an actionable 400 before inserting an unsupported proposal kind", async () => {
    const response = await POST(
      signedRequest({
        eventId,
        kind: "current_contestant",
        confidence: 0.9,
        payload: { displayName: "Hydra" },
      }),
    );
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(body.error.message).toContain(
      'kind: Only "arena_result" ingestion proposals are supported.',
    );
    expect(insertedValues).toEqual([]);
  });
});
