import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  events,
  marketOutcomes,
  markets,
  portfolios,
  positions,
  tradeQuotes,
  trades,
} from "../db/schema";

type Query = Promise<unknown[]> & {
  innerJoin: (...values: unknown[]) => Query;
  where: (filter: SQL) => Query;
  orderBy: (...values: unknown[]) => Query;
  for: (mode: string) => Query;
  limit: (value: number) => Promise<unknown[]>;
};

const selectRows = new Map<object, unknown[][]>();
const inserts: Array<{ table: object; values: unknown }> = [];
const updates: Array<{ table: object; values: Record<string, unknown> }> = [];
const deletes: Array<{ table: object; filter: SQL }> = [];
const locks: object[] = [];
const filters: Array<{ table: object; filter: SQL }> = [];
const limits: Array<{ table: object; value: number }> = [];
const selectCalls: object[] = [];
const updateReturns = new Map<object, unknown[][]>();
const insertReturns = new Map<object, unknown[][]>();

function query(table: object, rows: unknown[]): Query {
  const result = Promise.resolve(rows) as Query;
  result.innerJoin = () => result;
  result.where = (filter) => {
    filters.push({ table, filter });
    return result;
  };
  result.orderBy = () => result;
  result.for = () => {
    locks.push(table);
    return result;
  };
  result.limit = (value) => {
    limits.push({ table, value });
    return Promise.resolve(rows.slice(0, value));
  };
  return result;
}

const database = {
  select: () => ({
    from: (table: object) => {
      selectCalls.push(table);
      const rows = selectRows.get(table)?.shift();
      if (!rows) throw new Error("Unexpected select in trading test.");
      return query(table, rows);
    },
  }),
  selectDistinct: () => ({
    from: (table: object) => {
      selectCalls.push(table);
      const rows = selectRows.get(table)?.shift();
      if (!rows) throw new Error("Unexpected distinct select in trading test.");
      return query(table, rows);
    },
  }),
  insert: (table: object) => ({
    values: (values: unknown) => {
      inserts.push({ table, values });
      return {
        onConflictDoNothing: () => Promise.resolve(),
        onConflictDoUpdate: () => Promise.resolve(),
        returning: () => Promise.resolve(insertReturns.get(table)?.shift() ?? []),
      };
    },
  }),
  update: (table: object) => ({
    set: (values: Record<string, unknown>) => {
      updates.push({ table, values });
      return {
        where: () => ({
          returning: () => Promise.resolve(updateReturns.get(table)?.shift() ?? []),
        }),
      };
    },
  }),
  delete: (table: object) => ({
    where: (filter: SQL) => {
      deletes.push({ table, filter });
      return Promise.resolve();
    },
  }),
};

mock.module("../db", () => ({
  predictionDb: {
    ...database,
    transaction: <T>(callback: (transaction: typeof database) => Promise<T>) => callback(database),
  },
}));

const {
  createTradeQuote,
  executeTrade,
  getAffectedViewerAccountSnapshots,
  getPredictionSnapshot,
  getViewerAccountSnapshot,
} = await import("./trading");
const previousEnabled = process.env.PREDICTION_MARKETS_ENABLED;
process.env.PREDICTION_MARKETS_ENABLED = "true";

beforeEach(() => {
  selectRows.clear();
  inserts.length = 0;
  updates.length = 0;
  deletes.length = 0;
  locks.length = 0;
  filters.length = 0;
  limits.length = 0;
  selectCalls.length = 0;
  updateReturns.clear();
  insertReturns.clear();
});

afterAll(() => {
  if (previousEnabled === undefined) delete process.env.PREDICTION_MARKETS_ENABLED;
  else process.env.PREDICTION_MARKETS_ENABLED = previousEnabled;
  mock.restore();
});

const eventId = "00000000-0000-4000-8000-000000000001";
const marketId = "00000000-0000-4000-8000-000000000010";
const outcomeId = "00000000-0000-4000-8000-000000000011";
const userId = "viewer-1";
const portfolio = {
  id: "00000000-0000-4000-8000-000000000020",
  eventId,
  userId,
  availableCrowns: "9000.00000000",
  settlementDebt: "25.00000000",
};
const openMarket = {
  id: marketId,
  eventId,
  version: 1,
  kind: "live_arena",
  status: "open",
  title: "Arena winner",
  locksAt: null,
  liquidity: "1000.00000000",
};
const openOutcomes = [
  {
    id: outcomeId,
    marketId,
    label: "Wins",
    quantity: "0.00000000",
    settlementValue: null,
  },
  {
    id: "00000000-0000-4000-8000-000000000012",
    marketId,
    label: "Loses",
    quantity: "0.00000000",
    settlementValue: null,
  },
];

describe("prediction trading lifecycle", () => {
  test("reuses an existing portfolio without conflict writes", async () => {
    selectRows.set(events, [[{ id: eventId, status: "live" }]]);
    selectRows.set(portfolios, [[portfolio]]);
    selectRows.set(markets, [[]]);
    selectRows.set(positions, [[]]);

    expect(await getViewerAccountSnapshot(userId)).toEqual({
      eventId,
      portfolio: {
        availableCrowns: portfolio.availableCrowns,
        equity: "8975.00000000",
      },
      sharesByOutcome: {},
    });
    expect(inserts).toHaveLength(0);
  });

  test("loads a viewer's final account after the event completes", async () => {
    selectRows.set(events, [[{ id: eventId, status: "completed" }]]);
    selectRows.set(portfolios, [[portfolio]]);
    selectRows.set(markets, [[{ ...openMarket, status: "settled" }]]);
    selectRows.set(marketOutcomes, [openOutcomes]);
    selectRows.set(positions, [[{ outcomeId, shares: "25.00000000" }]]);

    expect(await getViewerAccountSnapshot(userId)).toEqual({
      eventId,
      portfolio: {
        availableCrowns: portfolio.availableCrowns,
        equity: "8975.00000000",
      },
      sharesByOutcome: { [outcomeId]: "25.00000000" },
    });
    expect(inserts).toHaveLength(0);
  });

  test("projects 1,000 affected accounts with four database reads", async () => {
    const affectedPortfolios = Array.from({ length: 1_000 }, (_, index) => ({
      portfolioId: `portfolio-${index}`,
      userId: `user-${index}`,
      availableCrowns: `${10_000 + index}.00000000`,
      settlementDebt: "0.00000000",
    }));
    const settledMarket = { ...openMarket, status: "settled" };
    const positionRows = affectedPortfolios.map(({ portfolioId }) => ({
      portfolioId,
      outcomeId,
      shares: "25.00000000",
    }));
    selectRows.set(portfolios, [affectedPortfolios]);
    selectRows.set(markets, [[settledMarket]]);
    selectRows.set(marketOutcomes, [openOutcomes]);
    selectRows.set(positions, [positionRows]);

    const updates = await getAffectedViewerAccountSnapshots(eventId, [marketId]);

    expect(updates).toHaveLength(1_000);
    expect(updates[999]).toEqual({
      userId: "user-999",
      account: {
        eventId,
        portfolio: { availableCrowns: "10999.00000000", equity: "10999.00000000" },
        sharesByOutcome: { [outcomeId]: "25.00000000" },
      },
    });
    expect(selectCalls).toEqual([portfolios, markets, marketOutcomes, positions]);
  });

  test("rejects a quote for an open market whose event is completed", async () => {
    selectRows.set(markets, [
      [{ id: marketId, eventId, status: "open", version: 1, liquidity: "1000.00000000" }],
    ]);
    selectRows.set(events, [[{ status: "completed" }]]);

    await expect(
      createTradeQuote({ userId, marketId, outcomeId, side: "buy", amount: "100" }),
    ).rejects.toThrow("event is not live");
    expect(inserts).toHaveLength(0);
  });

  test("rate limits quote creation before loading market outcomes", async () => {
    selectRows.set(markets, [[openMarket]]);
    selectRows.set(events, [[{ status: "live" }]]);
    selectRows.set(portfolios, [[portfolio], [portfolio]]);
    selectRows.set(tradeQuotes, [[], [{ recent: 20 }]]);

    await expect(
      createTradeQuote({ userId, marketId, outcomeId, side: "buy", amount: "100" }),
    ).rejects.toThrow("Too many quote requests");

    expect(selectRows.get(marketOutcomes)).toBeUndefined();
    expect(inserts).toHaveLength(0);
    expect(locks).toContain(portfolios);
  });

  test("caps unconsumed quotes per portfolio", async () => {
    selectRows.set(markets, [[openMarket]]);
    selectRows.set(events, [[{ status: "live" }]]);
    selectRows.set(portfolios, [[portfolio], [portfolio]]);
    selectRows.set(tradeQuotes, [[], [{ recent: 4 }], [{ outstanding: 5 }]]);

    await expect(
      createTradeQuote({ userId, marketId, outcomeId, side: "buy", amount: "100" }),
    ).rejects.toThrow("Too many active quotes");

    expect(selectRows.get(marketOutcomes)).toBeUndefined();
    expect(inserts).toHaveLength(0);
  });

  test("deletes at most one bounded batch of expired quotes", async () => {
    const expired = Array.from({ length: 101 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    const quoteRecord = {
      id: "00000000-0000-4000-8000-000000000030",
      marketId,
      marketVersion: 1,
      side: "buy",
      outcomeId,
      crownAmount: "100.00000000",
      shareAmount: "190.00000000",
      averagePrice: "0.52631579",
      expiresAt: new Date(Date.now() + 10_000),
    };
    selectRows.set(markets, [[openMarket]]);
    selectRows.set(events, [[{ status: "live" }]]);
    selectRows.set(portfolios, [[portfolio], [portfolio]]);
    selectRows.set(tradeQuotes, [expired, [{ recent: 0 }], [{ outstanding: 0 }]]);
    selectRows.set(marketOutcomes, [openOutcomes]);
    insertReturns.set(tradeQuotes, [[quoteRecord]]);

    const quote = await createTradeQuote({
      userId,
      marketId,
      outcomeId,
      side: "buy",
      amount: "100",
    });

    expect(quote.id).toBe(quoteRecord.id);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.table).toBe(tradeQuotes);
    expect(limits).toContainEqual({ table: tradeQuotes, value: 100 });
  });

  test("locks the market and rejects execution after its event completes", async () => {
    const market = { id: marketId, eventId, status: "open", version: 1 };
    const quote = {
      id: "00000000-0000-4000-8000-000000000030",
      portfolioId: portfolio.id,
      marketId,
      outcomeId,
      marketVersion: 1,
      side: "buy",
      crownAmount: "100.00000000",
      shareAmount: "190.00000000",
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    };
    selectRows.set(trades, [[], [{ recent: 0 }]]);
    selectRows.set(tradeQuotes, [[{ quote, portfolio }]]);
    selectRows.set(markets, [[market]]);
    selectRows.set(events, [[{ status: "completed" }]]);

    await expect(
      executeTrade({ userId, quoteId: quote.id, idempotencyKey: "trade-key-1" }),
    ).rejects.toThrow("event is not live");
    expect(locks).toEqual([markets]);
    expect(updates).toHaveLength(0);
  });

  test("uses sale proceeds to repay settlement debt before restoring spendable crowns", async () => {
    const market = { id: marketId, eventId, status: "open", version: 1 };
    const indebtedPortfolio = {
      ...portfolio,
      availableCrowns: "0.00000000",
      settlementDebt: "100.00000000",
    };
    const quote = {
      id: "00000000-0000-4000-8000-000000000030",
      portfolioId: portfolio.id,
      marketId,
      outcomeId,
      marketVersion: 1,
      side: "sell",
      crownAmount: "50.00000000",
      shareAmount: "100.00000000",
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
    };
    selectRows.set(trades, [[], [{ recent: 0 }]]);
    selectRows.set(tradeQuotes, [[{ quote, portfolio: indebtedPortfolio }]]);
    selectRows.set(markets, [[market]]);
    selectRows.set(events, [[{ status: "live" }]]);
    selectRows.set(positions, [[{ portfolioId: portfolio.id, outcomeId, shares: "100" }]]);
    updateReturns.set(tradeQuotes, [[{ id: quote.id }]]);
    updateReturns.set(markets, [[{ id: marketId }]]);
    insertReturns.set(trades, [[{ id: "00000000-0000-4000-8000-000000000040" }]]);

    await executeTrade({ userId, quoteId: quote.id, idempotencyKey: "trade-key-2" });

    const balanceUpdate = updates.find(({ table }) => table === portfolios);
    expect(balanceUpdate).toBeDefined();
    expect(balanceUpdate!.values).toHaveProperty("settlementDebt");
    expect(locks).toEqual([markets]);
  });

  test("realizes settled positions before ranking every portfolio by equity", async () => {
    const event = {
      id: eventId,
      name: "KOTH",
      season: 2,
      week: 2,
      status: "live",
      startingCrowns: "10000.00000000",
    };
    const openMarket = {
      id: marketId,
      eventId,
      version: 1,
      kind: "event_winner",
      status: "open",
      title: "Event winner",
      locksAt: null,
      liquidity: "1000.00000000",
    };
    const settledMarket = {
      ...openMarket,
      id: "00000000-0000-4000-8000-000000000012",
      kind: "live_arena",
      status: "settled",
      title: "Arena result",
    };
    const openOutcomes = [
      { id: outcomeId, marketId, label: "Hydra", quantity: "0", settlementValue: null },
      {
        id: "00000000-0000-4000-8000-000000000013",
        marketId,
        label: "Rival",
        quantity: "0",
        settlementValue: null,
      },
    ];
    const settledOutcomes = [
      {
        id: "00000000-0000-4000-8000-000000000014",
        marketId: settledMarket.id,
        label: "Wins",
        quantity: "200",
        settlementValue: "1.00000000",
      },
      {
        id: "00000000-0000-4000-8000-000000000015",
        marketId: settledMarket.id,
        label: "Loses",
        quantity: "0",
        settlementValue: "0.00000000",
      },
    ];
    const viewerPositions = [
      { portfolioId: portfolio.id, outcomeId, shares: "100.00000000" },
      {
        portfolioId: portfolio.id,
        outcomeId: settledOutcomes[0]!.id,
        shares: "100.00000000",
      },
    ];
    const lowCashPortfolioId = "00000000-0000-4000-8000-000000000099";
    const leaderboardRows = [
      {
        portfolioId: portfolio.id,
        userId,
        name: "Viewer",
        crowns: portfolio.availableCrowns,
        settlementDebt: portfolio.settlementDebt,
      },
      ...Array.from({ length: 49 }, (_, index) => ({
        portfolioId: `normal-${index}`,
        userId: `normal-user-${index}`,
        name: `Normal ${index}`,
        crowns: "10000.00000000",
        settlementDebt: "0.00000000",
      })),
      {
        portfolioId: lowCashPortfolioId,
        userId: "equity-leader",
        name: "Equity leader",
        crowns: "1.00000000",
        settlementDebt: "0.00000000",
      },
    ];
    const leaderboardPositions = [
      ...viewerPositions,
      { portfolioId: lowCashPortfolioId, outcomeId, shares: "30000.00000000" },
    ];

    selectRows.set(events, [[event], [event]]);
    selectRows.set(portfolios, [[portfolio], leaderboardRows, []]);
    selectRows.set(markets, [[openMarket, settledMarket]]);
    selectRows.set(marketOutcomes, [[...openOutcomes, ...settledOutcomes]]);
    selectRows.set(positions, [viewerPositions, leaderboardPositions]);

    const snapshot = await getPredictionSnapshot(userId);

    expect(snapshot.portfolio?.equity).toBe("9025.00000000");
    expect(snapshot.markets.find(({ id }) => id === settledMarket.id)?.outcomes).toEqual([
      expect.objectContaining({ label: "Wins", probability: 1 }),
      expect.objectContaining({ label: "Loses", probability: 0 }),
    ]);
    expect(snapshot.leaderboard).toHaveLength(50);
    expect(snapshot.leaderboard[0]?.userId).toBe("equity-leader");
  });

  test("keeps final standings visible and scopes the season query", async () => {
    const completedEvent = {
      id: eventId,
      name: "KOTH",
      season: 2,
      week: 2,
      status: "completed",
      startingCrowns: "10000.00000000",
    };
    const leaderboardRow = {
      portfolioId: portfolio.id,
      userId,
      name: "Viewer",
      crowns: portfolio.availableCrowns,
      settlementDebt: portfolio.settlementDebt,
      startingCrowns: completedEvent.startingCrowns,
    };
    selectRows.set(events, [[completedEvent]]);
    selectRows.set(markets, [[]]);
    selectRows.set(portfolios, [[leaderboardRow], [leaderboardRow]]);
    selectRows.set(positions, [[]]);
    selectRows.set(trades, [[{ portfolioId: portfolio.id }]]);

    const snapshot = await getPredictionSnapshot();

    expect(snapshot.event).toMatchObject({ id: eventId, status: "completed" });
    expect(snapshot.leaderboard).toEqual([
      expect.objectContaining({ userId, equity: "8975.00000000" }),
    ]);
    expect(snapshot.seasonLeaderboard).toEqual([
      { userId, name: "Viewer", score: "-10.25", eventsPlayed: 1 },
    ]);
    const dialect = new PgDialect();
    const completedSeasonQuery = filters
      .filter(({ table }) => table === portfolios)
      .map(({ filter }) => dialect.sqlToQuery(filter).sql)
      .find((query) => query.includes('"event"."status"'));
    expect(completedSeasonQuery).toContain('"event"."season" =');
  });
});
