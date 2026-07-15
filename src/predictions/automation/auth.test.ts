import { describe, expect, test } from "bun:test";
import { signAutomationRequest, verifyAutomationRequest } from "./auth";

const request = {
  method: "POST",
  path: "/api/predictions/automation/actions",
  timestamp: "1720000000000",
  idempotencyKey: "arena-4-result",
  rawBody: '{"type":"record_result","contestantWon":true}',
};

describe("automation request signing", () => {
  test("accepts an untampered request inside the clock window", async () => {
    const signature = await signAutomationRequest("secret", request);

    expect(
      await verifyAutomationRequest("secret", { ...request, signature }, 1_720_000_000_030),
    ).toBe(true);
  });

  test("rejects a modified body", async () => {
    const signature = await signAutomationRequest("secret", request);

    expect(
      await verifyAutomationRequest(
        "secret",
        { ...request, rawBody: '{"type":"record_result","contestantWon":false}', signature },
        1_720_000_000_030,
      ),
    ).toBe(false);
  });

  test("rejects requests older than sixty seconds", async () => {
    const signature = await signAutomationRequest("secret", request);

    expect(
      await verifyAutomationRequest("secret", { ...request, signature }, 1_720_000_060_001),
    ).toBe(false);
  });
});
