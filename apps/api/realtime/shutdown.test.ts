import { describe, expect, test } from "bun:test";
import { stopServerGracefully, type StoppableServer } from "./shutdown";

describe("stopServerGracefully", () => {
  test("drains realtime state and allows a graceful stop", async () => {
    const calls: boolean[] = [];
    let drained = false;
    const server: StoppableServer = {
      stop: async (force = false) => {
        calls.push(force);
      },
    };

    await stopServerGracefully(server, {
      timeoutMs: 100,
      drain: () => {
        drained = true;
      },
    });

    expect(drained).toBe(true);
    expect(calls).toEqual([false]);
  });

  test("forces active connections closed after the grace period", async () => {
    const calls: boolean[] = [];
    let forced = false;
    const server: StoppableServer = {
      stop: (force = false) => {
        calls.push(force);
        return force ? Promise.resolve() : new Promise<void>(() => {});
      },
    };

    await stopServerGracefully(server, {
      timeoutMs: 5,
      drain: () => {},
      onForce: () => {
        forced = true;
      },
    });

    expect(forced).toBe(true);
    expect(calls).toEqual([false, true]);
  });

  test("forces active connections closed when graceful shutdown fails", async () => {
    const calls: boolean[] = [];
    const server: StoppableServer = {
      stop: (force = false) => {
        calls.push(force);
        if (!force) throw new Error("graceful stop failed");
      },
    };

    await expect(stopServerGracefully(server, { timeoutMs: 100, drain: () => {} })).rejects.toThrow(
      "graceful stop failed",
    );
    expect(calls).toEqual([false, true]);
  });
});
