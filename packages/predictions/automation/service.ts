import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { contestantIdentityFingerprint } from "../contestant-identity";
import { predictionDb } from "../db";
import { arenas, automationSessions, contestants, domainEvents, events } from "../db/schema";
import { runOperatorCommand } from "../services/operator";
import { PredictionError } from "../types";
import type { AutomationAction } from "./contracts";
import {
  AUTOMATION_LEASE_TIMEOUT_MS,
  automationStatus,
  shouldPersistHeartbeatDiagnostics,
  validateAutomationTransition,
  validateAutomationWorkerLease,
} from "./state";

async function updateHeartbeat(
  eventId: string,
  workerId: string,
  observation?: Record<string, unknown>,
  evidenceImage?: string,
  options: { takeover?: boolean; pauseReason?: string } = {},
): Promise<void> {
  const now = new Date();
  await predictionDb.transaction(async (tx) => {
    await tx
      .insert(automationSessions)
      .values({ eventId })
      .onConflictDoNothing({ target: automationSessions.eventId });
    const [session] = await tx
      .select()
      .from(automationSessions)
      .where(eq(automationSessions.eventId, eventId))
      .for("update")
      .limit(1);
    if (!session) {
      throw new PredictionError("EVENT_NOT_FOUND", "Event not found.", 404);
    }
    validateAutomationWorkerLease(session, workerId, options.takeover ?? false, now.getTime());

    const persistDiagnostics =
      options.pauseReason !== undefined ||
      shouldPersistHeartbeatDiagnostics(session.paused, observation);
    await tx
      .update(automationSessions)
      .set({
        workerId,
        lastHeartbeatAt: now,
        ...(options.pauseReason !== undefined
          ? { paused: true, pauseReason: options.pauseReason }
          : {}),
        ...(persistDiagnostics && observation ? { lastObservation: observation } : {}),
        ...(persistDiagnostics && evidenceImage ? { evidenceImage } : {}),
        updatedAt: now,
      })
      .where(eq(automationSessions.eventId, eventId));
  });
}

async function renewWorkerLeaseForMutation(eventId: string, workerId: string): Promise<void> {
  const now = new Date();
  const [renewed] = await predictionDb
    .update(automationSessions)
    .set({ lastHeartbeatAt: now, updatedAt: now })
    .where(
      and(
        eq(automationSessions.eventId, eventId),
        eq(automationSessions.workerId, workerId),
        eq(automationSessions.enabled, true),
        eq(automationSessions.paused, false),
        gte(
          automationSessions.lastHeartbeatAt,
          new Date(now.getTime() - AUTOMATION_LEASE_TIMEOUT_MS),
        ),
      ),
    )
    .returning({ id: automationSessions.id });
  if (renewed) return;

  const [session] = await predictionDb
    .select()
    .from(automationSessions)
    .where(eq(automationSessions.eventId, eventId))
    .limit(1);
  if (session) validateAutomationWorkerLease(session, workerId, false, now.getTime());
  throw new PredictionError("INVALID_COMMAND", "Automation worker is not running.");
}

export async function getAutomationState() {
  const [event] = await predictionDb
    .select()
    .from(events)
    .where(inArray(events.status, ["draft", "live"]))
    .orderBy(desc(events.createdAt))
    .limit(1);
  if (!event) return { event: null, automation: null, contestants: [], activeArena: null };
  const [automation] = await predictionDb
    .select()
    .from(automationSessions)
    .where(eq(automationSessions.eventId, event.id))
    .limit(1);
  const [activeArena] = await predictionDb
    .select()
    .from(arenas)
    .where(and(eq(arenas.eventId, event.id), inArray(arenas.status, ["open", "locked"])))
    .orderBy(desc(arenas.ordinal))
    .limit(1);
  return {
    event,
    automation: automation
      ? { ...automation, status: automationStatus(automation) }
      : { status: "disabled" as const },
    contestants: await predictionDb
      .select()
      .from(contestants)
      .where(eq(contestants.eventId, event.id))
      .orderBy(asc(contestants.queuePosition)),
    activeArena: activeArena ?? null,
  };
}

export async function runAutomationAction(
  action: AutomationAction,
  idempotencyKey: string,
): Promise<{ id: string | null }> {
  if (action.type === "heartbeat") {
    await updateHeartbeat(
      action.eventId,
      action.workerId,
      action.observation,
      action.evidenceImage,
      { takeover: action.takeover },
    );
    return { id: null };
  }
  if (action.type === "pause") {
    await updateHeartbeat(
      action.eventId,
      action.workerId,
      action.observation,
      action.evidenceImage,
      { pauseReason: action.reason },
    );
    return { id: null };
  }

  const [duplicate] = await predictionDb
    .select({ id: domainEvents.id })
    .from(domainEvents)
    .where(
      and(
        eq(domainEvents.eventId, action.eventId),
        eq(domainEvents.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (duplicate) return duplicate;

  const [event] = await predictionDb
    .select()
    .from(events)
    .where(eq(events.id, action.eventId))
    .limit(1);
  if (!event) throw new PredictionError("EVENT_NOT_FOUND", "Event not found.", 404);
  const [session] = await predictionDb
    .select()
    .from(automationSessions)
    .where(eq(automationSessions.eventId, event.id))
    .limit(1);
  if (!session || automationStatus(session) !== "running") {
    throw new PredictionError("INVALID_COMMAND", "Automation worker is not running.");
  }
  validateAutomationWorkerLease(session, action.workerId, false);
  const [activeArena] = await predictionDb
    .select()
    .from(arenas)
    .where(and(eq(arenas.eventId, event.id), inArray(arenas.status, ["open", "locked"])))
    .orderBy(desc(arenas.ordinal))
    .limit(1);
  validateAutomationTransition(
    session,
    { eventStatus: event.status, arenaStatus: activeArena?.status ?? null },
    action,
  );

  if (
    (action.type === "start_arena" || action.type === "record_result") &&
    action.arenaId !== activeArena?.id
  ) {
    throw new PredictionError(
      "INVALID_COMMAND",
      "Automation arena does not match the active arena.",
    );
  }

  let command:
    | {
        type: "add_contestant";
        eventId: string;
        displayName: string;
        queuePosition: number;
        status?: "queued" | "active" | "eliminated";
        wins?: number;
      }
    | { type: "remove_contestant"; eventId: string; contestantId: string }
    | {
        type: "sync_roster";
        eventId: string;
        contestants: Array<{
          contestantId: string;
          status: "queued" | "active" | "eliminated";
          wins: number;
          queuePosition: number;
        }>;
      }
    | { type: "activate_event"; eventId: string }
    | { type: "sync_queue"; eventId: string; contestantIds: string[] }
    | { type: "open_arena"; eventId: string; contestantId: string; baselineWins?: number }
    | { type: "start_arena"; eventId: string; arenaId: string }
    | {
        type: "record_result";
        eventId: string;
        arenaId: string;
        contestantWon: boolean;
      };
  if (action.type === "add_contestant") {
    const roster = await predictionDb
      .select()
      .from(contestants)
      .where(eq(contestants.eventId, event.id));
    const fingerprint = contestantIdentityFingerprint(action.displayName);
    const existing = roster.find(
      (contestant) => contestantIdentityFingerprint(contestant.displayName) === fingerprint,
    );
    if (existing) return { id: existing.id };
    command = {
      type: "add_contestant",
      eventId: event.id,
      displayName: action.displayName,
      queuePosition:
        action.queuePosition ??
        Math.max(0, ...roster.map(({ queuePosition }) => queuePosition ?? 0)) + 1,
      status: action.status,
      wins: action.wins,
    };
  } else if (action.type === "remove_contestant") {
    const [contestant] = await predictionDb
      .select({ id: contestants.id })
      .from(contestants)
      .where(and(eq(contestants.id, action.contestantId), eq(contestants.eventId, event.id)))
      .limit(1);
    if (!contestant) return { id: null };
    command = {
      type: "remove_contestant",
      eventId: event.id,
      contestantId: action.contestantId,
    };
  } else if (action.type === "sync_roster") {
    command = { type: "sync_roster", eventId: event.id, contestants: action.contestants };
  } else if (action.type === "activate_event") {
    command = { type: "activate_event", eventId: event.id };
  } else if (action.type === "sync_queue") {
    command = { type: "sync_queue", eventId: event.id, contestantIds: action.contestantIds };
  } else if (action.type === "open_arena") {
    const [contestant] = await predictionDb
      .select({ id: contestants.id })
      .from(contestants)
      .where(
        and(
          eq(contestants.id, action.contestantId),
          eq(contestants.eventId, event.id),
          inArray(contestants.status, ["queued", "active"]),
        ),
      )
      .limit(1);
    if (!contestant) {
      throw new PredictionError("INVALID_COMMAND", "Contestant is not available for this event.");
    }
    command = {
      type: "open_arena",
      eventId: event.id,
      contestantId: action.contestantId,
      baselineWins: action.baselineWins,
    };
  } else if (action.type === "start_arena") {
    command = { type: "start_arena", eventId: event.id, arenaId: action.arenaId };
  } else {
    command = {
      type: "record_result",
      eventId: event.id,
      arenaId: action.arenaId,
      contestantWon: action.contestantWon,
    };
  }
  await renewWorkerLeaseForMutation(event.id, action.workerId);
  return runOperatorCommand(null, command, idempotencyKey, "cv");
}
