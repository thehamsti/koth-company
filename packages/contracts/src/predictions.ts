import { z } from "zod";

export const marketKind = z.enum(["live_arena", "win_threshold", "event_winner"]);
export const marketStatus = z.enum(["draft", "open", "locked", "settled", "void"]);

export type MarketKind = z.infer<typeof marketKind>;
export type MarketStatus = z.infer<typeof marketStatus>;

export type EventSnapshot = {
  id: string;
  name: string;
  season: number;
  week: number;
  status: string;
  startingCrowns: string;
};

export type PublicOutcomeSnapshot = {
  id: string;
  label: string;
  probability: number;
};

export type OutcomeSnapshot = PublicOutcomeSnapshot & {
  viewerShares: string;
};

export type PublicMarketSnapshot = {
  id: string;
  version: number;
  kind: MarketKind;
  status: MarketStatus;
  title: string;
  locksAt: string | null;
  outcomes: PublicOutcomeSnapshot[];
};

export type MarketSnapshot = Omit<PublicMarketSnapshot, "outcomes"> & {
  outcomes: OutcomeSnapshot[];
};

export type EventLeaderboardEntry = {
  userId: string;
  name: string;
  equity: string;
  returnPercent: string;
};

export type SeasonLeaderboardEntry = {
  userId: string;
  name: string;
  score: string;
  eventsPlayed: number;
};

export type PredictionPublicSnapshot = {
  enabled: boolean;
  event: EventSnapshot | null;
  markets: PublicMarketSnapshot[];
  leaderboard: EventLeaderboardEntry[];
  seasonLeaderboard: SeasonLeaderboardEntry[];
};

export type ViewerAccountSnapshot = {
  eventId: string | null;
  portfolio: { availableCrowns: string; equity: string } | null;
  sharesByOutcome: Record<string, string>;
};

export type PredictionSnapshot = {
  enabled: boolean;
  event: EventSnapshot | null;
  portfolio: ViewerAccountSnapshot["portfolio"];
  markets: MarketSnapshot[];
  leaderboard: EventLeaderboardEntry[];
  seasonLeaderboard: SeasonLeaderboardEntry[];
};

export type CheckInResult = {
  alreadyCheckedIn: boolean;
  account: ViewerAccountSnapshot;
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

export const quoteInput = z.object({
  marketId: z.uuid(),
  outcomeId: z.uuid(),
  side: z.enum(["buy", "sell"]),
  amount: z.string().regex(/^\d+(\.\d{1,8})?$/),
});

export const tradeInput = z.object({
  quoteId: z.uuid(),
  idempotencyKey: z.string().min(8).max(100),
});

export const operatorCommand = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_event"),
    name: z.string().min(1).max(100),
    season: z.int().positive(),
    week: z.int().positive(),
  }),
  z.object({
    type: z.literal("add_contestant"),
    eventId: z.uuid(),
    displayName: z.string().min(1).max(50),
    queuePosition: z.int().positive().optional(),
  }),
  z.object({ type: z.literal("remove_contestant"), eventId: z.uuid(), contestantId: z.uuid() }),
  z.object({
    type: z.literal("create_threshold"),
    eventId: z.uuid(),
    contestantId: z.uuid(),
    threshold: z.int().positive(),
  }),
  z.object({ type: z.literal("activate_event"), eventId: z.uuid() }),
  z.object({ type: z.literal("open_arena"), eventId: z.uuid(), contestantId: z.uuid() }),
  z.object({ type: z.literal("start_arena"), eventId: z.uuid(), arenaId: z.uuid() }),
  z.object({
    type: z.literal("record_result"),
    eventId: z.uuid(),
    arenaId: z.uuid(),
    contestantWon: z.boolean(),
  }),
  z.object({
    type: z.literal("correct_result"),
    eventId: z.uuid(),
    arenaId: z.uuid(),
    contestantWon: z.boolean(),
  }),
  z.object({ type: z.literal("complete_event"), eventId: z.uuid() }),
  z.object({ type: z.literal("set_automation"), eventId: z.uuid(), enabled: z.boolean() }),
  z.object({
    type: z.literal("pause_automation"),
    eventId: z.uuid(),
    reason: z.string().min(1).max(500).optional(),
  }),
  z.object({ type: z.literal("resume_automation"), eventId: z.uuid() }),
  z.object({
    type: z.literal("review_proposal"),
    eventId: z.uuid(),
    proposalId: z.uuid(),
    decision: z.enum(["accepted", "rejected"]),
  }),
]);

export const operatorCommandInput = z.object({
  command: operatorCommand,
  idempotencyKey: z.string().min(8).max(100),
});

export type OperatorCommand = z.infer<typeof operatorCommand>;

type SerializedDate = string | Date;

export type OperatorState = {
  event: (EventSnapshot & Record<string, unknown>) | null;
  contestants: Array<{
    id: string;
    displayName: string;
    queuePosition: number | null;
    wins: number;
    status: string;
    [key: string]: unknown;
  }>;
  arenas: Array<{
    id: string;
    contestantId: string;
    ordinal: number;
    status: string;
    contestantWon: boolean | null;
    [key: string]: unknown;
  }>;
  markets: Array<{
    id: string;
    title: string;
    status: string;
    [key: string]: unknown;
  }>;
  proposals: Array<{
    id: string;
    kind: string;
    confidence: string;
    payload: Record<string, unknown>;
    [key: string]: unknown;
  }>;
  automation?: {
    enabled: boolean;
    paused: boolean;
    status: "disabled" | "paused" | "stale" | "running";
    workerId: string | null;
    lastHeartbeatAt: SerializedDate | null;
    leaseExpiresAt: string | null;
    pauseReason: string | null;
    lastObservation: Record<string, unknown>;
    evidenceImage: string | null;
    [key: string]: unknown;
  } | null;
};

export type AutomationState = {
  event: (EventSnapshot & Record<string, unknown>) | null;
  automation:
    | ({
        status: "disabled" | "paused" | "stale" | "running";
        enabled?: boolean;
        paused?: boolean;
        workerId?: string | null;
        lastHeartbeatAt?: SerializedDate | null;
        [key: string]: unknown;
      } & Record<string, unknown>)
    | null;
  contestants: OperatorState["contestants"];
  activeArena: OperatorState["arenas"][number] | null;
};
