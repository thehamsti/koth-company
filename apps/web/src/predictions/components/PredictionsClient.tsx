"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { authClient } from "../auth-client";
import { apiErrorMessage } from "../api-error";
import { createRealtimeWatermarks, realtimePayload } from "../realtime-client";
import type {
  MarketSnapshot,
  PredictionPublicSnapshot,
  PredictionSnapshot,
  PublicMarketSnapshot,
  TradeQuote,
  ViewerAccountSnapshot,
} from "@koth/contracts";

const crowns = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 0 });

function mergeAccount(
  snapshot: PredictionSnapshot,
  account: ViewerAccountSnapshot | null,
): PredictionSnapshot {
  const currentEventId = snapshot.event?.id ?? null;
  const currentAccount = account?.eventId === currentEventId ? account : null;
  const shares = currentAccount?.sharesByOutcome ?? {};
  return {
    ...snapshot,
    portfolio: currentAccount?.portfolio ?? null,
    markets: snapshot.markets.map((market) => ({
      ...market,
      outcomes: market.outcomes.map((outcome) => ({
        ...outcome,
        viewerShares: shares[outcome.id] ?? "0",
      })),
    })),
  };
}

function mergePublicSnapshot(
  current: PredictionSnapshot,
  next: PredictionPublicSnapshot,
): PredictionSnapshot {
  const sameEvent = current.event?.id !== undefined && current.event.id === next.event?.id;
  const shares = sameEvent
    ? new Map(
        current.markets.flatMap((market) =>
          market.outcomes.map((outcome) => [outcome.id, outcome.viewerShares] as const),
        ),
      )
    : new Map<string, string>();
  return {
    ...next,
    portfolio: sameEvent ? current.portfolio : null,
    markets: next.markets.map((market) => ({
      ...market,
      outcomes: market.outcomes.map((outcome) => ({
        ...outcome,
        viewerShares: shares.get(outcome.id) ?? "0",
      })),
    })),
  };
}

function mergeMarket(
  current: PredictionSnapshot,
  market: PublicMarketSnapshot,
): PredictionSnapshot {
  const existing = current.markets.find((candidate) => candidate.id === market.id);
  if (existing && market.version < existing.version) return current;
  const nextMarket: MarketSnapshot = {
    ...market,
    outcomes: market.outcomes.map((outcome) => ({
      ...outcome,
      viewerShares:
        existing?.outcomes.find((candidate) => candidate.id === outcome.id)?.viewerShares ?? "0",
    })),
  };
  const found = current.markets.some((candidate) => candidate.id === market.id);
  return {
    ...current,
    markets: found
      ? current.markets.map((candidate) => (candidate.id === market.id ? nextMarket : candidate))
      : [nextMarket, ...current.markets],
  };
}

function groupLabel(kind: MarketSnapshot["kind"]): string {
  if (kind === "live_arena") return "Live arena";
  if (kind === "win_threshold") return "Milestones";
  return "Event winner";
}

export function PredictionsClient({ initial }: { initial: PredictionSnapshot }) {
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const sessionUserId = session?.user.id ?? null;
  const [snapshot, setSnapshot] = useState(initial);
  const [selected, setSelected] = useState<{ marketId: string; outcomeId: string } | null>(null);
  const [amount, setAmount] = useState("100");
  const [quote, setQuote] = useState<TradeQuote | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [ranking, setRanking] = useState<"event" | "season">("event");
  const [connectionNotice, setConnectionNotice] = useState("");
  const pendingAccount = useRef<ViewerAccountSnapshot | null>(null);

  useEffect(() => {
    if (sessionPending || typeof EventSource === "undefined") return;
    const watermarks = createRealtimeWatermarks();
    let active = true;
    pendingAccount.current = null;
    const source = new EventSource("/api/predictions/events");
    source.addEventListener("open", () => setConnectionNotice(""));
    source.addEventListener("error", () => setConnectionNotice("Live updates reconnecting…"));
    source.addEventListener("public.snapshot", (rawEvent) => {
      if (!active) return;
      const payload = realtimePayload<PredictionPublicSnapshot>(
        "public.snapshot",
        rawEvent as MessageEvent<string>,
        watermarks,
      );
      if (!payload) return;
      setSnapshot((current) => {
        const next = mergePublicSnapshot(current, payload);
        if (pendingAccount.current?.eventId !== (next.event?.id ?? null)) return next;
        const account = pendingAccount.current;
        pendingAccount.current = null;
        return mergeAccount(next, account);
      });
    });
    source.addEventListener("market.updated", (rawEvent) => {
      if (!active) return;
      const payload = realtimePayload<{ market: PublicMarketSnapshot }>(
        "market.updated",
        rawEvent as MessageEvent<string>,
        watermarks,
      );
      if (payload) setSnapshot((current) => mergeMarket(current, payload.market));
    });
    source.addEventListener("leaderboards.updated", (rawEvent) => {
      if (!active) return;
      const payload = realtimePayload<
        Pick<PredictionPublicSnapshot, "leaderboard" | "seasonLeaderboard">
      >("leaderboards.updated", rawEvent as MessageEvent<string>, watermarks);
      if (payload) setSnapshot((current) => ({ ...current, ...payload }));
    });
    source.addEventListener("account.updated", (rawEvent) => {
      if (!active) return;
      const payload = realtimePayload<ViewerAccountSnapshot>(
        "account.updated",
        rawEvent as MessageEvent<string>,
        watermarks,
      );
      if (!payload) return;
      setSnapshot((current) => {
        if (payload.eventId !== (current.event?.id ?? null)) {
          pendingAccount.current = payload;
          return mergeAccount(current, null);
        }
        pendingAccount.current = null;
        return mergeAccount(current, payload);
      });
    });
    source.addEventListener("accounts.invalidated", (rawEvent) => {
      if (!active) return;
      const payload = realtimePayload<{
        eventId: string | null;
        reason: "event_changed";
      }>("accounts.invalidated", rawEvent as MessageEvent<string>, watermarks);
      if (!payload || !sessionUserId) return;
      pendingAccount.current = null;
      setSnapshot((current) => mergeAccount(current, null));
    });
    return () => {
      active = false;
      source.close();
    };
  }, [sessionPending, sessionUserId]);

  useEffect(() => {
    if (!sessionPending && !sessionUserId) {
      pendingAccount.current = null;
      setSnapshot((current) => mergeAccount(current, null));
    }
  }, [sessionPending, sessionUserId]);

  const grouped = useMemo(() => {
    return snapshot.markets.reduce<Record<string, MarketSnapshot[]>>((groups, market) => {
      const label = groupLabel(market.kind);
      groups[label] = [...(groups[label] ?? []), market];
      return groups;
    }, {});
  }, [snapshot.markets]);

  const selectedMarket = selected
    ? snapshot.markets.find((market) => market.id === selected.marketId)
    : null;
  const predictionNotice = notice || connectionNotice;

  async function requestQuote(side: "buy" | "sell" = "buy") {
    if (!selected || !selectedMarket) return;
    setBusy(true);
    setNotice("");
    try {
      const response = await fetch("/api/predictions/quotes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          marketId: selectedMarket.id,
          outcomeId: selected.outcomeId,
          side,
          amount,
        }),
      });
      const data = (await response.json()) as TradeQuote & { error?: { message: string } };
      if (!response.ok) throw new Error(apiErrorMessage(data, "Quote unavailable."));
      setQuote(data);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Quote unavailable.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmTrade() {
    if (!quote) return;
    setBusy(true);
    try {
      const response = await fetch("/api/predictions/trades", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quoteId: quote.id, idempotencyKey: crypto.randomUUID() }),
      });
      const data = (await response.json()) as {
        market?: PublicMarketSnapshot;
        account?: ViewerAccountSnapshot;
        error?: { message: string };
      };
      if (!response.ok) throw new Error(apiErrorMessage(data, "Trade failed."));
      const market = data.market;
      const account = data.account;
      if (market) setSnapshot((current) => mergeMarket(current, market));
      if (account) setSnapshot((current) => mergeAccount(current, account));
      setQuote(null);
      setSelected(null);
      setNotice("Position confirmed.");
    } catch (error) {
      setQuote(null);
      setNotice(error instanceof Error ? error.message : "Trade failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="prediction-page">
      <header className="prediction-header">
        <Link href="/" className="prediction-brand" aria-label="Back to KOTH">
          <Image src="/assets/hydramist-mark.png" alt="" width={44} height={44} />
          <span>
            <b>KOTH</b>
            <small>Forecast exchange</small>
          </span>
        </Link>
        <div className="prediction-account">
          {snapshot.portfolio ? (
            <b>{crowns.format(Number(snapshot.portfolio.availableCrowns))} Crowns</b>
          ) : null}
          {session?.user ? (
            <div className="prediction-viewer">
              {session.user.image ? (
                <Image
                  className="prediction-viewer-avatar"
                  src={session.user.image}
                  alt={`${session.user.name}'s Twitch profile`}
                  width={36}
                  height={36}
                />
              ) : (
                <span className="prediction-viewer-fallback" aria-hidden="true">
                  {session.user.name.trim().charAt(0).toUpperCase() || "?"}
                </span>
              )}
              <span className="prediction-viewer-name">
                <small>Signed in as</small>
                <strong>{session.user.name}</strong>
              </span>
              <button className="prediction-quiet" onClick={() => authClient.signOut()}>
                Sign out
              </button>
            </div>
          ) : (
            <button
              className="prediction-login"
              onClick={() =>
                authClient.signIn.social({ provider: "twitch", callbackURL: "/predictions" })
              }
            >
              Sign in with Twitch
            </button>
          )}
        </div>
      </header>

      <div className="prediction-shell">
        <section className="prediction-intro">
          <div>
            <span className="prediction-kicker">Crowd probability · Live</span>
            <h1>Call the hill.</h1>
            <p>Trade free Crowns on streaks and arena outcomes, then climb the forecaster ranks.</p>
          </div>
          {snapshot.event ? (
            <div className="prediction-event">
              <small>
                {snapshot.event.status === "completed" ? "Latest event" : "Active event"}
              </small>
              <strong>{snapshot.event.name}</strong>
              <span>
                Season {snapshot.event.season} · Week {snapshot.event.week}
              </span>
            </div>
          ) : null}
        </section>

        {!snapshot.enabled ? (
          <div className="prediction-empty">
            <strong>The exchange is being calibrated.</strong>
            <p>Predictions will open before the next KOTH.</p>
          </div>
        ) : !snapshot.event ? (
          <div className="prediction-empty">
            <strong>No active market.</strong>
            <p>Check back when the arena gates open.</p>
          </div>
        ) : (
          <div className="prediction-layout">
            <div className="prediction-markets">
              {Object.entries(grouped).map(([label, markets]) => (
                <section key={label} className="market-group">
                  <div className="market-group-title">
                    <h2>{label}</h2>
                    <span>
                      {markets.length} market{markets.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {markets.map((market) => (
                    <article className="market-card" key={market.id}>
                      <div className="market-copy">
                        <span className={`market-state market-state-${market.status}`}>
                          {market.status}
                        </span>
                        <h3>{market.title}</h3>
                      </div>
                      <div className="market-outcomes">
                        {market.outcomes.map((outcome) => (
                          <button
                            key={outcome.id}
                            disabled={market.status !== "open"}
                            aria-pressed={
                              selected?.marketId === market.id && selected.outcomeId === outcome.id
                            }
                            onClick={() => {
                              setSelected({ marketId: market.id, outcomeId: outcome.id });
                              setQuote(null);
                            }}
                            className={
                              selected?.marketId === market.id && selected.outcomeId === outcome.id
                                ? "selected"
                                : ""
                            }
                          >
                            <span>{outcome.label}</span>
                            <b>{percent.format(outcome.probability)}</b>
                            <i style={{ transform: `scaleX(${outcome.probability})` }} />
                            {Number(outcome.viewerShares) > 0 ? (
                              <small>{Number(outcome.viewerShares).toFixed(2)} shares</small>
                            ) : null}
                          </button>
                        ))}
                      </div>
                    </article>
                  ))}
                </section>
              ))}
            </div>

            <aside className="prediction-sidebar">
              <section className={`trade-ticket${selected && selectedMarket ? " is-active" : ""}`}>
                <span className="prediction-kicker">Position ticket</span>
                {selected && selectedMarket ? (
                  <>
                    <button
                      type="button"
                      className="trade-ticket-close"
                      onClick={() => {
                        setSelected(null);
                        setQuote(null);
                      }}
                    >
                      Close
                    </button>
                    <h2>{selectedMarket.title}</h2>
                    <p>
                      {
                        selectedMarket.outcomes.find((outcome) => outcome.id === selected.outcomeId)
                          ?.label
                      }
                    </p>
                    <label>
                      Crowns or shares
                      <input
                        value={amount}
                        inputMode="decimal"
                        onChange={(event) => {
                          setAmount(event.target.value);
                          setQuote(null);
                        }}
                      />
                    </label>
                    {!quote ? (
                      <div className="ticket-actions">
                        <button disabled={!session || busy} onClick={() => requestQuote("buy")}>
                          Preview buy
                        </button>
                        <button disabled={!session || busy} onClick={() => requestQuote("sell")}>
                          Preview sell
                        </button>
                      </div>
                    ) : (
                      <div className="quote-preview">
                        <dl>
                          <div>
                            <dt>Shares</dt>
                            <dd>{Number(quote.shareAmount).toFixed(2)}</dd>
                          </div>
                          <div>
                            <dt>Average</dt>
                            <dd>{percent.format(Number(quote.averagePrice))}</dd>
                          </div>
                          <div>
                            <dt>Crowns</dt>
                            <dd>{crowns.format(Number(quote.crownAmount))}</dd>
                          </div>
                        </dl>
                        <button disabled={busy} onClick={confirmTrade}>
                          Confirm position
                        </button>
                      </div>
                    )}
                    {!session ? <small>Sign in with Twitch to take a position.</small> : null}
                  </>
                ) : (
                  <p>Select an outcome to preview a position.</p>
                )}
              </section>
              <section className="forecaster-board">
                <div className="market-group-title">
                  <h2>Forecasters</h2>
                  <div className="ranking-tabs" role="group" aria-label="Leaderboard period">
                    <button
                      className={ranking === "event" ? "active" : ""}
                      aria-pressed={ranking === "event"}
                      onClick={() => setRanking("event")}
                    >
                      Event
                    </button>
                    <button
                      className={ranking === "season" ? "active" : ""}
                      aria-pressed={ranking === "season"}
                      onClick={() => setRanking("season")}
                    >
                      Season
                    </button>
                  </div>
                </div>
                <ol>
                  {ranking === "event"
                    ? snapshot.leaderboard.map((entry, index) => (
                        <li key={entry.userId}>
                          <span>{index + 1}</span>
                          <b>{entry.name}</b>
                          <em>
                            {Number(entry.returnPercent) >= 0 ? "+" : ""}
                            {entry.returnPercent}%
                          </em>
                        </li>
                      ))
                    : snapshot.seasonLeaderboard.map((entry, index) => (
                        <li key={entry.userId}>
                          <span>{index + 1}</span>
                          <b>
                            {entry.name}
                            <small>{entry.eventsPlayed} events</small>
                          </b>
                          <em>
                            {Number(entry.score) >= 0 ? "+" : ""}
                            {entry.score}
                          </em>
                        </li>
                      ))}
                </ol>
              </section>
            </aside>
          </div>
        )}
        <p className="prediction-disclaimer">
          Crowns are free and have no monetary value. No purchase, transfer, redemption, or prizes.
        </p>
        <div className={`prediction-notice${predictionNotice ? " is-visible" : ""}`} role="status">
          {predictionNotice}
        </div>
      </div>
    </main>
  );
}
