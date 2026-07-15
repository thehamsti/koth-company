import { describe, expect, test } from "bun:test";
import { createRealtimeWatermarks, realtimePayload } from "./realtime-client";

function event(revision: string, payload: unknown): MessageEvent<string> {
  return new MessageEvent("message", {
    data: JSON.stringify({ revision, payload }),
  });
}

describe("realtimePayload", () => {
  test("accepts distinct initial events at one checkpoint", () => {
    const watermarks = createRealtimeWatermarks();

    expect(realtimePayload<string>("public.snapshot", event("epoch:1", "public"), watermarks)).toBe(
      "public",
    );
    expect(
      realtimePayload<string>("account.updated", event("epoch:1", "account"), watermarks),
    ).toBe("account");
  });

  test("rejects duplicate and globally stale events", () => {
    const watermarks = createRealtimeWatermarks();

    expect(realtimePayload<string>("public.snapshot", event("epoch:3", "latest"), watermarks)).toBe(
      "latest",
    );
    expect(
      realtimePayload<string>("public.snapshot", event("epoch:3", "duplicate"), watermarks),
    ).toBeNull();
    expect(
      realtimePayload<string>("market.updated", event("epoch:2", "stale"), watermarks),
    ).toBeNull();
  });
});
