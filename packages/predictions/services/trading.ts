import Decimal from "decimal.js";
import { and, count, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { predictionDb } from "../db";
import {
  events,
  ledgerEntries,
  marketOutcomes,
  markets,
  portfolios,
  positions,
  tradeQuotes,
  trades,
  user,
} from "../db/schema";
import { getPrices, quoteBuy, quoteSell } from "../market/lmsr";
import { PredictionError, type PredictionSnapshot, type TradeQuote } from "../types";
import type {
  PredictionPublicSnapshot,
  PublicMarketSnapshot,
  ViewerAccountSnapshot,
} from "../../contracts/src";

const amount = (value: Decimal.Value): string => new Decimal(value).toDecimalPlaces(8).toFixed(8);
const QUOTE_RATE_WINDOW_MS = 10_000;
const MAX_QUOTES_PER_WINDOW = 20;
const MAX_OUTSTANDING_QUOTES = 5;
const EXPIRED_QUOTE_CLEANUP_LIMIT = 100;

function assertEnabled(): void {
  if (process.env.PREDICTION_MARKETS_ENABLED !== "true") {
    throw new PredictionError("FEATURE_DISABLED", "Predictions are not enabled yet.", 404);
  }
}

async function getOrCreatePortfolio(eventId: string, userId: string) {
  const [existing] = await predictionDb
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.eventId, eventId), eq(portfolios.userId, userId)))
    .limit(1);
  if (existing) return existing;
  const [event] = await predictionDb.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event)
    throw new PredictionError("EVENT_NOT_FOUND", "The active event no longer exists.", 404);
  await predictionDb
    .insert(portfolios)
    .values({ eventId, userId, availableCrowns: event.startingCrowns })
    .onConflictDoNothing({ target: [portfolios.eventId, portfolios.userId] });
  const [portfolio] = await predictionDb
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.eventId, eventId), eq(portfolios.userId, userId)))
    .limit(1);
  if (!portfolio) throw new Error("Portfolio creation failed.");
  return portfolio;
}

async function getPortfolioForSnapshot(
  eventId: string,
  userId: string | undefined,
  eventStatus: string,
) {
  if (!userId) return null;
  if (eventStatus !== "completed") return getOrCreatePortfolio(eventId, userId);
  const [portfolio] = await predictionDb
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.eventId, eventId), eq(portfolios.userId, userId)))
    .limit(1);
  return portfolio ?? null;
}

export async function getPredictionSnapshot(userId?: string): Promise<PredictionSnapshot> {
  if (process.env.PREDICTION_MARKETS_ENABLED !== "true") {
    return {
      enabled: false,
      event: null,
      portfolio: null,
      markets: [],
      leaderboard: [],
      seasonLeaderboard: [],
    };
  }
  const [event] = await predictionDb
    .select()
    .from(events)
    .where(inArray(events.status, ["live", "draft", "completed"]))
    .orderBy(
      sql`case when ${events.status} in ('live', 'draft') then 0 else 1 end`,
      desc(events.createdAt),
    )
    .limit(1);
  if (!event) {
    return {
      enabled: true,
      event: null,
      portfolio: null,
      markets: [],
      leaderboard: [],
      seasonLeaderboard: [],
    };
  }

  const portfolio = await getPortfolioForSnapshot(event.id, userId, event.status);
  const marketRows = await predictionDb
    .select()
    .from(markets)
    .where(eq(markets.eventId, event.id))
    .orderBy(desc(markets.createdAt));
  const outcomeRows = marketRows.length
    ? await predictionDb
        .select()
        .from(marketOutcomes)
        .where(
          inArray(
            marketOutcomes.marketId,
            marketRows.map((market) => market.id),
          ),
        )
    : [];
  const positionRows = portfolio
    ? await predictionDb.select().from(positions).where(eq(positions.portfolioId, portfolio.id))
    : [];
  const shareByOutcome = new Map(
    positionRows.map((position) => [position.outcomeId, position.shares]),
  );

  const outcomesByMarket = new Map<string, (typeof outcomeRows)[number][]>();
  for (const outcome of outcomeRows) {
    const grouped = outcomesByMarket.get(outcome.marketId) ?? [];
    grouped.push(outcome);
    outcomesByMarket.set(outcome.marketId, grouped);
  }
  const priceByOutcome = new Map<string, Decimal>();
  const marketSnapshots = marketRows.map((market) => {
    const outcomes = outcomesByMarket.get(market.id) ?? [];
    const prices =
      market.status === "settled"
        ? outcomes.map((outcome) => new Decimal(outcome.settlementValue ?? 0))
        : getPrices(
            outcomes.map((outcome) => outcome.quantity),
            market.liquidity,
          );
    outcomes.forEach((outcome, index) => {
      priceByOutcome.set(
        outcome.id,
        market.status === "settled" ? new Decimal(0) : (prices[index] ?? new Decimal(0)),
      );
    });
    return {
      id: market.id,
      version: market.version,
      kind: market.kind,
      status: market.status,
      title: market.title,
      locksAt: market.locksAt?.toISOString() ?? null,
      outcomes: outcomes.map((outcome, index) => ({
        id: outcome.id,
        label: outcome.label,
        probability: prices[index]?.toNumber() ?? 0,
        viewerShares: shareByOutcome.get(outcome.id) ?? "0",
      })),
    };
  });

  const leaderboardRows = await predictionDb
    .select({
      portfolioId: portfolios.id,
      userId: portfolios.userId,
      name: user.name,
      crowns: portfolios.availableCrowns,
      settlementDebt: portfolios.settlementDebt,
    })
    .from(portfolios)
    .innerJoin(user, eq(user.id, portfolios.userId))
    .where(eq(portfolios.eventId, event.id));
  const leaderboardPositions = leaderboardRows.length
    ? await predictionDb
        .select({
          portfolioId: positions.portfolioId,
          outcomeId: positions.outcomeId,
          shares: positions.shares,
        })
        .from(positions)
        .where(
          inArray(
            positions.portfolioId,
            leaderboardRows.map((row) => row.portfolioId),
          ),
        )
    : [];
  const positionsByPortfolio = new Map<string, typeof leaderboardPositions>();
  for (const position of leaderboardPositions) {
    const grouped = positionsByPortfolio.get(position.portfolioId) ?? [];
    grouped.push(position);
    positionsByPortfolio.set(position.portfolioId, grouped);
  }
  const equityFor = (
    portfolioId: string,
    availableCrowns: string,
    settlementDebt: string,
  ): Decimal =>
    (positionsByPortfolio.get(portfolioId) ?? []).reduce(
      (equity, position) =>
        equity.plus(new Decimal(position.shares).mul(priceByOutcome.get(position.outcomeId) ?? 0)),
      new Decimal(availableCrowns).minus(settlementDebt),
    );
  const viewerEquity = portfolio
    ? equityFor(portfolio.id, portfolio.availableCrowns, portfolio.settlementDebt)
    : null;

  const completedRows = await predictionDb
    .select({
      portfolioId: portfolios.id,
      userId: portfolios.userId,
      name: user.name,
      crowns: portfolios.availableCrowns,
      settlementDebt: portfolios.settlementDebt,
      startingCrowns: events.startingCrowns,
    })
    .from(portfolios)
    .innerJoin(user, eq(user.id, portfolios.userId))
    .innerJoin(events, eq(events.id, portfolios.eventId))
    .where(and(eq(events.status, "completed"), eq(events.season, event.season)));
  const tradedPortfolioRows = completedRows.length
    ? await predictionDb
        .selectDistinct({ portfolioId: trades.portfolioId })
        .from(trades)
        .where(
          inArray(
            trades.portfolioId,
            completedRows.map((row) => row.portfolioId),
          ),
        )
    : [];
  const tradedPortfolioIds = new Set(tradedPortfolioRows.map((row) => row.portfolioId));
  const seasonByUser = new Map<string, { name: string; score: Decimal; eventsPlayed: number }>();
  for (const row of completedRows) {
    if (!tradedPortfolioIds.has(row.portfolioId)) continue;
    const current = seasonByUser.get(row.userId) ?? {
      name: row.name,
      score: new Decimal(0),
      eventsPlayed: 0,
    };
    current.score = current.score.plus(
      new Decimal(row.crowns)
        .minus(row.settlementDebt)
        .minus(row.startingCrowns)
        .div(row.startingCrowns)
        .mul(100),
    );
    current.eventsPlayed += 1;
    seasonByUser.set(row.userId, current);
  }

  return {
    enabled: true,
    event: {
      id: event.id,
      name: event.name,
      season: event.season,
      week: event.week,
      status: event.status,
    },
    portfolio: portfolio
      ? {
          availableCrowns: portfolio.availableCrowns,
          equity: viewerEquity?.toFixed(8) ?? portfolio.availableCrowns,
        }
      : null,
    markets: marketSnapshots,
    leaderboard: leaderboardRows
      .map((row) => {
        const equity = equityFor(row.portfolioId, row.crowns, row.settlementDebt);
        return {
          userId: row.userId,
          name: row.name,
          equity: equity.toFixed(8),
          returnPercent: equity
            .minus(event.startingCrowns)
            .div(event.startingCrowns)
            .mul(100)
            .toFixed(2),
        };
      })
      .sort((left, right) => Number(right.equity) - Number(left.equity))
      .slice(0, 50),
    seasonLeaderboard: [...seasonByUser.entries()]
      .map(([userId, row]) => ({
        userId,
        name: row.name,
        score: row.score.toFixed(2),
        eventsPlayed: row.eventsPlayed,
      }))
      .sort((left, right) => Number(right.score) - Number(left.score)),
  };
}

export function projectPublicSnapshot(snapshot: PredictionSnapshot): PredictionPublicSnapshot {
  return {
    enabled: snapshot.enabled,
    event: snapshot.event,
    markets: snapshot.markets.map((market) => ({
      ...market,
      outcomes: market.outcomes.map(({ viewerShares: _viewerShares, ...outcome }) => outcome),
    })),
    leaderboard: snapshot.leaderboard,
    seasonLeaderboard: snapshot.seasonLeaderboard,
  };
}

export function projectViewerAccount(snapshot: PredictionSnapshot): ViewerAccountSnapshot {
  return {
    eventId: snapshot.event?.id ?? null,
    portfolio: snapshot.portfolio,
    sharesByOutcome: Object.fromEntries(
      snapshot.markets.flatMap((market) =>
        market.outcomes.map((outcome) => [outcome.id, outcome.viewerShares] as const),
      ),
    ),
  };
}

export async function getPredictionPublicSnapshot(): Promise<PredictionPublicSnapshot> {
  return projectPublicSnapshot(await getPredictionSnapshot());
}

export async function getPublicMarketSnapshot(marketId: string): Promise<PublicMarketSnapshot> {
  const [market] = await predictionDb
    .select()
    .from(markets)
    .where(eq(markets.id, marketId))
    .limit(1);
  if (!market) throw new PredictionError("MARKET_NOT_FOUND", "Market not found.", 404);
  const outcomes = await predictionDb
    .select()
    .from(marketOutcomes)
    .where(eq(marketOutcomes.marketId, market.id));
  const prices =
    market.status === "settled"
      ? outcomes.map((outcome) => new Decimal(outcome.settlementValue ?? 0))
      : getPrices(
          outcomes.map((outcome) => outcome.quantity),
          market.liquidity,
        );
  return {
    id: market.id,
    version: market.version,
    kind: market.kind,
    status: market.status,
    title: market.title,
    locksAt: market.locksAt?.toISOString() ?? null,
    outcomes: outcomes.map((outcome, index) => ({
      id: outcome.id,
      label: outcome.label,
      probability: prices[index]?.toNumber() ?? 0,
    })),
  };
}

type AccountMarket = { id: string; liquidity: string; status: string };
type AccountOutcome = { id: string; marketId: string; quantity: string };
type AccountPosition = { outcomeId: string; shares: string };
type AccountPortfolio = {
  availableCrowns: string;
  settlementDebt: string;
};

function accountPrices(
  marketRows: readonly AccountMarket[],
  outcomeRows: readonly AccountOutcome[],
): Map<string, Decimal> {
  const outcomesByMarket = new Map<string, AccountOutcome[]>();
  for (const outcome of outcomeRows) {
    const grouped = outcomesByMarket.get(outcome.marketId) ?? [];
    grouped.push(outcome);
    outcomesByMarket.set(outcome.marketId, grouped);
  }
  const priceByOutcome = new Map<string, Decimal>();
  for (const market of marketRows) {
    const outcomes = outcomesByMarket.get(market.id) ?? [];
    const prices =
      market.status === "settled"
        ? outcomes.map(() => new Decimal(0))
        : getPrices(
            outcomes.map((outcome) => outcome.quantity),
            market.liquidity,
          );
    outcomes.forEach((outcome, index) => {
      priceByOutcome.set(outcome.id, prices[index] ?? new Decimal(0));
    });
  }
  return priceByOutcome;
}

function accountSnapshot(
  eventId: string,
  portfolio: AccountPortfolio,
  positionRows: readonly AccountPosition[],
  priceByOutcome: ReadonlyMap<string, Decimal>,
): ViewerAccountSnapshot {
  const equity = positionRows.reduce(
    (total, position) =>
      total.plus(new Decimal(position.shares).mul(priceByOutcome.get(position.outcomeId) ?? 0)),
    new Decimal(portfolio.availableCrowns).minus(portfolio.settlementDebt),
  );
  return {
    eventId,
    portfolio: { availableCrowns: portfolio.availableCrowns, equity: equity.toFixed(8) },
    sharesByOutcome: Object.fromEntries(
      positionRows.map((position) => [position.outcomeId, position.shares]),
    ),
  };
}

export async function getViewerAccountSnapshot(userId: string): Promise<ViewerAccountSnapshot> {
  if (process.env.PREDICTION_MARKETS_ENABLED !== "true") {
    return { eventId: null, portfolio: null, sharesByOutcome: {} };
  }
  const [event] = await predictionDb
    .select()
    .from(events)
    .where(inArray(events.status, ["live", "draft", "completed"]))
    .orderBy(
      sql`case when ${events.status} in ('live', 'draft') then 0 else 1 end`,
      desc(events.createdAt),
    )
    .limit(1);
  if (!event) return { eventId: null, portfolio: null, sharesByOutcome: {} };

  const portfolio = await getPortfolioForSnapshot(event.id, userId, event.status);
  if (!portfolio) return { eventId: event.id, portfolio: null, sharesByOutcome: {} };
  const marketRows = await predictionDb
    .select({ id: markets.id, liquidity: markets.liquidity, status: markets.status })
    .from(markets)
    .where(eq(markets.eventId, event.id));
  const outcomeRows = marketRows.length
    ? await predictionDb
        .select({
          id: marketOutcomes.id,
          marketId: marketOutcomes.marketId,
          quantity: marketOutcomes.quantity,
        })
        .from(marketOutcomes)
        .where(
          inArray(
            marketOutcomes.marketId,
            marketRows.map((market) => market.id),
          ),
        )
    : [];
  const positionRows = await predictionDb
    .select({ outcomeId: positions.outcomeId, shares: positions.shares })
    .from(positions)
    .where(eq(positions.portfolioId, portfolio.id));
  return accountSnapshot(event.id, portfolio, positionRows, accountPrices(marketRows, outcomeRows));
}

export type ViewerAccountUpdate = {
  userId: string;
  account: ViewerAccountSnapshot;
};

export async function getAffectedViewerAccountSnapshots(
  eventId: string,
  marketIds: readonly string[],
): Promise<ViewerAccountUpdate[]> {
  if (marketIds.length === 0) return [];
  const affectedPortfolios = await predictionDb
    .selectDistinct({
      portfolioId: portfolios.id,
      userId: portfolios.userId,
      availableCrowns: portfolios.availableCrowns,
      settlementDebt: portfolios.settlementDebt,
    })
    .from(portfolios)
    .innerJoin(positions, eq(positions.portfolioId, portfolios.id))
    .innerJoin(marketOutcomes, eq(marketOutcomes.id, positions.outcomeId))
    .where(
      and(
        eq(portfolios.eventId, eventId),
        inArray(marketOutcomes.marketId, [...marketIds]),
        gt(positions.shares, "0"),
      ),
    );
  if (affectedPortfolios.length === 0) return [];

  const marketRows = await predictionDb
    .select({ id: markets.id, liquidity: markets.liquidity, status: markets.status })
    .from(markets)
    .where(eq(markets.eventId, eventId));
  const outcomeRows = marketRows.length
    ? await predictionDb
        .select({
          id: marketOutcomes.id,
          marketId: marketOutcomes.marketId,
          quantity: marketOutcomes.quantity,
        })
        .from(marketOutcomes)
        .where(
          inArray(
            marketOutcomes.marketId,
            marketRows.map((market) => market.id),
          ),
        )
    : [];
  const positionRows = await predictionDb
    .select({
      portfolioId: positions.portfolioId,
      outcomeId: positions.outcomeId,
      shares: positions.shares,
    })
    .from(positions)
    .where(
      inArray(
        positions.portfolioId,
        affectedPortfolios.map((portfolio) => portfolio.portfolioId),
      ),
    );
  const positionsByPortfolio = new Map<string, AccountPosition[]>();
  for (const position of positionRows) {
    const grouped = positionsByPortfolio.get(position.portfolioId) ?? [];
    grouped.push(position);
    positionsByPortfolio.set(position.portfolioId, grouped);
  }
  const priceByOutcome = accountPrices(marketRows, outcomeRows);
  return affectedPortfolios.map((portfolio) => ({
    userId: portfolio.userId,
    account: accountSnapshot(
      eventId,
      portfolio,
      positionsByPortfolio.get(portfolio.portfolioId) ?? [],
      priceByOutcome,
    ),
  }));
}

export async function createTradeQuote(input: {
  userId: string;
  marketId: string;
  outcomeId: string;
  side: "buy" | "sell";
  amount: string;
}): Promise<TradeQuote> {
  assertEnabled();
  const [market] = await predictionDb
    .select()
    .from(markets)
    .where(eq(markets.id, input.marketId))
    .limit(1);
  if (!market) throw new PredictionError("MARKET_NOT_FOUND", "Market not found.", 404);
  if (market.status !== "open")
    throw new PredictionError("MARKET_LOCKED", "This market is not open.");
  const [event] = await predictionDb
    .select({ status: events.status })
    .from(events)
    .where(eq(events.id, market.eventId))
    .limit(1);
  if (event?.status !== "live") {
    throw new PredictionError("MARKET_LOCKED", "Trading is closed because the event is not live.");
  }
  const portfolio = await getOrCreatePortfolio(market.eventId, input.userId);
  return predictionDb.transaction(async (tx) => {
    const [lockedPortfolio] = await tx
      .select()
      .from(portfolios)
      .where(and(eq(portfolios.id, portfolio.id), eq(portfolios.userId, input.userId)))
      .for("update")
      .limit(1);
    if (!lockedPortfolio) throw new Error("Portfolio no longer exists.");

    const now = new Date();
    const expired = await tx
      .select({ id: tradeQuotes.id })
      .from(tradeQuotes)
      .where(
        and(
          eq(tradeQuotes.portfolioId, lockedPortfolio.id),
          isNull(tradeQuotes.consumedAt),
          lte(tradeQuotes.expiresAt, now),
        ),
      )
      .orderBy(tradeQuotes.expiresAt)
      .limit(EXPIRED_QUOTE_CLEANUP_LIMIT);
    if (expired.length > 0) {
      await tx.delete(tradeQuotes).where(
        inArray(
          tradeQuotes.id,
          expired.map(({ id }) => id),
        ),
      );
    }

    const [{ recent }] = await tx
      .select({ recent: count() })
      .from(tradeQuotes)
      .where(
        and(
          eq(tradeQuotes.portfolioId, lockedPortfolio.id),
          gt(tradeQuotes.createdAt, new Date(now.getTime() - QUOTE_RATE_WINDOW_MS)),
        ),
      );
    if (recent >= MAX_QUOTES_PER_WINDOW) {
      throw new PredictionError("RATE_LIMITED", "Too many quote requests. Try again shortly.", 429);
    }

    const [{ outstanding }] = await tx
      .select({ outstanding: count() })
      .from(tradeQuotes)
      .where(
        and(
          eq(tradeQuotes.portfolioId, lockedPortfolio.id),
          isNull(tradeQuotes.consumedAt),
          gt(tradeQuotes.expiresAt, now),
        ),
      );
    if (outstanding >= MAX_OUTSTANDING_QUOTES) {
      throw new PredictionError(
        "RATE_LIMITED",
        "Too many active quotes. Wait for one to expire before requesting another.",
        429,
      );
    }

    const outcomes = await tx
      .select()
      .from(marketOutcomes)
      .where(eq(marketOutcomes.marketId, market.id));
    const outcomeIndex = outcomes.findIndex((outcome) => outcome.id === input.outcomeId);
    if (outcomeIndex < 0) {
      throw new PredictionError("MARKET_NOT_FOUND", "Outcome not found.", 404);
    }
    const quantities = outcomes.map((outcome) => outcome.quantity);
    const quote =
      input.side === "buy"
        ? quoteBuy(quantities, outcomeIndex, input.amount, market.liquidity)
        : quoteSell(quantities, outcomeIndex, input.amount, market.liquidity);
    if (input.side === "buy" && new Decimal(lockedPortfolio.availableCrowns).lt(quote.crowns)) {
      throw new PredictionError("INSUFFICIENT_CROWNS", "Not enough Crowns for this position.");
    }
    if (input.side === "sell") {
      const [position] = await tx
        .select()
        .from(positions)
        .where(
          and(
            eq(positions.portfolioId, lockedPortfolio.id),
            eq(positions.outcomeId, input.outcomeId),
          ),
        )
        .limit(1);
      if (!position || new Decimal(position.shares).lt(quote.shares)) {
        throw new PredictionError("INSUFFICIENT_SHARES", "You do not hold that many shares.");
      }
    }
    const expiresAt = new Date(now.getTime() + 10_000);
    const [record] = await tx
      .insert(tradeQuotes)
      .values({
        portfolioId: lockedPortfolio.id,
        marketId: market.id,
        outcomeId: input.outcomeId,
        marketVersion: market.version,
        side: input.side,
        crownAmount: amount(quote.crowns),
        shareAmount: amount(quote.shares),
        averagePrice: amount(quote.averagePrice),
        expiresAt,
      })
      .returning();
    if (!record) throw new Error("Quote creation failed.");
    return {
      id: record.id,
      marketId: record.marketId,
      marketVersion: record.marketVersion,
      side: record.side,
      outcomeId: record.outcomeId,
      crownAmount: record.crownAmount,
      shareAmount: record.shareAmount,
      averagePrice: record.averagePrice,
      expiresAt: record.expiresAt.toISOString(),
    };
  });
}

export async function executeTrade(input: {
  userId: string;
  quoteId: string;
  idempotencyKey: string;
}): Promise<{ tradeId: string; marketId: string }> {
  assertEnabled();
  return predictionDb.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: trades.id, marketId: trades.marketId })
      .from(trades)
      .innerJoin(portfolios, eq(portfolios.id, trades.portfolioId))
      .where(
        and(eq(portfolios.userId, input.userId), eq(trades.idempotencyKey, input.idempotencyKey)),
      )
      .limit(1);
    if (existing) return { tradeId: existing.id, marketId: existing.marketId };

    const [{ recent }] = await tx
      .select({ recent: count() })
      .from(trades)
      .innerJoin(portfolios, eq(portfolios.id, trades.portfolioId))
      .where(
        and(
          eq(portfolios.userId, input.userId),
          gt(trades.createdAt, new Date(Date.now() - 10_000)),
        ),
      );
    if (recent >= 10)
      throw new PredictionError("RATE_LIMITED", "Too many trades. Try again shortly.", 429);

    const [quote] = await tx
      .select({ quote: tradeQuotes, portfolio: portfolios })
      .from(tradeQuotes)
      .innerJoin(portfolios, eq(portfolios.id, tradeQuotes.portfolioId))
      .where(and(eq(tradeQuotes.id, input.quoteId), eq(portfolios.userId, input.userId)))
      .limit(1);
    if (!quote || quote.quote.expiresAt <= new Date() || quote.quote.consumedAt) {
      throw new PredictionError("QUOTE_EXPIRED", "That quote expired. Request a new price.");
    }
    const [market] = await tx
      .select()
      .from(markets)
      .where(eq(markets.id, quote.quote.marketId))
      .for("update")
      .limit(1);
    if (!market || market.status !== "open")
      throw new PredictionError("MARKET_LOCKED", "This market is locked.");
    if (market.version !== quote.quote.marketVersion) {
      throw new PredictionError("PRICE_CHANGED", "The market moved. Review a fresh quote.", 409);
    }
    const [event] = await tx
      .select({ status: events.status })
      .from(events)
      .where(eq(events.id, market.eventId))
      .limit(1);
    if (event?.status !== "live") {
      throw new PredictionError(
        "MARKET_LOCKED",
        "Trading is closed because the event is not live.",
      );
    }
    const crownDelta =
      quote.quote.side === "buy" ? quote.quote.crownAmount : `-${quote.quote.crownAmount}`;
    const shareDelta =
      quote.quote.side === "buy" ? quote.quote.shareAmount : `-${quote.quote.shareAmount}`;
    if (
      quote.quote.side === "buy" &&
      new Decimal(quote.portfolio.availableCrowns).lt(quote.quote.crownAmount)
    ) {
      throw new PredictionError("INSUFFICIENT_CROWNS", "Not enough Crowns for this position.");
    }
    const [held] = await tx
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.portfolioId, quote.portfolio.id),
          eq(positions.outcomeId, quote.quote.outcomeId),
        ),
      )
      .limit(1);
    if (
      quote.quote.side === "sell" &&
      (!held || new Decimal(held.shares).lt(quote.quote.shareAmount))
    ) {
      throw new PredictionError("INSUFFICIENT_SHARES", "You do not hold that many shares.");
    }

    const consumed = await tx
      .update(tradeQuotes)
      .set({ consumedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tradeQuotes.id, quote.quote.id), isNull(tradeQuotes.consumedAt)))
      .returning({ id: tradeQuotes.id });
    if (!consumed.length)
      throw new PredictionError("QUOTE_EXPIRED", "That quote was already used.");

    await tx
      .update(portfolios)
      .set(
        quote.quote.side === "buy"
          ? {
              availableCrowns: sql`${portfolios.availableCrowns} - ${crownDelta}::numeric`,
              updatedAt: new Date(),
            }
          : {
              availableCrowns: sql`${portfolios.availableCrowns} + greatest(${quote.quote.crownAmount}::numeric - ${portfolios.settlementDebt}, 0)`,
              settlementDebt: sql`greatest(${portfolios.settlementDebt} - ${quote.quote.crownAmount}::numeric, 0)`,
              updatedAt: new Date(),
            },
      )
      .where(eq(portfolios.id, quote.portfolio.id));
    await tx
      .insert(positions)
      .values({
        portfolioId: quote.portfolio.id,
        outcomeId: quote.quote.outcomeId,
        shares: shareDelta,
      })
      .onConflictDoUpdate({
        target: [positions.portfolioId, positions.outcomeId],
        set: { shares: sql`${positions.shares} + ${shareDelta}::numeric`, updatedAt: new Date() },
      });
    await tx
      .update(marketOutcomes)
      .set({
        quantity: sql`${marketOutcomes.quantity} + ${shareDelta}::numeric`,
        updatedAt: new Date(),
      })
      .where(eq(marketOutcomes.id, quote.quote.outcomeId));
    const advanced = await tx
      .update(markets)
      .set({ version: sql`${markets.version} + 1`, updatedAt: new Date() })
      .where(and(eq(markets.id, market.id), eq(markets.version, market.version)))
      .returning({ id: markets.id });
    if (!advanced.length)
      throw new PredictionError("PRICE_CHANGED", "The market moved. Review a fresh quote.", 409);
    const [trade] = await tx
      .insert(trades)
      .values({
        quoteId: quote.quote.id,
        portfolioId: quote.portfolio.id,
        marketId: market.id,
        outcomeId: quote.quote.outcomeId,
        side: quote.quote.side,
        crownAmount: quote.quote.crownAmount,
        shareAmount: quote.quote.shareAmount,
        idempotencyKey: input.idempotencyKey,
      })
      .returning();
    if (!trade) throw new Error("Trade creation failed.");
    await tx.insert(ledgerEntries).values({
      portfolioId: quote.portfolio.id,
      marketId: market.id,
      tradeId: trade.id,
      kind: quote.quote.side,
      amount: new Decimal(crownDelta).neg().toFixed(8),
    });
    return { tradeId: trade.id, marketId: market.id };
  });
}
