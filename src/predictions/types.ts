export type MarketKind = "live_arena" | "win_threshold" | "event_winner";
export type MarketStatus = "draft" | "open" | "locked" | "settled" | "void";

export type OutcomeSnapshot = {
  id: string;
  label: string;
  probability: number;
  viewerShares: string;
};

export type MarketSnapshot = {
  id: string;
  version: number;
  kind: MarketKind;
  status: MarketStatus;
  title: string;
  locksAt: string | null;
  outcomes: OutcomeSnapshot[];
};

export type PredictionSnapshot = {
  enabled: boolean;
  event: { id: string; name: string; season: number; week: number; status: string } | null;
  portfolio: { availableCrowns: string; equity: string } | null;
  markets: MarketSnapshot[];
  leaderboard: Array<{ userId: string; name: string; equity: string; returnPercent: string }>;
  seasonLeaderboard: Array<{
    userId: string;
    name: string;
    score: string;
    eventsPlayed: number;
  }>;
};

export type TradeQuote = {
  id: string;
  marketId: string;
  marketVersion: number;
  side: "buy" | "sell";
  outcomeId: string;
  crownAmount: string;
  shareAmount: string;
  averagePrice: string;
  expiresAt: string;
};

export type PredictionErrorCode =
  | "FEATURE_DISABLED"
  | "AUTH_REQUIRED"
  | "ADMIN_REQUIRED"
  | "EVENT_NOT_FOUND"
  | "MARKET_NOT_FOUND"
  | "MARKET_LOCKED"
  | "QUOTE_EXPIRED"
  | "PRICE_CHANGED"
  | "INSUFFICIENT_CROWNS"
  | "INSUFFICIENT_SHARES"
  | "RATE_LIMITED"
  | "INVALID_COMMAND"
  | "TWITCH_NOT_CONNECTED"
  | "TWITCH_API_ERROR";

export class PredictionError extends Error {
  constructor(
    public readonly code: PredictionErrorCode,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}
