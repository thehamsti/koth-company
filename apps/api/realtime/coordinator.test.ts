import { afterAll, describe, expect, test } from "bun:test";
import type {
  AutomationState,
  OperatorState,
  PredictionPublicSnapshot,
  PublicMarketSnapshot,
} from "../../../packages/contracts/src";
import { RealtimeBroker } from "./broker";

const previousDatabaseUri = process.env.PREDICTION_DATABASE_URI;
process.env.PREDICTION_DATABASE_URI ??= "postgresql://test:test@localhost:5432/test";
const { RealtimeCoordinator } = await import("./coordinator");

afterAll(() => {
  if (previousDatabaseUri === undefined) delete process.env.PREDICTION_DATABASE_URI;
  else process.env.PREDICTION_DATABASE_URI = previousDatabaseUri;
});

const market = (version: number): PublicMarketSnapshot => ({
  id: "market-1",
  version,
  kind: "live_arena",
  status: "open",
  title: "Arena winner",
  locksAt: null,
  outcomes: [
    { id: "outcome-1", label: "Hydramist", probability: 0.6 },
    { id: "outcome-2", label: "Opponent", probability: 0.4 },
  ],
});

const snapshot = (version = 1): PredictionPublicSnapshot => ({
  enabled: true,
  event: null,
  markets: [market(version)],
  leaderboard: [],
  seasonLeaderboard: [],
});

const snapshotWithLeaderboard = (version: number, equity: string): PredictionPublicSnapshot => ({
  ...snapshot(version),
  leaderboard: [
    {
      userId: "user-1",
      name: "Viewer",
      equity,
      returnPercent: "0",
    },
  ],
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 250;
  while (!condition() && Date.now() < deadline) await Bun.sleep(1);
  expect(condition()).toBe(true);
}

const operatorState = (status: "running" | "stale" = "stale"): OperatorState => ({
  event: null,
  contestants: [],
  arenas: [],
  markets: [],
  proposals: [],
  automation: {
    enabled: true,
    paused: false,
    status,
    workerId: "worker-1",
    lastHeartbeatAt: new Date(),
    leaseExpiresAt: null,
    pauseReason: null,
    lastObservation: {},
    evidenceImage: null,
  },
});

const automationState = (
  status: "running" | "stale",
  lastHeartbeatAt = new Date(),
): AutomationState => ({
  event: null,
  automation: {
    enabled: true,
    paused: false,
    status,
    workerId: "worker-1",
    lastHeartbeatAt,
  },
  contestants: [],
  activeArena: null,
});

async function readWithTimeout(subscription: ReturnType<RealtimeBroker["subscribe"]>) {
  return Promise.race([
    subscription.next(),
    Bun.sleep(250).then(() => {
      throw new Error("Timed out waiting for realtime event.");
    }),
  ]);
}

describe("RealtimeCoordinator", () => {
  test("shares one bootstrap snapshot load across concurrent subscribers", async () => {
    const pendingSnapshot = deferred<PredictionPublicSnapshot>();
    let loads = 0;
    const coordinator = new RealtimeCoordinator(new RealtimeBroker({ epoch: "test" }), {
      loadPublicSnapshot: () => {
        loads += 1;
        return pendingSnapshot.promise;
      },
    });

    const first = coordinator.getPublicSnapshot();
    const second = coordinator.getPublicSnapshot();

    expect(loads).toBe(1);
    pendingSnapshot.resolve(snapshot(2));
    expect(await Promise.all([first, second])).toEqual([snapshot(2), snapshot(2)]);
    expect(loads).toBe(1);
    coordinator.close();
  });

  test("captures initial revisions before loading an async snapshot", async () => {
    const broker = new RealtimeBroker({ epoch: "test" });
    let resolveSnapshot!: (value: PredictionPublicSnapshot) => void;
    const pendingSnapshot = new Promise<PredictionPublicSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    const coordinator = new RealtimeCoordinator(broker, {
      loadPublicSnapshot: () => pendingSnapshot,
    });

    const initialPromise = coordinator.initialPrediction();
    const intervening = broker.publish(["public"], "accounts.invalidated", {
      eventId: null,
      reason: "event_changed",
    });
    resolveSnapshot(snapshot());
    const initial = await initialPromise;

    expect(initial.events.map(({ revision }) => revision)).toEqual(["test:1", "test:1"]);
    expect(intervening.revision).toBe("test:2");
    coordinator.close();
  });

  test("publishes settlement accounts only to affected viewers", async () => {
    const broker = new RealtimeBroker({ epoch: "test" });
    const loaded: Array<{ eventId: string; marketIds: readonly string[] }> = [];
    const coordinator = new RealtimeCoordinator(broker, {
      loadAffectedAccounts: async (eventId, marketIds) => {
        loaded.push({ eventId, marketIds });
        return ["user-1", "user-2"].map((userId, index) => ({
          userId,
          account: {
            eventId,
            portfolio: { availableCrowns: `${200 + index}`, equity: `${200 + index}` },
            sharesByOutcome: { "outcome-1": `${index + 1}` },
          },
        }));
      },
    });
    const first = broker.subscribe(["account:user-1"]);
    const second = broker.subscribe(["account:user-2"]);
    const unaffected = broker.subscribe(["account:user-3"]);
    const publicSubscription = broker.subscribe(["public"]);

    await coordinator.publishAffectedAccounts("event-1", ["market-1"]);

    const firstUpdate = await readWithTimeout(first);
    const secondUpdate = await readWithTimeout(second);
    expect(firstUpdate.value?.name).toBe("account.updated");
    expect(secondUpdate.value?.name).toBe("account.updated");
    expect(loaded).toEqual([{ eventId: "event-1", marketIds: ["market-1"] }]);
    const unaffectedRead = unaffected.next();
    const publicRead = publicSubscription.next();
    expect(
      await Promise.race([
        Promise.all([unaffectedRead, publicRead]),
        Bun.sleep(20).then(() => null),
      ]),
    ).toBeNull();
    coordinator.close();
    expect((await unaffectedRead).done).toBe(true);
    expect((await publicRead).done).toBe(true);
  });

  test("serializes deferred public and leaderboard refreshes and reruns dirty state", async () => {
    const broker = new RealtimeBroker({ epoch: "test" });
    const refreshLoads: Array<ReturnType<typeof deferred<PredictionPublicSnapshot>>> = [];
    let bootstrapped = false;
    const coordinator = new RealtimeCoordinator(broker, {
      loadPublicSnapshot: () => {
        if (!bootstrapped) {
          bootstrapped = true;
          return Promise.resolve(snapshotWithLeaderboard(1, "100"));
        }
        const load = deferred<PredictionPublicSnapshot>();
        refreshLoads.push(load);
        return load.promise;
      },
      loadViewerAccount: async () => ({
        eventId: null,
        portfolio: null,
        sharesByOutcome: {},
      }),
      publicBatchMs: 1,
      leaderboardBatchMs: 1,
    });
    const subscription = broker.subscribe(["public"]);
    await coordinator.getPublicSnapshot();

    coordinator.publishPublicChange();
    await waitFor(() => refreshLoads.length === 1);
    await coordinator.publishChannelPointCredit("user-1");
    await Bun.sleep(10);

    expect(refreshLoads).toHaveLength(1);
    refreshLoads[0]!.resolve(snapshotWithLeaderboard(2, "200"));
    const publicUpdate = await readWithTimeout(subscription);
    expect(publicUpdate.value?.name).toBe("public.snapshot");
    await waitFor(() => refreshLoads.length === 2);

    refreshLoads[1]!.resolve(snapshotWithLeaderboard(3, "300"));
    const leaderboardUpdate = await readWithTimeout(subscription);
    expect(leaderboardUpdate.value?.name).toBe("leaderboards.updated");
    if (leaderboardUpdate.value?.name === "leaderboards.updated") {
      expect(leaderboardUpdate.value.payload.leaderboard[0]?.equity).toBe("300");
    }
    expect((await coordinator.getPublicSnapshot()).markets[0]?.version).toBe(3);
    coordinator.close();
  });

  test("does not let a lower market version replace cached or pending state", async () => {
    const broker = new RealtimeBroker({ epoch: "test" });
    const coordinator = new RealtimeCoordinator(broker, {
      loadPublicSnapshot: async () => snapshot(),
      marketBatchMs: 1,
      leaderboardBatchMs: 60_000,
    });
    const subscription = broker.subscribe(["public"]);
    await coordinator.getPublicSnapshot();
    const account = { eventId: null, portfolio: null, sharesByOutcome: {} };

    coordinator.publishTrade("user-1", { market: market(3), account });
    coordinator.publishTrade("user-1", { market: market(2), account });

    expect((await coordinator.getPublicSnapshot()).markets[0]?.version).toBe(3);
    const update = await readWithTimeout(subscription);
    expect(update.value?.name).toBe("market.updated");
    if (update.value?.name === "market.updated") {
      expect(update.value.payload.market.version).toBe(3);
    }
    coordinator.close();
  });

  test("drops a pending market update superseded by a newer snapshot", async () => {
    const broker = new RealtimeBroker({ epoch: "test" });
    let databaseVersion = 1;
    const coordinator = new RealtimeCoordinator(broker, {
      loadPublicSnapshot: async () => snapshot(databaseVersion),
      marketBatchMs: 50,
      publicBatchMs: 1,
      leaderboardBatchMs: 60_000,
    });
    const subscription = broker.subscribe(["public"]);
    await coordinator.getPublicSnapshot();

    coordinator.publishTrade("user-1", {
      market: market(3),
      account: { eventId: null, portfolio: null, sharesByOutcome: {} },
    });
    databaseVersion = 4;
    coordinator.publishPublicChange();

    const snapshotUpdate = await readWithTimeout(subscription);
    expect(snapshotUpdate.value?.name).toBe("public.snapshot");
    if (snapshotUpdate.value?.name === "public.snapshot") {
      expect(snapshotUpdate.value.payload.markets[0]?.version).toBe(4);
    }

    const laterUpdate = subscription.next();
    const unexpected = await Promise.race([laterUpdate, Bun.sleep(75).then(() => null)]);
    expect(unexpected).toBeNull();
    coordinator.close();
    await laterUpdate;
  });

  test("publishes stale automation state when the worker lease expires", async () => {
    const broker = new RealtimeBroker({ epoch: "test" });
    let automationLoads = 0;
    const coordinator = new RealtimeCoordinator(broker, {
      automationLeaseTimeoutMs: 10,
      loadAutomationState: async () =>
        automationLoads++ === 0 ? automationState("running") : automationState("stale"),
      loadOperatorState: async () => operatorState("stale"),
    });
    const subscription = broker.subscribe(["automation"]);

    const initial = await coordinator.initialAutomation();
    const update = await readWithTimeout(subscription);

    expect(initial[1]?.name).toBe("automation.state");
    expect(update.value?.name).toBe("automation.state");
    if (update.value?.name === "automation.state") {
      expect(update.value.payload.automation?.status).toBe("stale");
    }
    coordinator.close();
  });

  test("close drains broker subscriptions", async () => {
    const broker = new RealtimeBroker({ epoch: "test" });
    const coordinator = new RealtimeCoordinator(broker);
    const subscription = broker.subscribe(["public"]);
    const pendingRead = subscription.next();

    coordinator.close();

    expect((await pendingRead).done).toBe(true);
    expect(broker.subscriberCount).toBe(0);
  });
});
