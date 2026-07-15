import { handleRequest, realtime } from "./app";
import { stopServerGracefully } from "./realtime/shutdown";

const port = Number.parseInt(process.env.API_PORT ?? "4000", 10);
const hostname = process.env.API_HOST ?? "0.0.0.0";
const shutdownGraceMs = Number.parseInt(process.env.SHUTDOWN_GRACE_MS ?? "10000", 10);

if (!Number.isSafeInteger(shutdownGraceMs) || shutdownGraceMs < 1) {
  throw new Error("SHUTDOWN_GRACE_MS must be a positive integer.");
}

const server = Bun.serve({
  hostname,
  port,
  maxRequestBodySize: 1024 * 1024,
  fetch: handleRequest,
});

console.log(`KOTH API listening on http://${server.hostname}:${server.port}`);

async function shutdown(signal: string): Promise<void> {
  console.log(`KOTH API received ${signal}; draining connections.`);
  await stopServerGracefully(server, {
    timeoutMs: shutdownGraceMs,
    drain: () => realtime.close(),
    onForce: () => console.error("KOTH API graceful shutdown timed out; closing connections."),
  });
}

let shutdownPromise: Promise<void> | null = null;

function handleSignal(signal: string): void {
  shutdownPromise ??= shutdown(signal).catch((error: unknown) => {
    console.error("KOTH API shutdown failed.", error);
    process.exitCode = 1;
  });
}

process.once("SIGINT", () => handleSignal("SIGINT"));
process.once("SIGTERM", () => handleSignal("SIGTERM"));
