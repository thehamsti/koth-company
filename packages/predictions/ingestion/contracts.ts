import { z } from "zod";

export const ingestionProposal = z.object({
  eventId: z.uuid(),
  kind: z.literal("arena_result", {
    error: 'Only "arena_result" ingestion proposals are supported.',
  }),
  confidence: z.number().min(0).max(1),
  evidence: z.record(z.string(), z.unknown()).default({}),
  payload: z.object({
    arenaId: z.uuid(),
    contestantWon: z.boolean(),
  }),
});

export type IngestionProposal = z.infer<typeof ingestionProposal>;
