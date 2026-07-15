import { afterAll, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  arenas,
  contestants,
  domainEvents,
  events,
  ledgerEntries,
  marketOutcomes,
  markets,
  portfolios,
  positions,
} from "../db/schema";

type Query = Promise<unknown[]> & {
  where: (filter: SQL) => Query;
  for: (mode: string) => Query;
  orderBy: (...values: unknown[]) => Query;
  limit: (value: number) => Promise<unknown[]>;
};

type Update = {
  table: object;
  values: Record<string, unknown>;
  filter: SQL;
};

type Insert = {
  table: object;
  values: unknown;
};

type Delete = {
  table: object;
  filter: SQL;
};

const eventId = "00000000-0000-4000-8000-000000000001";
const winnerMarket = { id: "00000000-0000-4000-8000-000000000010", status: "open" };
const openThreshold = { id: "00000000-0000-4000-8000-000000000020", status: "open" };
const lockedThreshold = { id: "00000000-0000-4000-8000-000000000030", status: "locked" };
const winnerOutcomes = [
  {
    id: "00000000-0000-4000-8000-000000000011",
    label: "Hydra",
    contestantId: "00000000-0000-4000-8000-000000000002",
  },
  {
    id: "00000000-0000-4000-8000-000000000012",
    label: "Rival",
    contestantId: "00000000-0000-4000-8000-000000000003",
  },
];
const openThresholdOutcomes = [
  { id: "00000000-0000-4000-8000-000000000021", label: "Yes" },
  { id: "00000000-0000-4000-8000-000000000022", label: "No" },
];
const lockedThresholdOutcomes = [
  { id: "00000000-0000-4000-8000-000000000031", label: "Yes" },
  { id: "00000000-0000-4000-8000-000000000032", label: "No" },
];

const selectRows = new Map<object, unknown[][]>();
const selectFilters: Array<{ table: object; filter: SQL }> = [];
const selectLocks: Array<{ table: object; filter?: SQL }> = [];
const updates: Update[] = [];
const inserts: Insert[] = [];
const deletes: Delete[] = [];
const executions: SQL[] = [];
const insertReturns = new Map<object, unknown[][]>();

function queueSelects(): void {
  selectRows.clear();
  selectRows.set(domainEvents, [[]]);
  selectRows.set(events, [[{ id: eventId, status: "live" }]]);
  selectRows.set(arenas, [[]]);
  selectRows.set(contestants, [
    [
      {
        id: winnerOutcomes[0]!.contestantId,
        bestStreak: 4,
      },
      {
        id: winnerOutcomes[1]!.contestantId,
        bestStreak: 2,
      },
    ],
  ]);
  selectRows.set(markets, [
    [winnerMarket],
    [winnerMarket],
    [openThreshold, lockedThreshold],
    [openThreshold],
    [lockedThreshold],
  ]);
  selectRows.set(marketOutcomes, [
    winnerOutcomes,
    winnerOutcomes,
    openThresholdOutcomes,
    openThresholdOutcomes,
    lockedThresholdOutcomes,
    lockedThresholdOutcomes,
  ]);
  selectRows.set(positions, [[], [], []]);
}

function query(table: object, rows: unknown[]): Query {
  const result = Promise.resolve(rows) as Query;
  let currentFilter: SQL | undefined;
  result.where = (filter) => {
    currentFilter = filter;
    selectFilters.push({ table, filter });
    return result;
  };
  result.for = () => {
    selectLocks.push({ table, filter: currentFilter });
    return result;
  };
  result.orderBy = () => result;
  result.limit = () => Promise.resolve(rows);
  return result;
}

const tx = {
  execute: (statement: SQL) => {
    executions.push(statement);
    return Promise.resolve([]);
  },
  select: () => ({
    from: (table: object) => {
      const rows = selectRows.get(table)?.shift();
      if (!rows) throw new Error("Unexpected select in operator completion test.");
      return query(table, rows);
    },
  }),
  update: (table: object) => ({
    set: (values: Record<string, unknown>) => ({
      where: (filter: SQL) => {
        updates.push({ table, values, filter });
        return Promise.resolve([]);
      },
    }),
  }),
  insert: (table: object) => ({
    values: (values: unknown) => {
      inserts.push({ table, values });
      return {
        returning: () =>
          Promise.resolve(
            insertReturns.get(table)?.shift() ??
              (table === domainEvents ? [{ id: "domain-event-1" }] : []),
          ),
      };
    },
  }),
  delete: (table: object) => ({
    where: (filter: SQL) => {
      deletes.push({ table, filter });
      return Promise.resolve([]);
    },
  }),
};

mock.module("../db", () => ({
  predictionDb: {
    transaction: <T>(callback: (transaction: typeof tx) => Promise<T>) => callback(tx),
  },
}));

const { runOperatorCommand } = await import("./operator");

afterAll(() => mock.restore());

function params(filter: SQL): unknown[] {
  return new PgDialect().sqlToQuery(filter).params;
}

function resetState(): void {
  selectRows.clear();
  selectFilters.length = 0;
  selectLocks.length = 0;
  updates.length = 0;
  inserts.length = 0;
  deletes.length = 0;
  executions.length = 0;
  insertReturns.clear();
}

describe("operator event completion", () => {
  test("settles open and locked thresholds to No before completing the event", async () => {
    queueSelects();
    selectFilters.length = 0;
    updates.length = 0;

    expect(
      await runOperatorCommand(null, { type: "complete_event", eventId }, "complete-event-1"),
    ).toEqual({ id: "domain-event-1" });

    const thresholdSelection = selectFilters.find(
      ({ table, filter }) => table === markets && params(filter).includes("win_threshold"),
    );
    expect(params(thresholdSelection!.filter)).toEqual([
      eventId,
      "win_threshold",
      "open",
      "locked",
    ]);

    const settledMarketIds = updates
      .filter(({ table, values }) => table === markets && values.status === "settled")
      .flatMap(({ filter }) => params(filter));
    expect(settledMarketIds).toContain(openThreshold.id);
    expect(settledMarketIds).toContain(lockedThreshold.id);

    const winningOutcomeIds = updates
      .filter(
        ({ table, values }) => table === marketOutcomes && values.settlementValue === "1.00000000",
      )
      .flatMap(({ filter }) => params(filter));
    expect(winningOutcomeIds).toContain(openThresholdOutcomes[1]!.id);
    expect(winningOutcomeIds).toContain(lockedThresholdOutcomes[1]!.id);
    expect(winningOutcomeIds).not.toContain(openThresholdOutcomes[0]!.id);
    expect(winningOutcomeIds).not.toContain(lockedThresholdOutcomes[0]!.id);

    expect(
      updates.some(({ table, values }) => table === events && values.status === "completed"),
    ).toBe(true);
  });

  test("settles arena and threshold outcomes by label while holding market locks", async () => {
    resetState();
    const contestantId = "00000000-0000-4000-8000-000000000002";
    const arenaId = "00000000-0000-4000-8000-000000000004";
    const arena = { id: arenaId, eventId, contestantId, ordinal: 1, status: "locked" };
    const liveMarket = {
      id: "00000000-0000-4000-8000-000000000040",
      arenaId,
      status: "locked",
    };
    const threshold = {
      id: "00000000-0000-4000-8000-000000000050",
      contestantId,
      kind: "win_threshold",
      status: "open",
      threshold: 1,
    };
    const arenaOutcomes = [
      { id: "00000000-0000-4000-8000-000000000042", label: "Loses" },
      { id: "00000000-0000-4000-8000-000000000041", label: "Wins" },
    ];
    const thresholdOutcomes = [
      { id: "00000000-0000-4000-8000-000000000052", label: "No" },
      { id: "00000000-0000-4000-8000-000000000051", label: "Yes" },
    ];

    selectRows.set(domainEvents, [[]]);
    selectRows.set(events, [[{ id: eventId, status: "live" }]]);
    selectRows.set(arenas, [[arena], [arena], [arena], [{ wins: 1 }]]);
    selectRows.set(markets, [[liveMarket], [liveMarket], [threshold], [threshold]]);
    selectRows.set(marketOutcomes, [
      arenaOutcomes,
      arenaOutcomes,
      thresholdOutcomes,
      thresholdOutcomes,
    ]);
    selectRows.set(positions, [
      [
        {
          portfolioId: "00000000-0000-4000-8000-000000000070",
          shares: "100.00000000",
          outcomeId: arenaOutcomes[1]!.id,
        },
      ],
      [],
    ]);

    await runOperatorCommand(
      null,
      { type: "record_result", eventId, arenaId, contestantWon: true },
      "record-result-1",
    );

    const winningOutcomeIds = updates
      .filter(
        ({ table, values }) => table === marketOutcomes && values.settlementValue === "1.00000000",
      )
      .flatMap(({ filter }) => params(filter));
    expect(winningOutcomeIds).toContain(arenaOutcomes[1]!.id);
    expect(winningOutcomeIds).toContain(thresholdOutcomes[1]!.id);
    expect(winningOutcomeIds).not.toContain(arenaOutcomes[0]!.id);
    expect(winningOutcomeIds).not.toContain(thresholdOutcomes[0]!.id);
    expect(selectLocks.filter(({ table }) => table === markets)).toHaveLength(2);
    const payout = updates.find(
      ({ table, values }) => table === portfolios && "settlementDebt" in values,
    );
    expect(payout).toBeDefined();
    expect(new PgDialect().sqlToQuery(payout!.values.settlementDebt as SQL).sql).toContain(
      "settlement_debt",
    );
  });

  test("makes event creation retry-safe and rejects another active event", async () => {
    resetState();
    selectRows.set(domainEvents, [[], [{ id: "domain-event-1" }]]);
    selectRows.set(events, [[]]);

    const command = { type: "create_event", name: "KOTH", season: 2, week: 2 } as const;
    expect(await runOperatorCommand("admin-1", command, "create-event-1")).toEqual({
      id: "domain-event-1",
    });
    expect(await runOperatorCommand("admin-1", command, "create-event-1")).toEqual({
      id: "domain-event-1",
    });
    expect(inserts.filter(({ table }) => table === events)).toHaveLength(1);
    expect(executions).toHaveLength(2);

    resetState();
    selectRows.set(domainEvents, [[]]);
    selectRows.set(events, [[{ id: eventId }]]);
    await expect(runOperatorCommand("admin-1", command, "create-event-2")).rejects.toThrow(
      "Finish the current draft or live event",
    );
    expect(inserts).toHaveLength(0);
  });

  test("rejects a duplicate contestant threshold", async () => {
    resetState();
    const contestantId = "00000000-0000-4000-8000-000000000002";
    selectRows.set(domainEvents, [[]]);
    selectRows.set(events, [[{ id: eventId, status: "live" }]]);
    selectRows.set(contestants, [
      [
        {
          id: contestantId,
          eventId,
          displayName: "Hydra",
          status: "active",
          wins: 2,
        },
      ],
    ]);
    selectRows.set(markets, [[{ id: "00000000-0000-4000-8000-000000000020" }]]);

    await expect(
      runOperatorCommand(
        null,
        { type: "create_threshold", eventId, contestantId, threshold: 3 },
        "threshold-1",
      ),
    ).rejects.toThrow("already exists");
    expect(inserts.filter(({ table }) => table === markets)).toHaveLength(0);
  });

  test("rechecks contestant identity while holding the event lock", async () => {
    resetState();
    const contestantId = "00000000-0000-4000-8000-000000000002";
    selectRows.set(domainEvents, [[]]);
    selectRows.set(events, [[{ id: eventId, status: "draft" }]]);
    selectRows.set(contestants, [
      [
        {
          id: contestantId,
          eventId,
          displayName: "Kaptèn",
          status: "queued",
        },
      ],
    ]);

    await expect(
      runOperatorCommand(
        null,
        { type: "add_contestant", eventId, displayName: "Kapten", queuePosition: 2 },
        "concurrent-contestant-1",
        "cv",
      ),
    ).resolves.toEqual({ id: contestantId });
    expect(selectLocks.some(({ table }) => table === events)).toBeTrue();
    expect(inserts.filter(({ table }) => table === contestants)).toHaveLength(0);
    expect(inserts.filter(({ table }) => table === domainEvents)).toHaveLength(0);
  });

  test("removes a queued draft contestant before winner-market creation", async () => {
    resetState();
    const contestantId = "00000000-0000-4000-8000-000000000002";
    selectRows.set(domainEvents, [[]]);
    selectRows.set(events, [[{ id: eventId, status: "draft" }]]);
    selectRows.set(contestants, [
      [
        {
          id: contestantId,
          eventId,
          displayName: "Hydra",
          status: "queued",
          wins: 0,
        },
      ],
    ]);

    await runOperatorCommand(
      null,
      { type: "remove_contestant", eventId, contestantId },
      "remove-contestant-1",
      "cv",
    );

    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.table).toBe(contestants);
    expect(params(deletes[0]!.filter)).toEqual([contestantId]);
    expect(inserts.find(({ table }) => table === domainEvents)?.values).toMatchObject({
      type: "remove_contestant",
      source: "cv",
    });
  });

  test("creates the event-winner and live-arena markets and locks the active arena", async () => {
    resetState();
    const contestantId = "00000000-0000-4000-8000-000000000002";
    const rivalId = "00000000-0000-4000-8000-000000000003";
    const arenaId = "00000000-0000-4000-8000-000000000004";
    const liveMarketId = "00000000-0000-4000-8000-000000000040";
    const roster = [
      { id: contestantId, displayName: "Hydra" },
      { id: rivalId, displayName: "Rival" },
    ];

    selectRows.set(domainEvents, [[]]);
    selectRows.set(events, [[{ id: eventId, status: "draft" }]]);
    selectRows.set(contestants, [roster]);
    insertReturns.set(markets, [[winnerMarket]]);
    await runOperatorCommand(null, { type: "activate_event", eventId }, "activate-event-1");

    expect(
      inserts.find(
        ({ table, values }) =>
          table === markets && (values as { kind?: string }).kind === "event_winner",
      )?.values,
    ).toMatchObject({ status: "open" });
    expect(
      inserts.find(
        ({ table, values }) =>
          table === marketOutcomes && Array.isArray(values) && values.length === 2,
      )?.values,
    ).toEqual([
      { marketId: winnerMarket.id, contestantId, label: "Hydra" },
      { marketId: winnerMarket.id, contestantId: rivalId, label: "Rival" },
    ]);

    resetState();
    const contestant = {
      id: contestantId,
      eventId,
      displayName: "Hydra",
      status: "queued",
      wins: 0,
    };
    const arena = { id: arenaId, eventId, contestantId, ordinal: 1, status: "open" };
    const liveMarket = { id: liveMarketId, eventId, arenaId, contestantId, status: "open" };
    selectRows.set(domainEvents, [[]]);
    selectRows.set(events, [[{ id: eventId, status: "live" }]]);
    selectRows.set(contestants, [[contestant]]);
    selectRows.set(arenas, [[], [{ total: 0 }]]);
    insertReturns.set(arenas, [[arena]]);
    insertReturns.set(markets, [[liveMarket]]);
    await runOperatorCommand(
      null,
      { type: "open_arena", eventId, contestantId },
      "open-arena-1",
      "cv",
    );

    expect(
      inserts.find(
        ({ table, values }) =>
          table === markets && (values as { kind?: string }).kind === "live_arena",
      )?.values,
    ).toMatchObject({ arenaId, contestantId, status: "open" });
    expect(
      inserts.find(
        ({ table, values }) =>
          table === marketOutcomes && Array.isArray(values) && values[0]?.marketId === liveMarketId,
      )?.values,
    ).toEqual([
      { marketId: liveMarketId, contestantId, label: "Wins" },
      { marketId: liveMarketId, contestantId, label: "Loses" },
    ]);

    resetState();
    selectRows.set(domainEvents, [[]]);
    selectRows.set(events, [[{ id: eventId, status: "live" }]]);
    selectRows.set(arenas, [[arena], [arena]]);
    await runOperatorCommand(
      null,
      { type: "start_arena", eventId, arenaId },
      "start-arena-1",
      "cv",
    );

    expect(updates.find(({ table }) => table === arenas)?.values).toMatchObject({
      status: "locked",
    });
    expect(updates.find(({ table }) => table === markets)?.values).toMatchObject({
      status: "locked",
    });
  });

  test("tracks settlement reversal shortfalls as debt without a negative balance", async () => {
    resetState();
    const contestantId = "00000000-0000-4000-8000-000000000002";
    const arenaId = "00000000-0000-4000-8000-000000000004";
    const arena = { id: arenaId, eventId, contestantId, ordinal: 1, status: "settled" };
    const liveMarket = {
      id: "00000000-0000-4000-8000-000000000040",
      arenaId,
      status: "locked",
    };
    const arenaOutcomes = [
      { id: "00000000-0000-4000-8000-000000000041", label: "Wins" },
      { id: "00000000-0000-4000-8000-000000000042", label: "Loses" },
    ];

    selectRows.set(domainEvents, [[]]);
    selectRows.set(events, [[{ id: eventId, status: "live" }]]);
    selectRows.set(arenas, [[arena], [], [], [arena], [{ wins: 0 }]]);
    selectRows.set(markets, [[liveMarket], [], [liveMarket], [liveMarket], []]);
    selectRows.set(ledgerEntries, [
      [
        {
          id: "00000000-0000-4000-8000-000000000060",
          portfolioId: "00000000-0000-4000-8000-000000000070",
          amount: "100.00000000",
        },
      ],
    ]);
    selectRows.set(marketOutcomes, [arenaOutcomes, arenaOutcomes]);
    selectRows.set(positions, [[]]);

    await runOperatorCommand(
      null,
      { type: "correct_result", eventId, arenaId, contestantWon: false },
      "correct-result-1",
    );

    const reversal = updates.find(
      ({ table, values }) => table === portfolios && "settlementDebt" in values,
    );
    expect(reversal).toBeDefined();
    const available = new PgDialect().sqlToQuery(reversal!.values.availableCrowns as SQL).sql;
    const debt = new PgDialect().sqlToQuery(reversal!.values.settlementDebt as SQL).sql;
    expect(available).toContain("greatest");
    expect(debt).toContain("settlement_debt");
    expect(inserts.some(({ table }) => table === ledgerEntries)).toBe(true);
  });
});
