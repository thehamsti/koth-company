import { describe, expect, test } from "bun:test";
import {
  automationStatus,
  shouldPersistHeartbeatDiagnostics,
  validateAutomationTransition,
  validateAutomationWorkerLease,
} from "./state";

const enabled = { enabled: true, paused: false, lastHeartbeatAt: new Date(100_000) };

describe("automation state", () => {
  test("reports stale workers after fifteen seconds", () => {
    expect(automationStatus(enabled, 115_001)).toBe("stale");
  });

  test("requires an explicit takeover after another worker becomes stale", () => {
    const lease = { workerId: "worker-a", lastHeartbeatAt: new Date(100_000) };

    expect(() => validateAutomationWorkerLease(lease, "worker-b", false, 115_001)).toThrow(
      "Request takeover",
    );
    expect(() => validateAutomationWorkerLease(lease, "worker-b", true, 115_000)).toThrow(
      "current lease is active",
    );
    expect(() => validateAutomationWorkerLease(lease, "worker-b", true, 115_001)).not.toThrow();
  });

  test("keeps the current worker lease renewable without takeover", () => {
    expect(() =>
      validateAutomationWorkerLease(
        { workerId: "worker-a", lastHeartbeatAt: new Date(100_000) },
        "worker-a",
        false,
        200_000,
      ),
    ).not.toThrow();
  });

  test("does not replace pause diagnostics with connection heartbeats", () => {
    expect(shouldPersistHeartbeatDiagnostics(false, { stream: "connected" })).toBeFalse();
    expect(shouldPersistHeartbeatDiagnostics(true, { confidence: 0.8 })).toBeFalse();
    expect(shouldPersistHeartbeatDiagnostics(false, { confidence: 0.8 })).toBeTrue();
  });

  test("blocks mutations while paused", () => {
    expect(() =>
      validateAutomationTransition(
        { ...enabled, paused: true },
        { eventStatus: "live", arenaStatus: "locked" },
        { type: "record_result" },
      ),
    ).toThrow("Automation is paused");
  });

  test("blocks roster changes after activation", () => {
    expect(() =>
      validateAutomationTransition(
        enabled,
        { eventStatus: "live", arenaStatus: null },
        { type: "add_contestant" },
      ),
    ).toThrow("draft event");
    expect(() =>
      validateAutomationTransition(
        enabled,
        { eventStatus: "live", arenaStatus: null },
        { type: "remove_contestant" },
      ),
    ).toThrow("draft event");
    expect(() =>
      validateAutomationTransition(
        enabled,
        { eventStatus: "draft", arenaStatus: null },
        { type: "remove_contestant" },
      ),
    ).not.toThrow();
  });

  test("allows automation to activate a draft event", () => {
    expect(() =>
      validateAutomationTransition(
        enabled,
        { eventStatus: "draft", arenaStatus: null },
        { type: "activate_event" },
      ),
    ).not.toThrow();
  });

  test("allows queue synchronization only while live", () => {
    expect(() =>
      validateAutomationTransition(
        enabled,
        { eventStatus: "live", arenaStatus: null },
        { type: "sync_queue" },
      ),
    ).not.toThrow();
    expect(() =>
      validateAutomationTransition(
        enabled,
        { eventStatus: "draft", arenaStatus: null },
        { type: "sync_queue" },
      ),
    ).toThrow("live event");
  });

  test("only records results for locked arenas", () => {
    expect(() =>
      validateAutomationTransition(
        enabled,
        { eventStatus: "live", arenaStatus: "open" },
        { type: "record_result" },
      ),
    ).toThrow("locked arena");
  });
});
