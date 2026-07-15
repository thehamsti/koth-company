export type StoppableServer = {
  stop(closeActiveConnections?: boolean): Promise<void> | void;
};

type GracefulShutdownOptions = {
  timeoutMs: number;
  drain: () => void;
  onForce?: () => void;
};

export async function stopServerGracefully(
  server: StoppableServer,
  { timeoutMs, drain, onForce }: GracefulShutdownOptions,
): Promise<void> {
  drain();

  let forceTimer: ReturnType<typeof setTimeout> | null = null;
  const forcedStop = new Promise<void>((resolve, reject) => {
    forceTimer = setTimeout(() => {
      onForce?.();
      Promise.resolve(server.stop(true)).then(resolve, reject);
    }, timeoutMs);
  });
  const gracefulStop = Promise.resolve().then(() => server.stop(false));

  try {
    await Promise.race([gracefulStop, forcedStop]);
  } catch (error) {
    await server.stop(true);
    throw error;
  } finally {
    if (forceTimer) clearTimeout(forceTimer);
  }
}
