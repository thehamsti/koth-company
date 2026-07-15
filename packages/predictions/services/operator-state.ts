import { PredictionError } from "../types";

export type OperatorCommand =
  | { type: "create_event"; name: string; season: number; week: number }
  | { type: "add_contestant"; eventId: string; displayName: string; queuePosition?: number }
  | { type: "remove_contestant"; eventId: string; contestantId: string }
  | { type: "create_threshold"; eventId: string; contestantId: string; threshold: number }
  | { type: "activate_event"; eventId: string }
  | { type: "open_arena"; eventId: string; contestantId: string }
  | { type: "start_arena"; eventId: string; arenaId: string }
  | { type: "record_result"; eventId: string; arenaId: string; contestantWon: boolean }
  | { type: "correct_result"; eventId: string; arenaId: string; contestantWon: boolean }
  | { type: "complete_event"; eventId: string }
  | { type: "set_automation"; eventId: string; enabled: boolean }
  | { type: "pause_automation"; eventId: string; reason?: string }
  | { type: "resume_automation"; eventId: string }
  | {
      type: "review_proposal";
      eventId: string;
      proposalId: string;
      decision: "accepted" | "rejected";
    };

type EventState = {
  id: string;
  status: "draft" | "live" | "completed" | "cancelled";
};

type ContestantState = {
  id: string;
  eventId: string;
  displayName: string;
  status: "queued" | "active" | "eliminated" | "winner";
  wins: number;
};

type ArenaState = {
  id: string;
  eventId: string;
  contestantId: string;
  ordinal: number;
  status: "open" | "locked" | "settled" | "void";
};

export type OperatorTransitionState = {
  event: EventState | null;
  contestant: ContestantState | null;
  arena: ArenaState | null;
  activeArena: ArenaState | null;
  automation: { enabled: boolean; paused: boolean } | null;
};

function requireLiveEvent(event: EventState, action: string): void {
  if (event.status !== "live") {
    throw new PredictionError("INVALID_COMMAND", `${action} requires a live event.`);
  }
}

function requireAvailableContestant(
  contestant: ContestantState | null,
  eventId: string,
): ContestantState {
  if (!contestant) throw new PredictionError("INVALID_COMMAND", "Contestant not found.", 404);
  if (contestant.eventId !== eventId) {
    throw new PredictionError("INVALID_COMMAND", "Contestant does not belong to this event.");
  }
  if (contestant.status !== "queued" && contestant.status !== "active") {
    throw new PredictionError("INVALID_COMMAND", "Contestant is not available for this event.");
  }
  return contestant;
}

function requireOwnedArena(arena: ArenaState | null, eventId: string): ArenaState {
  if (!arena) throw new PredictionError("INVALID_COMMAND", "Arena not found.", 404);
  if (arena.eventId !== eventId) {
    throw new PredictionError("INVALID_COMMAND", "Arena does not belong to this event.");
  }
  return arena;
}

export function validateOperatorTransition(
  command: OperatorCommand,
  state: OperatorTransitionState,
): void {
  if (command.type === "create_event") return;
  if (!state.event) throw new PredictionError("EVENT_NOT_FOUND", "Event not found.", 404);

  const event = state.event;
  if (command.type === "add_contestant") {
    if (event.status !== "draft") {
      throw new PredictionError(
        "INVALID_COMMAND",
        "Contestants can only be added to a draft event.",
      );
    }
  } else if (command.type === "remove_contestant") {
    if (event.status !== "draft") {
      throw new PredictionError(
        "INVALID_COMMAND",
        "Contestants can only be removed from a draft event.",
      );
    }
    const contestant = requireAvailableContestant(state.contestant, event.id);
    if (contestant.status !== "queued") {
      throw new PredictionError("INVALID_COMMAND", "Only queued contestants can be removed.");
    }
  } else if (command.type === "activate_event") {
    if (event.status !== "draft") {
      throw new PredictionError("INVALID_COMMAND", "Only draft events can be activated.");
    }
  } else if (command.type === "create_threshold") {
    requireLiveEvent(event, "Creating a threshold market");
    const contestant = requireAvailableContestant(state.contestant, event.id);
    if (command.threshold <= contestant.wins) {
      throw new PredictionError(
        "INVALID_COMMAND",
        "Threshold must be greater than the contestant's current wins.",
      );
    }
  } else if (command.type === "open_arena") {
    requireLiveEvent(event, "Opening an arena");
    requireAvailableContestant(state.contestant, event.id);
    if (state.activeArena) {
      throw new PredictionError("INVALID_COMMAND", "Resolve the active arena first.");
    }
  } else if (command.type === "start_arena") {
    requireLiveEvent(event, "Starting an arena");
    const arena = requireOwnedArena(state.arena, event.id);
    if (arena.status !== "open") {
      throw new PredictionError("INVALID_COMMAND", "Only an open arena can be started.");
    }
    if (state.activeArena?.id !== arena.id) {
      throw new PredictionError("INVALID_COMMAND", "Arena does not match the active arena.");
    }
  } else if (command.type === "record_result") {
    requireLiveEvent(event, "Recording an arena result");
    const arena = requireOwnedArena(state.arena, event.id);
    if (arena.status !== "locked") {
      throw new PredictionError(
        "INVALID_COMMAND",
        "Results can only be recorded for a locked arena.",
      );
    }
    if (state.activeArena?.id !== arena.id) {
      throw new PredictionError("INVALID_COMMAND", "Arena does not match the active arena.");
    }
  } else if (command.type === "correct_result") {
    requireLiveEvent(event, "Correcting an arena result");
    const arena = requireOwnedArena(state.arena, event.id);
    if (arena.status !== "settled") {
      throw new PredictionError("INVALID_COMMAND", "Only a settled arena result can be corrected.");
    }
    if (state.activeArena) {
      throw new PredictionError(
        "INVALID_COMMAND",
        "Resolve the active arena before correcting a result.",
      );
    }
  } else if (command.type === "complete_event") {
    requireLiveEvent(event, "Completing an event");
    if (state.activeArena) {
      throw new PredictionError("INVALID_COMMAND", "Resolve the active arena first.");
    }
  } else if (command.type === "review_proposal") {
    requireLiveEvent(event, "Reviewing an automation proposal");
  } else if (command.type === "set_automation") {
    if (event.status !== "draft" && event.status !== "live") {
      throw new PredictionError(
        "INVALID_COMMAND",
        "Automation can only be changed for a draft or live event.",
      );
    }
    if (command.enabled && state.automation?.enabled) {
      throw new PredictionError(
        "INVALID_COMMAND",
        "Automation is already enabled; resume it explicitly if paused.",
      );
    }
  } else if (command.type === "pause_automation") {
    if (event.status !== "draft" && event.status !== "live") {
      throw new PredictionError(
        "INVALID_COMMAND",
        "Automation can only be paused for a draft or live event.",
      );
    }
    if (!state.automation?.enabled) {
      throw new PredictionError("INVALID_COMMAND", "Automation is not enabled.");
    }
    if (state.automation.paused) {
      throw new PredictionError("INVALID_COMMAND", "Automation is already paused.");
    }
  } else if (command.type === "resume_automation") {
    if (event.status !== "draft" && event.status !== "live") {
      throw new PredictionError(
        "INVALID_COMMAND",
        "Automation can only be resumed for a draft or live event.",
      );
    }
    if (!state.automation?.enabled || !state.automation.paused) {
      throw new PredictionError("INVALID_COMMAND", "Only paused automation can be resumed.");
    }
  }
}
