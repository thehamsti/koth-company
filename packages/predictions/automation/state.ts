import { PredictionError } from "../types";

type SessionState = {
  enabled: boolean;
  paused: boolean;
  lastHeartbeatAt: Date | null;
};

type DomainState = {
  eventStatus: string;
  arenaStatus: string | null;
};

type AutomationAction = {
  type:
    | "add_contestant"
    | "remove_contestant"
    | "sync_roster"
    | "activate_event"
    | "sync_queue"
    | "open_arena"
    | "start_arena"
    | "record_result";
};

export type AutomationStatus = "disabled" | "paused" | "stale" | "running";
export const AUTOMATION_LEASE_TIMEOUT_MS = 15_000;

type WorkerLeaseState = {
  workerId: string | null;
  lastHeartbeatAt: Date | null;
};

function heartbeatIsStale(lastHeartbeatAt: Date | null, now: number): boolean {
  return !lastHeartbeatAt || now - lastHeartbeatAt.getTime() > AUTOMATION_LEASE_TIMEOUT_MS;
}

export function automationStatus(session: SessionState | null, now = Date.now()): AutomationStatus {
  if (!session?.enabled) return "disabled";
  if (session.paused) return "paused";
  if (heartbeatIsStale(session.lastHeartbeatAt, now)) return "stale";
  return "running";
}

export function validateAutomationWorkerLease(
  session: WorkerLeaseState,
  workerId: string,
  takeover: boolean,
  now = Date.now(),
): void {
  if (!session.workerId || session.workerId === workerId) return;
  if (!takeover) {
    throw new PredictionError(
      "INVALID_COMMAND",
      "Automation is connected to another worker. Request takeover after its heartbeat becomes stale.",
    );
  }
  if (!heartbeatIsStale(session.lastHeartbeatAt, now)) {
    throw new PredictionError(
      "INVALID_COMMAND",
      "Automation worker takeover is blocked while the current lease is active.",
    );
  }
}

export function shouldPersistHeartbeatDiagnostics(
  paused: boolean,
  observation?: Record<string, unknown>,
): boolean {
  if (paused) return false;
  if (!observation) return true;
  const entries = Object.entries(observation);
  return !(entries.length === 1 && entries[0]?.[0] === "stream" && entries[0]?.[1] === "connected");
}

export function validateAutomationTransition(
  session: SessionState,
  state: DomainState,
  action: AutomationAction,
): void {
  if (!session.enabled) throw new PredictionError("INVALID_COMMAND", "Automation is disabled.");
  if (session.paused) throw new PredictionError("INVALID_COMMAND", "Automation is paused.");
  if (
    (action.type === "add_contestant" || action.type === "remove_contestant") &&
    state.eventStatus !== "draft"
  ) {
    throw new PredictionError(
      "INVALID_COMMAND",
      "Contestants can only be changed on a draft event.",
    );
  }
  if (
    action.type === "sync_roster" &&
    state.eventStatus !== "draft" &&
    state.eventStatus !== "live"
  ) {
    throw new PredictionError("INVALID_COMMAND", "Contestant roles require a draft or live event.");
  }
  if (action.type === "activate_event" && state.eventStatus !== "draft") {
    throw new PredictionError("INVALID_COMMAND", "Automation can only activate a draft event.");
  }
  if (
    action.type !== "add_contestant" &&
    action.type !== "remove_contestant" &&
    action.type !== "sync_roster" &&
    action.type !== "activate_event" &&
    state.eventStatus !== "live"
  ) {
    throw new PredictionError("INVALID_COMMAND", "Arena automation requires a live event.");
  }
  if (action.type === "open_arena" && state.arenaStatus) {
    throw new PredictionError("INVALID_COMMAND", "Resolve the active arena first.");
  }
  if (action.type === "start_arena" && state.arenaStatus !== "open") {
    throw new PredictionError("INVALID_COMMAND", "Automation can only start an open arena.");
  }
  if (action.type === "record_result" && state.arenaStatus !== "locked") {
    throw new PredictionError(
      "INVALID_COMMAND",
      "Automation can only record a locked arena result.",
    );
  }
}
