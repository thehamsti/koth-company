export type {
  MarketKind,
  MarketSnapshot,
  MarketStatus,
  OutcomeSnapshot,
  PredictionSnapshot,
  TradeQuote,
} from "../contracts/src";

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
  | "REALTIME_CLIENT_CAPACITY_EXCEEDED"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_JSON"
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
