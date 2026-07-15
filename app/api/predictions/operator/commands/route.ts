import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, requireAdmin } from "@/src/predictions/http";
import { getOperatorState, runOperatorCommand } from "@/src/predictions/services/operator";
import { setRewardEnabled } from "@/src/predictions/services/channel-points";

const command = z.discriminatedUnion("type", [
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

export async function GET() {
  try {
    await requireAdmin();
    return NextResponse.json(await getOperatorState());
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const viewer = await requireAdmin();
    const body = z
      .object({ command, idempotencyKey: z.string().min(8).max(100) })
      .parse(await request.json());
    const result = await runOperatorCommand(viewer.id, body.command, body.idempotencyKey);
    if (body.command.type === "activate_event" || body.command.type === "complete_event") {
      const enabled = body.command.type === "activate_event";
      await setRewardEnabled(enabled);
    }
    return NextResponse.json(result);
  } catch (error) {
    return apiError(error);
  }
}
