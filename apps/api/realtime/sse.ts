import type { RealtimeEvent } from "../../../packages/contracts/src";
import type { RealtimeSubscription } from "./broker";

const encoder = new TextEncoder();
const MIN_RETRY_MS = 2_000;
const MAX_RETRY_MS = 8_000;

export function randomizedSseRetryMs(randomValue = Math.random()): number {
  const bounded = Math.min(1, Math.max(0, randomValue));
  return Math.floor(MIN_RETRY_MS + bounded * (MAX_RETRY_MS - MIN_RETRY_MS));
}

export function formatSseEvent(event: RealtimeEvent): Uint8Array {
  const data = JSON.stringify({
    revision: event.revision,
    emittedAt: event.emittedAt,
    payload: event.payload,
  });
  return encoder.encode(`id: ${event.revision}\nevent: ${event.name}\ndata: ${data}\n\n`);
}

export type SseResponseOptions = {
  keepAliveMs?: number;
  maxLifetimeMs?: number;
  retryMs?: number;
  onClose?: () => void;
};

export function createSseResponse(
  subscription: RealtimeSubscription,
  initialEvents: readonly RealtimeEvent[],
  options: SseResponseOptions = {},
): Response {
  const keepAliveMs = options.keepAliveMs ?? 20_000;
  const retryMs = options.retryMs ?? randomizedSseRetryMs();
  let keepAlive: ReturnType<typeof setInterval> | null = null;
  let maxLifetime: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (keepAlive) clearInterval(keepAlive);
    if (maxLifetime) clearTimeout(maxLifetime);
    keepAlive = null;
    maxLifetime = null;
    subscription.close();
    options.onClose?.();
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`retry: ${retryMs}\n\n`));
      for (const event of initialEvents) controller.enqueue(formatSseEvent(event));
      keepAlive = setInterval(
        () => controller.enqueue(encoder.encode(": keepalive\n\n")),
        keepAliveMs,
      );
      if (options.maxLifetimeMs !== undefined) {
        maxLifetime = setTimeout(close, options.maxLifetimeMs);
      }
    },
    async pull(controller) {
      const next = await subscription.next();
      if (next.done) {
        close();
        controller.close();
        return;
      }
      controller.enqueue(formatSseEvent(next.value));
    },
    cancel() {
      close();
    },
  });
  return new Response(stream, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}
