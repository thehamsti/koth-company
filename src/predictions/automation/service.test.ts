import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { arenas, automationSessions, contestants, domainEvents, events } from "../db/schema";

const eventId = "00000000-0000-4000-8000-000000000001";
type AutomationSession = typeof automationSessions.$inferSelect;
type Event = typeof events.$inferSelect;
type Contestant = typeof contestants.$inferSelect;

let eventFilter: SQL | undefined;
let eventRows: Event[] = [];
let automationSession: AutomationSession | null = null;
let contestantRows: Contestant[] = [];

type SelectQuery = Promise<unknown[]> & {
  from: (value: unknown) => SelectQuery;
  where: (filter: SQL) => SelectQuery;
  orderBy: () => SelectQuery;
  for: () => SelectQuery;
  limit: () => Promise<unknown[]>;
};

function session(overrides: Partial<AutomationSession> = {}): AutomationSession {
  const now = new Date();
  return {
    id: "00000000-0000-4000-8000-000000000002",
    eventId,
    enabled: true,
    paused: false,
    workerId: "worker-a",
    lastHeartbeatAt: now,
    pauseReason: null,
    lastObservation: {},
    evidenceImage: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function event(status: Event["status"]): Event {
  const now = new Date();
  return {
    id: eventId,
    name: "Test KOTH",
    season: 1,
    week: 1,
    status,
    startingCrowns: "10000",
    version: 1,
    startedAt: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function rowsFor(table: unknown): unknown[] {
  if (table === events) return eventRows;
  if (table === automationSessions) return automationSession ? [automationSession] : [];
  if (table === contestants) return contestantRows;
  if (table === domainEvents || table === arenas) return [];
  return [];
}

function selectQuery() {
  let table: unknown;
  const query = Promise.resolve().then(() => rowsFor(table)) as SelectQuery;
  query.from = (value) => {
    table = value;
    return query;
  };
  query.where = (filter) => {
    if (table === events) eventFilter = filter;
    return query;
  };
  query.orderBy = () => query;
  query.for = () => query;
  query.limit = () => Promise.resolve(rowsFor(table));
  return query;
}

function updateQuery(table: unknown) {
  return {
    set(values: Partial<AutomationSession>) {
      return {
        where() {
          if (table === automationSessions && automationSession) {
            automationSession = { ...automationSession, ...values };
          }
          return Promise.resolve();
        },
      };
    },
  };
}

const transactionDb = {
  insert: (table: unknown) => ({
    values: (values: { eventId: string }) => ({
      onConflictDoNothing: async () => {
        if (table === automationSessions && !automationSession) {
          automationSession = session({ eventId: values.eventId, enabled: false });
        }
      },
    }),
  }),
  select: () => selectQuery(),
  update: (table: unknown) => updateQuery(table),
};

mock.module("../db", () => ({
  predictionDb: {
    select: () => selectQuery(),
    update: (table: unknown) => updateQuery(table),
    transaction: (callback: (tx: typeof transactionDb) => Promise<unknown>) =>
      callback(transactionDb),
  },
}));

const { getAutomationState, runAutomationAction } = await import("./service");

beforeEach(() => {
  eventFilter = undefined;
  eventRows = [];
  automationSession = null;
  contestantRows = [];
});

afterAll(() => mock.restore());

describe("automation service", () => {
  test("selects only draft or live events for worker readiness", async () => {
    expect(await getAutomationState()).toEqual({
      event: null,
      automation: null,
      contestants: [],
      activeArena: null,
    });
    expect(eventFilter).toBeDefined();

    const query = new PgDialect().sqlToQuery(eventFilter!);
    expect(query.params).toEqual(["draft", "live"]);
    expect(query.params).not.toContain("completed");
  });

  test("keeps pause diagnostics when routine heartbeats continue", async () => {
    automationSession = session();

    await runAutomationAction(
      {
        type: "pause",
        eventId,
        workerId: "worker-a",
        reason: "Ambiguous arena result",
        observation: { confidence: 0.51 },
        evidenceImage: "pause-evidence",
      },
      "pause-1",
    );
    await runAutomationAction(
      {
        type: "heartbeat",
        eventId,
        workerId: "worker-a",
        observation: { stream: "connected" },
        evidenceImage: "routine-evidence",
      },
      "heartbeat-1",
    );

    expect(automationSession).toMatchObject({
      paused: true,
      pauseReason: "Ambiguous arena result",
      lastObservation: { confidence: 0.51 },
      evidenceImage: "pause-evidence",
    });
  });

  test("requires explicit takeover of a stale worker lease", async () => {
    automationSession = session({ lastHeartbeatAt: new Date(0) });
    const heartbeat = {
      type: "heartbeat" as const,
      eventId,
      workerId: "worker-b",
    };

    await expect(runAutomationAction(heartbeat, "heartbeat-1")).rejects.toThrow("Request takeover");
    expect(automationSession.workerId).toBe("worker-a");

    await runAutomationAction({ ...heartbeat, takeover: true }, "heartbeat-2");
    expect(automationSession.workerId).toBe("worker-b");
  });

  test("blocks another fresh worker before a domain mutation", async () => {
    eventRows = [event("draft")];
    automationSession = session();

    await expect(
      runAutomationAction(
        {
          type: "add_contestant",
          eventId,
          workerId: "worker-b",
          displayName: "Hydra",
        },
        "contestant-1",
      ),
    ).rejects.toThrow("another worker");
  });

  test("reuses an accent-insensitive contestant identity after a worker restart", async () => {
    const now = new Date();
    const contestantId = "00000000-0000-4000-8000-000000000003";
    eventRows = [event("draft")];
    automationSession = session();
    contestantRows = [
      {
        id: contestantId,
        eventId,
        displayName: "Kaptèn",
        queuePosition: 1,
        wins: 0,
        bestStreak: 0,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      },
    ];

    const result = await runAutomationAction(
      {
        type: "add_contestant",
        eventId,
        workerId: "worker-a",
        displayName: "  KAPTEN  ",
      },
      "contestant-retry-1",
    );

    expect(result).toEqual({ id: contestantId });
  });
});
