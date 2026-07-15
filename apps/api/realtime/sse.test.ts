import { describe, expect, test } from "bun:test";
import { RealtimeBroker } from "./broker";
import { createSseResponse, formatSseEvent, randomizedSseRetryMs } from "./sse";

describe("SSE responses", () => {
  test("formats the named event and revision envelope", () => {
    const broker = new RealtimeBroker({ epoch: "test" });
    const formatted = new TextDecoder().decode(
      formatSseEvent(broker.event("stream.ready", { epoch: "test" })),
    );
    expect(formatted).toContain("id: test:1\n");
    expect(formatted).toContain("event: stream.ready\n");
    expect(formatted).toContain('"revision":"test:1"');
    expect(formatted.endsWith("\n\n")).toBe(true);
  });

  test("sends retry guidance before initial state", async () => {
    const broker = new RealtimeBroker({ epoch: "test" });
    const subscription = broker.subscribe(["public"]);
    const response = createSseResponse(
      subscription,
      [broker.event("stream.ready", { epoch: "test" })],
      { keepAliveMs: 60_000, retryMs: 4_321 },
    );
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("retry: 4321\n\n");
    await reader.cancel();
    expect(broker.subscriberCount).toBe(0);
  });

  test("bounds randomized retry guidance", () => {
    expect(randomizedSseRetryMs(-1)).toBe(2_000);
    expect(randomizedSseRetryMs(0.5)).toBe(5_000);
    expect(randomizedSseRetryMs(2)).toBe(8_000);
  });

  test("runs the close hook exactly once", async () => {
    const broker = new RealtimeBroker({ epoch: "test" });
    const subscription = broker.subscribe(["public"]);
    let closes = 0;
    const response = createSseResponse(subscription, [], {
      maxLifetimeMs: 60_000,
      onClose: () => {
        closes += 1;
      },
    });
    const reader = response.body!.getReader();

    await reader.cancel();
    subscription.close();

    expect(closes).toBe(1);
  });

  test("closes the stream and runs cleanup after its maximum lifetime", async () => {
    const broker = new RealtimeBroker({ epoch: "test" });
    const subscription = broker.subscribe(["public"]);
    let closes = 0;
    const response = createSseResponse(subscription, [], {
      keepAliveMs: 60_000,
      maxLifetimeMs: 5,
      onClose: () => {
        closes += 1;
      },
    });
    const reader = response.body!.getReader();

    expect(new TextDecoder().decode((await reader.read()).value)).toMatch(/^retry: /);
    expect((await reader.read()).done).toBe(true);
    expect(broker.subscriberCount).toBe(0);
    expect(closes).toBe(1);
  });
});
