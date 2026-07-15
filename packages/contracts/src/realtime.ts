import { z } from "zod";
import type {
  AutomationState,
  EventLeaderboardEntry,
  OperatorState,
  PredictionPublicSnapshot,
  PublicMarketSnapshot,
  SeasonLeaderboardEntry,
  ViewerAccountSnapshot,
} from "./predictions";

export type StreamReady = { epoch: string };

export type RealtimePayloads = {
  "stream.ready": StreamReady;
  "public.snapshot": PredictionPublicSnapshot;
  "market.updated": { market: PublicMarketSnapshot };
  "leaderboards.updated": {
    leaderboard: EventLeaderboardEntry[];
    seasonLeaderboard: SeasonLeaderboardEntry[];
  };
  "account.updated": ViewerAccountSnapshot;
  "accounts.invalidated": {
    eventId: string | null;
    reason: "event_changed";
  };
  "operator.state": OperatorState;
  "automation.state": AutomationState;
};

export type RealtimeEventName = keyof RealtimePayloads;

export type RealtimeEvent<Name extends RealtimeEventName = RealtimeEventName> = {
  name: Name;
  revision: string;
  emittedAt: string;
  payload: RealtimePayloads[Name];
};

export const realtimeEnvelope = z.object({
  revision: z.string().min(1),
  emittedAt: z.iso.datetime(),
  payload: z.unknown(),
});

export type RealtimeEnvelope = z.infer<typeof realtimeEnvelope>;
