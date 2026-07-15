import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });

type Amount = Decimal.Value;

export type MarketQuote = {
  crowns: Decimal;
  shares: Decimal;
  averagePrice: Decimal;
  quantities: Decimal[];
};

function assertMarket(quantities: readonly Amount[], liquidity: Amount): Decimal {
  if (quantities.length < 2) throw new Error("A market requires at least two outcomes.");
  const b = new Decimal(liquidity);
  if (!b.isFinite() || !b.isPositive()) throw new Error("Liquidity must be positive.");
  if (quantities.some((quantity) => !new Decimal(quantity).isFinite())) {
    throw new Error("Outcome quantities must be finite.");
  }
  return b;
}

export function marketCost(quantities: readonly Amount[], liquidity: Amount): Decimal {
  const b = assertMarket(quantities, liquidity);
  const scaled = quantities.map((quantity) => new Decimal(quantity).div(b));
  const max = Decimal.max(...scaled);
  const sum = Decimal.sum(...scaled.map((quantity) => quantity.minus(max).exp()));
  return b.mul(max.plus(sum.ln()));
}

export function getPrices(quantities: readonly Amount[], liquidity: Amount): Decimal[] {
  const b = assertMarket(quantities, liquidity);
  const scaled = quantities.map((quantity) => new Decimal(quantity).div(b));
  const max = Decimal.max(...scaled);
  const weights = scaled.map((quantity) => quantity.minus(max).exp());
  const total = Decimal.sum(...weights);
  return weights.map((weight) => weight.div(total));
}

export function quoteBuy(
  quantities: readonly Amount[],
  outcomeIndex: number,
  crowns: Amount,
  liquidity: Amount,
): MarketQuote {
  if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0 || outcomeIndex >= quantities.length) {
    throw new Error("The selected outcome does not exist.");
  }
  const budget = new Decimal(crowns);
  if (!budget.isFinite() || !budget.isPositive()) throw new Error("Crowns must be positive.");
  const before = marketCost(quantities, liquidity);
  let low = new Decimal(0);
  let high = budget.mul(2).plus(new Decimal(liquidity).mul(2));

  for (let iteration = 0; iteration < 160; iteration += 1) {
    const midpoint = low.plus(high).div(2);
    const next = quantities.map((quantity, index) =>
      new Decimal(quantity).plus(index === outcomeIndex ? midpoint : 0),
    );
    if (marketCost(next, liquidity).minus(before).lte(budget)) low = midpoint;
    else high = midpoint;
  }

  const next = quantities.map((quantity, index) =>
    new Decimal(quantity).plus(index === outcomeIndex ? low : 0),
  );
  return { crowns: budget, shares: low, averagePrice: budget.div(low), quantities: next };
}

export function quoteSell(
  quantities: readonly Amount[],
  outcomeIndex: number,
  shares: Amount,
  liquidity: Amount,
): MarketQuote {
  const shareAmount = new Decimal(shares);
  if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0 || outcomeIndex >= quantities.length) {
    throw new Error("The selected outcome does not exist.");
  }
  if (!shareAmount.isFinite() || !shareAmount.isPositive()) {
    throw new Error("Shares must be positive.");
  }
  const next = quantities.map((quantity, index) =>
    new Decimal(quantity).minus(index === outcomeIndex ? shareAmount : 0),
  );
  const crowns = marketCost(quantities, liquidity).minus(marketCost(next, liquidity));
  return { crowns, shares: shareAmount, averagePrice: crowns.div(shareAmount), quantities: next };
}

export function settlementValues(
  outcomeCount: number,
  winningIndexes: readonly number[],
): Decimal[] {
  if (outcomeCount < 2 || winningIndexes.length === 0) {
    throw new Error("Settlement requires outcomes and at least one winner.");
  }
  if (winningIndexes.some((index) => index < 0 || index >= outcomeCount)) {
    throw new Error("A winning outcome does not exist.");
  }
  const value = new Decimal(1).div(winningIndexes.length);
  return Array.from({ length: outcomeCount }, (_, index) =>
    winningIndexes.includes(index) ? value : new Decimal(0),
  );
}
