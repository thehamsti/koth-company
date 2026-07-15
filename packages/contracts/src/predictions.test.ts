import { describe, expect, test } from "bun:test";
import { operatorCommandInput, quoteInput, realtimeEnvelope, tradeInput } from "./index";

describe("prediction API contracts", () => {
  test("validates quote and trade precision", () => {
    expect(
      quoteInput.safeParse({
        marketId: "019cda3d-23df-7c6b-ad0f-6ed37bc063ac",
        outcomeId: "019cda3d-568d-770c-9f4b-30c9eaa1564d",
        side: "buy",
        amount: "10.12345678",
      }).success,
    ).toBe(true);
    expect(
      tradeInput.safeParse({
        quoteId: "019cda3d-71d7-7d7a-ad7a-bf5ea881bceb",
        idempotencyKey: "trade-key",
      }).success,
    ).toBe(true);
  });

  test("rejects incomplete operator commands", () => {
    expect(
      operatorCommandInput.safeParse({
        command: { type: "record_result" },
        idempotencyKey: "command-key",
      }).success,
    ).toBe(false);
  });

  test("accepts the shared realtime envelope", () => {
    expect(
      realtimeEnvelope.safeParse({
        revision: "epoch:1",
        emittedAt: "2026-07-14T12:00:00.000Z",
        payload: { enabled: true },
      }).success,
    ).toBe(true);
  });
});
