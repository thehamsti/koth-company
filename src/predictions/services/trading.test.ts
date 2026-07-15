import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SQL } from "drizzle-orm";
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
const locks: object[] = [];
const updateReturns = new Map<object, unknown[][]>();
const insertReturns = new Map<object, unknown[][]>();

function query(table: object, rows: unknown[]): Query {
  const result = Promise.resolve(rows) as Query;
  result.innerJoin = () => result;
  result.where = () => result;
  result.orderBy = () => result;
  result.for = () => {
    locks.push(table);
    return result;
  };
  result.limit = () => Promise.resolve(rows);
  return result;
}

const database = {
  select: () => ({
    from: (table: object) => {
      const rows = selectRows.get(table)?.shift();
      if (!rows) throw new Error("Unexpected select in trading test.");
      return query(table, rows);
    },
  }),
  selectDistinct: () => ({
    from: (table: object) => {
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
};

mock.module("../db", () => ({
  predictionDb: {
    ...database,
    transaction: <T>(callback: (transaction: typeof database) => Promise<T>) => callback(database),
  },
}));

const { createTradeQuote, executeTrade, getPredictionSnapshot } = await import("./trading");
const previousEnabled = process.env.PREDICTION_MARKETS_ENABLED;
process.env.PREDICTION_MARKETS_ENABLED = "true";

beforeEach(() => {
  selectRows.clear();
  inserts.length = 0;
  updates.length = 0;
  locks.length = 0;
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

describe("prediction trading lifecycle", () => {
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
});
