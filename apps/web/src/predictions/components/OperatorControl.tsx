"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { OperatorState } from "@koth/contracts";
import { apiErrorMessage } from "../api-error";
import { createRealtimeWatermarks, realtimePayload } from "../realtime-client";

export function OperatorControl({ initial }: { initial: OperatorState }) {
  const [state, setState] = useState(initial);
  const [eventName, setEventName] = useState("KOTH");
  const [season, setSeason] = useState("2");
  const [week, setWeek] = useState("1");
  const [contestant, setContestant] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [connectionNotice, setConnectionNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const contestantInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const watermarks = createRealtimeWatermarks();
    const source = new EventSource("/api/predictions/operator/events");
    source.addEventListener("open", () => setConnectionNotice(""));
    source.addEventListener("error", () => setConnectionNotice("Control stream reconnecting…"));
    source.addEventListener("operator.state", (rawEvent) => {
      const next = realtimePayload<OperatorState>(
        "operator.state",
        rawEvent as MessageEvent<string>,
        watermarks,
      );
      if (next) setState(next);
    });
    return () => source.close();
  }, []);

  useEffect(() => {
    if (!state.automation?.lastHeartbeatAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [state.automation?.lastHeartbeatAt]);

  async function command(value: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/predictions/operator/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: value, idempotencyKey: crypto.randomUUID() }),
      });
      const body = (await response.json()) as {
        state?: OperatorState;
        warnings?: Array<{ message: string }>;
      };
      if (!response.ok) throw new Error(apiErrorMessage(body, "Command failed."));
      if (body.state) setState(body.state);
      if (body.warnings?.length)
        setNotice(body.warnings.map((warning) => warning.message).join(" "));
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Command failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function configureTwitch(path: string, successMessage: string): Promise<void> {
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch(path, { method: "POST" });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(apiErrorMessage(body, "Twitch setup failed."));
      setNotice(successMessage);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Twitch setup failed.");
    } finally {
      setBusy(false);
    }
  }

  async function addContestant(): Promise<void> {
    const displayName = contestant.trim();
    if (!state.event || !displayName || busy) return;
    const added = await command({
      type: "add_contestant",
      eventId: state.event.id,
      displayName,
      queuePosition: Math.max(0, ...state.contestants.map((entry) => entry.queuePosition ?? 0)) + 1,
    });
    if (added) setContestant("");
    contestantInputRef.current?.focus();
  }

  useEffect(() => {
    function focusContestantInput(event: KeyboardEvent): void {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target &&
        "closest" in target &&
        typeof target.closest === "function" &&
        target.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      event.preventDefault();
      contestantInputRef.current?.focus();
    }

    window.addEventListener("keydown", focusContestantInput);
    return () => window.removeEventListener("keydown", focusContestantInput);
  }, []);

  const activeArena = state.arenas.find(
    (arena) => arena.status === "open" || arena.status === "locked",
  );
  const activeContestant = state.contestants.find(
    (entry) => entry.id === activeArena?.contestantId,
  );
  const queuedContestants = state.contestants.filter((entry) => entry.status !== "eliminated");
  const openMarkets = state.markets.filter((market) => market.status === "open").length;
  const heartbeatAt = state.automation?.lastHeartbeatAt
    ? new Date(state.automation.lastHeartbeatAt).getTime()
    : null;
  const automationStatus = state.automation?.status ?? "disabled";

  return (
    <main className="control-page">
      <header className="control-header">
        <div>
          <span>KOTH operations</span>
          <h1>Forecast control</h1>
        </div>
        <Link href="/predictions">
          Open viewer exchange <span aria-hidden="true">↗</span>
        </Link>
      </header>
      <div className="control-shell">
        {!state.event || state.event.status === "completed" ? (
          <section className="control-setup" aria-labelledby="create-event-title">
            <div className="control-setup-copy">
              <span className="control-eyebrow">No active event</span>
              <h2 id="create-event-title">Prepare the next KOTH</h2>
              <p>Create the event first, then load the contestant queue before opening markets.</p>
            </div>
            <div className="control-setup-form">
              <label>
                Event name
                <input value={eventName} onChange={(event) => setEventName(event.target.value)} />
              </label>
              <div className="control-row">
                <label>
                  Season
                  <input
                    value={season}
                    inputMode="numeric"
                    onChange={(event) => setSeason(event.target.value)}
                  />
                </label>
                <label>
                  Week
                  <input
                    value={week}
                    inputMode="numeric"
                    onChange={(event) => setWeek(event.target.value)}
                  />
                </label>
              </div>
              <button
                className="control-action control-action-primary"
                disabled={busy}
                onClick={() =>
                  command({
                    type: "create_event",
                    name: eventName,
                    season: Number(season),
                    week: Number(week),
                  })
                }
              >
                Create event
              </button>
            </div>
          </section>
        ) : (
          <>
            <section className="control-event-strip" aria-label="Current event status">
              <div className="control-event-name">
                <span className={`control-status control-status-${state.event.status}`}>
                  <i />
                  {state.event.status}
                </span>
                <div>
                  <h2>{state.event.name}</h2>
                  <p>
                    Season {state.event.season} · Week {state.event.week}
                  </p>
                </div>
              </div>
              <dl className="control-event-stats">
                <div>
                  <dt>Queue</dt>
                  <dd>{queuedContestants.length}</dd>
                </div>
                <div>
                  <dt>Markets open</dt>
                  <dd>{openMarkets}</dd>
                </div>
                <div>
                  <dt>Arenas</dt>
                  <dd>{state.arenas.length}</dd>
                </div>
              </dl>
              {state.event.status === "draft" ? (
                <button
                  className="control-action control-action-primary"
                  disabled={busy || state.contestants.length < 2}
                  onClick={() => command({ type: "activate_event", eventId: state.event?.id })}
                >
                  Open event markets
                </button>
              ) : (
                <button
                  className="control-action control-action-subtle"
                  disabled={busy || Boolean(activeArena)}
                  onClick={() => command({ type: "complete_event", eventId: state.event?.id })}
                >
                  Complete event
                </button>
              )}
            </section>
            <div className="control-workspace">
              <section className="control-queue-panel" aria-labelledby="queue-title">
                <div className="control-panel-heading">
                  <div>
                    <span>Contestants</span>
                    <h2 id="queue-title">Queue</h2>
                  </div>
                  <b>{state.contestants.length}</b>
                </div>
                <div className="control-add-row">
                  <label className="sr-only" htmlFor="contestant-name">
                    Character name
                  </label>
                  <input
                    id="contestant-name"
                    ref={contestantInputRef}
                    value={contestant}
                    placeholder="Add character name…"
                    autoComplete="off"
                    onChange={(event) => setContestant(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void addContestant();
                      } else if (event.key === "Escape") {
                        event.preventDefault();
                        setContestant("");
                        event.currentTarget.blur();
                      }
                    }}
                  />
                  <button
                    className="control-action control-action-primary"
                    disabled={busy || !contestant.trim()}
                    onClick={() => void addContestant()}
                  >
                    Add
                  </button>
                  <span className="control-shortcuts">
                    <kbd>/</kbd> Focus <kbd>↵</kbd> Add <kbd>Esc</kbd> Clear
                  </span>
                </div>
                {state.contestants.length ? (
                  <ol className="control-queue-list">
                    {state.contestants.map((entry, index) => (
                      <li
                        key={entry.id}
                        className={entry.id === activeContestant?.id ? "is-active" : ""}
                      >
                        <span className="control-queue-rank">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <div className="control-contestant">
                          <b>{entry.displayName}</b>
                          <small>
                            <i className={`contestant-dot contestant-dot-${entry.status}`} />
                            {entry.status}
                            <span>·</span>
                            {entry.wins} wins
                          </small>
                        </div>
                        <div className="control-row-actions">
                          {state.event?.status === "draft" ? (
                            <button
                              className="danger"
                              aria-label={`Remove ${entry.displayName} from queue`}
                              disabled={busy}
                              onClick={() =>
                                command({
                                  type: "remove_contestant",
                                  eventId: state.event?.id,
                                  contestantId: entry.id,
                                })
                              }
                            >
                              Remove
                            </button>
                          ) : null}
                          <button
                            disabled={
                              busy ||
                              Boolean(activeArena) ||
                              state.event?.status !== "live" ||
                              entry.status === "eliminated"
                            }
                            onClick={() =>
                              command({
                                type: "open_arena",
                                eventId: state.event?.id,
                                contestantId: entry.id,
                              })
                            }
                          >
                            Open arena
                          </button>
                          <button
                            className="control-icon-action"
                            title={`Create a market for win ${entry.wins + 1}`}
                            aria-label={`Create next-win market for ${entry.displayName}`}
                            disabled={busy || state.event?.status !== "live"}
                            onClick={() =>
                              command({
                                type: "create_threshold",
                                eventId: state.event?.id,
                                contestantId: entry.id,
                                threshold: entry.wins + 1,
                              })
                            }
                          >
                            +1
                          </button>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="control-queue-empty">
                    <strong>Queue is empty</strong>
                    <p>Add at least two contestants to open event markets.</p>
                  </div>
                )}
              </section>

              <aside className="control-live-rail">
                <section className="control-automation-panel" aria-labelledby="automation-title">
                  <div className="control-panel-heading">
                    <div>
                      <span>Stream worker</span>
                      <h2 id="automation-title">Vision automation</h2>
                    </div>
                    <span className={`automation-state automation-state-${automationStatus}`}>
                      <i />
                      {automationStatus}
                    </span>
                  </div>
                  <div className="automation-summary">
                    <span>
                      Worker
                      <b>{state.automation?.workerId ?? "Not connected"}</b>
                    </span>
                    <span>
                      Heartbeat
                      <b>
                        {heartbeatAt
                          ? `${Math.max(0, Math.round((now - heartbeatAt) / 1_000))}s ago`
                          : "Never"}
                      </b>
                    </span>
                  </div>
                  {state.automation?.pauseReason ? (
                    <p className="automation-reason">{state.automation.pauseReason}</p>
                  ) : null}
                  {state.automation?.evidenceImage ? (
                    <Image
                      className="automation-evidence"
                      src={state.automation.evidenceImage}
                      alt="Latest CV evidence"
                      width={640}
                      height={360}
                      unoptimized
                    />
                  ) : null}
                  {Object.keys(state.automation?.lastObservation ?? {}).length ? (
                    <code className="automation-observation">
                      {JSON.stringify(state.automation?.lastObservation)}
                    </code>
                  ) : null}
                  <div className="automation-actions">
                    {automationStatus === "disabled" ? (
                      <button
                        className="control-action control-action-primary"
                        disabled={busy}
                        onClick={() =>
                          command({
                            type: "set_automation",
                            eventId: state.event?.id,
                            enabled: true,
                          })
                        }
                      >
                        Enable CV
                      </button>
                    ) : automationStatus === "paused" ? (
                      <button
                        className="control-action control-action-primary"
                        disabled={busy}
                        onClick={() =>
                          command({ type: "resume_automation", eventId: state.event?.id })
                        }
                      >
                        Resume CV
                      </button>
                    ) : (
                      <button
                        className="control-action control-action-primary"
                        disabled={busy}
                        onClick={() =>
                          command({ type: "pause_automation", eventId: state.event?.id })
                        }
                      >
                        Pause CV
                      </button>
                    )}
                    {state.automation?.enabled ? (
                      <button
                        className="control-action control-action-subtle"
                        disabled={busy}
                        onClick={() =>
                          command({
                            type: "set_automation",
                            eventId: state.event?.id,
                            enabled: false,
                          })
                        }
                      >
                        Disable
                      </button>
                    ) : null}
                  </div>
                </section>
                <section
                  className={`control-arena-panel ${activeArena ? "has-arena" : ""}`}
                  aria-labelledby="arena-title"
                >
                  <div className="control-panel-heading">
                    <div>
                      <span>Live operation</span>
                      <h2 id="arena-title">Active arena</h2>
                    </div>
                    {activeArena ? <b>#{activeArena.ordinal}</b> : null}
                  </div>
                  {activeArena && activeContestant ? (
                    <div className="control-arena-body">
                      <span className={`control-status control-status-${activeArena.status}`}>
                        <i />
                        {activeArena.status}
                      </span>
                      <h3>{activeContestant.displayName}</h3>
                      <p>
                        {activeArena.status === "open"
                          ? "Market is open. Lock it when the gates are ready."
                          : "Record the result as soon as the arena ends."}
                      </p>
                      {activeArena.status === "open" ? (
                        <button
                          className="control-action control-action-primary control-action-wide"
                          disabled={busy}
                          onClick={() =>
                            command({
                              type: "start_arena",
                              eventId: state.event?.id,
                              arenaId: activeArena.id,
                            })
                          }
                        >
                          Lock market & start
                        </button>
                      ) : (
                        <div className="result-actions">
                          <button
                            disabled={busy}
                            onClick={() =>
                              command({
                                type: "record_result",
                                eventId: state.event?.id,
                                arenaId: activeArena.id,
                                contestantWon: true,
                              })
                            }
                          >
                            Won
                          </button>
                          <button
                            disabled={busy}
                            className="danger"
                            onClick={() =>
                              command({
                                type: "record_result",
                                eventId: state.event?.id,
                                arenaId: activeArena.id,
                                contestantWon: false,
                              })
                            }
                          >
                            Lost
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="control-arena-empty">
                      <span>01</span>
                      <strong>Choose the next contestant</strong>
                      <p>Use “Open arena” from the queue to create the live market.</p>
                    </div>
                  )}
                </section>
              </aside>
            </div>

            <details className="control-disclosure">
              <summary>
                <span>
                  <b>Markets</b>
                  <small>Review current market state</small>
                </span>
                <em>{state.markets.length}</em>
              </summary>
              <ul className="control-markets">
                {state.markets.map((market) => (
                  <li key={market.id}>
                    <span>{market.status}</span>
                    <b>{market.title}</b>
                  </li>
                ))}
              </ul>
            </details>
            {state.proposals.length ? (
              <section className="control-proposals">
                <div className="control-panel-heading">
                  <div>
                    <span>Automation review</span>
                    <h2>Vision proposals</h2>
                  </div>
                  <b>{state.proposals.length}</b>
                </div>
                <ul className="control-markets">
                  {state.proposals.map((proposal) => (
                    <li key={proposal.id}>
                      <span>
                        {proposal.kind} · {Math.round(Number(proposal.confidence) * 100)}%
                      </span>
                      <b>{JSON.stringify(proposal.payload)}</b>
                      <div className="result-actions">
                        <button
                          onClick={() =>
                            command({
                              type: "review_proposal",
                              eventId: state.event?.id,
                              proposalId: proposal.id,
                              decision: "accepted",
                            })
                          }
                        >
                          Accept
                        </button>
                        <button
                          className="danger"
                          onClick={() =>
                            command({
                              type: "review_proposal",
                              eventId: state.event?.id,
                              proposalId: proposal.id,
                              decision: "rejected",
                            })
                          }
                        >
                          Reject
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
        <details className="control-disclosure">
          <summary>
            <span>
              <b>Twitch channel points</b>
              <small>Connect the broadcaster, create rewards, and sync EventSub</small>
            </span>
            <em>Setup</em>
          </summary>
          <div className="control-integration-setup">
            <p>
              Connect while signed into the configured broadcaster account. Reward setup and webhook
              sync are safe to rerun after configuration changes.
            </p>
            <div className="automation-actions">
              <a
                className="control-action control-action-primary"
                href="/api/predictions/admin/twitch-connect"
              >
                Connect broadcaster
              </a>
              <button
                className="control-action control-action-subtle"
                disabled={busy}
                onClick={() =>
                  void configureTwitch(
                    "/api/predictions/admin/twitch-rewards",
                    "Twitch rewards synchronized.",
                  )
                }
              >
                Sync rewards
              </button>
              <button
                className="control-action control-action-subtle"
                disabled={busy}
                onClick={() =>
                  void configureTwitch(
                    "/api/predictions/admin/twitch-eventsub",
                    "Twitch EventSub synchronized.",
                  )
                }
              >
                Sync webhook
              </button>
            </div>
          </div>
        </details>
      </div>
      <div
        className={`control-toast ${notice || connectionNotice ? "is-visible" : ""}`}
        aria-live="polite"
      >
        {notice || connectionNotice}
      </div>
    </main>
  );
}
