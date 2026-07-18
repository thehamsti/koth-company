import { z } from "zod";

const base = {
  eventId: z.uuid(),
  workerId: z.string().min(1).max(100),
};

const observation = z.record(z.string(), z.unknown()).optional();
const evidenceImage = z.string().max(250_000).optional();

export const automationAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("heartbeat"),
    ...base,
    observation,
    evidenceImage,
    takeover: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("pause"),
    ...base,
    reason: z.string().min(1).max(500),
    observation,
    evidenceImage,
  }),
  z.object({
    type: z.literal("add_contestant"),
    ...base,
    displayName: z.string().trim().min(1).max(50),
  }),
  z.object({ type: z.literal("remove_contestant"), ...base, contestantId: z.uuid() }),
  z.object({ type: z.literal("activate_event"), ...base }),
  z.object({
    type: z.literal("sync_queue"),
    ...base,
    contestantIds: z.array(z.uuid()).min(1).max(100),
  }),
  z.object({
    type: z.literal("open_arena"),
    ...base,
    contestantId: z.uuid(),
    baselineWins: z.int().min(0).max(999).optional(),
  }),
  z.object({ type: z.literal("start_arena"), ...base, arenaId: z.uuid() }),
  z.object({
    type: z.literal("record_result"),
    ...base,
    arenaId: z.uuid(),
    contestantWon: z.boolean(),
  }),
]);

export type AutomationAction = z.infer<typeof automationAction>;
