import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PredictionSnapshot } from "../types";
import { FakeEventSource } from "../fake-event-source.test-support";

let sessionData: { user: { id: string; name: string; image?: string | null } } | null = null;
let sessionPending = false;
const originalFetch = globalThis.fetch;

mock.module("../auth-client", () => ({
  authClient: {
    useSession: () => ({ data: sessionData, isPending: sessionPending }),
    signIn: { social: () => Promise.resolve() },
    signOut: () => Promise.resolve(),
  },
}));

const { PredictionsClient } = await import("./PredictionsClient");

afterEach(() => {
  sessionData = null;
  sessionPending = false;
  globalThis.fetch = originalFetch;
  cleanup();
  FakeEventSource.reset();
  delete (globalThis as { EventSource?: typeof EventSource }).EventSource;
});

const snapshot = {
  enabled: true,
  event: { id: "event", name: "KOTH Week 1", season: 2, week: 1, status: "live" },
  portfolio: null,
  markets: [
    {
      id: "market",
      version: 1,
      kind: "live_arena",
      status: "open",
      title: "Hydra wins the next arena",
      locksAt: null,
      outcomes: [
        { id: "yes", label: "Wins", probability: 0.63, viewerShares: "0" },
        { id: "no", label: "Loses", probability: 0.37, viewerShares: "0" },
      ],
    },
  ],
  leaderboard: [],
  seasonLeaderboard: [],
} satisfies PredictionSnapshot;

describe("PredictionsClient", () => {
  test("shows live probabilities and explains the free currency", () => {
    render(<PredictionsClient initial={snapshot} />);

    expect(screen.getByRole("heading", { name: "Call the hill." })).toBeTruthy();
    expect(screen.getByText("63%")).toBeTruthy();
    expect(screen.getByText(/Crowns are free and have no monetary value/)).toBeTruthy();
  });

  test("opens a position ticket without implying a valuable wager", () => {
    render(<PredictionsClient initial={snapshot} />);

    const outcome = screen.getByRole("button", { name: /Wins 63%/ });
    expect(outcome.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(outcome);

    expect(outcome.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("heading", { name: "Hydra wins the next arena", level: 2 }),
    ).toBeTruthy();
    expect(screen.getByText("Sign in with Twitch to take a position.")).toBeTruthy();
    expect(screen.getByText("Position ticket").closest(".trade-ticket")?.classList).toContain(
      "is-active",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(outcome.getAttribute("aria-pressed")).toBe("false");
    expect(
      screen.queryByRole("heading", { name: "Hydra wins the next arena", level: 2 }),
    ).toBeNull();
    expect(screen.getByText("Select an outcome to preview a position.")).toBeTruthy();
    expect(screen.getByText("Position ticket").closest(".trade-ticket")?.classList).not.toContain(
      "is-active",
    );
  });

  test("labels the leaderboard period toggle and exposes its pressed state", () => {
    render(<PredictionsClient initial={snapshot} />);

    const toggle = screen.getByRole("group", { name: "Leaderboard period" });
    const event = screen.getByRole("button", { name: "Event" });
    const season = screen.getByRole("button", { name: "Season" });
    expect(toggle.contains(event)).toBe(true);
    expect(toggle.contains(season)).toBe(true);
    expect(event.getAttribute("aria-pressed")).toBe("true");
    expect(season.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(season);

    expect(event.getAttribute("aria-pressed")).toBe("false");
    expect(season.getAttribute("aria-pressed")).toBe("true");
  });

  test("shows reconnect status through the prediction notice", () => {
    (globalThis as { EventSource?: typeof EventSource }).EventSource =
      FakeEventSource as unknown as typeof EventSource;
    render(<PredictionsClient initial={snapshot} />);
    const source = FakeEventSource.instances[0];
    const status = screen.getByRole("status");
    expect(status.classList).not.toContain("is-visible");

    act(() => source?.dispatchEvent(new Event("error")));

    expect(status.textContent).toBe("Live updates reconnecting…");
    expect(status.classList).toContain("is-visible");

    act(() => source?.dispatchEvent(new Event("open")));

    expect(status.textContent).toBe("");
    expect(status.classList).not.toContain("is-visible");
  });

  test("closing a position ticket discards its quote", async () => {
    sessionData = { user: { id: "viewer", name: "Hydra" } };
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({
          id: "quote",
          shareAmount: "10",
          averagePrice: "0.63",
          crownAmount: "6.3",
        }),
      ),
    ) as unknown as typeof fetch;
    render(<PredictionsClient initial={snapshot} />);

    fireEvent.click(screen.getByRole("button", { name: /Wins 63%/ }));
    fireEvent.click(screen.getByRole("button", { name: "Preview buy" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Confirm position" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: /Wins 63%/ }));

    expect(screen.queryByRole("button", { name: "Confirm position" })).toBeNull();
    expect(screen.getByRole("button", { name: "Preview buy" })).toBeTruthy();
  });

  test("identifies the signed-in Twitch viewer", () => {
    sessionData = { user: { id: "viewer", name: "Hydra" } };

    render(<PredictionsClient initial={snapshot} />);

    expect(screen.getByText("Signed in as")).toBeTruthy();
    expect(screen.getByText("Hydra")).toBeTruthy();
    expect(screen.getByText("H").getAttribute("aria-hidden")).toBe("true");
  });

  test("applies streamed market updates without polling the snapshot endpoint", () => {
    (globalThis as { EventSource?: typeof EventSource }).EventSource =
      FakeEventSource as unknown as typeof EventSource;
    render(<PredictionsClient initial={snapshot} />);

    const source = FakeEventSource.instances[0];
    expect(source?.url).toBe("/api/predictions/events");
    act(() => {
      source?.emit("market.updated", {
        market: {
          ...snapshot.markets[0],
          outcomes: [
            { id: "yes", label: "Wins", probability: 0.71 },
            { id: "no", label: "Loses", probability: 0.29 },
          ],
        },
      });
    });

    expect(screen.getByText("71%")).toBeTruthy();
  });

  test("waits for session resolution before opening the stream", () => {
    sessionPending = true;
    (globalThis as { EventSource?: typeof EventSource }).EventSource =
      FakeEventSource as unknown as typeof EventSource;

    render(<PredictionsClient initial={snapshot} />);

    expect(FakeEventSource.instances).toHaveLength(0);
  });

  test("ignores stale stream revisions and lower market versions", () => {
    (globalThis as { EventSource?: typeof EventSource }).EventSource =
      FakeEventSource as unknown as typeof EventSource;
    render(<PredictionsClient initial={snapshot} />);
    const source = FakeEventSource.instances[0];

    act(() => {
      source?.emit(
        "market.updated",
        {
          market: {
            ...snapshot.markets[0],
            version: 3,
            outcomes: [
              { id: "yes", label: "Wins", probability: 0.8 },
              { id: "no", label: "Loses", probability: 0.2 },
            ],
          },
        },
        "test:3",
      );
      source?.emit(
        "market.updated",
        {
          market: {
            ...snapshot.markets[0],
            version: 4,
            outcomes: [
              { id: "yes", label: "Wins", probability: 0.1 },
              { id: "no", label: "Loses", probability: 0.9 },
            ],
          },
        },
        "test:2",
      );
      source?.emit(
        "market.updated",
        {
          market: {
            ...snapshot.markets[0],
            version: 2,
            outcomes: [
              { id: "yes", label: "Wins", probability: 0.2 },
              { id: "no", label: "Loses", probability: 0.8 },
            ],
          },
        },
        "test:4",
      );
    });

    expect(screen.getByText("80%")).toBeTruthy();
  });

  test("clears private balances when the active event changes", () => {
    sessionData = { user: { id: "viewer", name: "Hydra" } };
    (globalThis as { EventSource?: typeof EventSource }).EventSource =
      FakeEventSource as unknown as typeof EventSource;
    const privateSnapshot: PredictionSnapshot = {
      ...snapshot,
      portfolio: { availableCrowns: "100", equity: "105" },
      markets: snapshot.markets.map((market) => ({
        ...market,
        outcomes: market.outcomes.map((outcome) => ({
          ...outcome,
          viewerShares: outcome.id === "yes" ? "5" : "0",
        })),
      })),
    };
    render(<PredictionsClient initial={privateSnapshot} />);
    const source = FakeEventSource.instances[0];

    expect(screen.getByText("100 Crowns")).toBeTruthy();
    expect(screen.getByText("5.00 shares")).toBeTruthy();
    act(() => {
      source?.emit(
        "public.snapshot",
        { enabled: true, event: null, markets: [], leaderboard: [], seasonLeaderboard: [] },
        "test:2",
      );
    });

    expect(screen.queryByText("100 Crowns")).toBeNull();
    expect(screen.queryByText("5.00 shares")).toBeNull();
  });

  test("applies a targeted account update without fetching the account endpoint", () => {
    sessionData = { user: { id: "viewer", name: "Hydra" } };
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("unexpected fetch")),
    ) as unknown as typeof fetch;
    (globalThis as { EventSource?: typeof EventSource }).EventSource =
      FakeEventSource as unknown as typeof EventSource;
    render(
      <PredictionsClient
        initial={{
          ...snapshot,
          markets: snapshot.markets.map((market) => ({
            ...market,
            outcomes: market.outcomes.map((outcome) => ({
              ...outcome,
              viewerShares: outcome.id === "yes" ? "1" : "0",
            })),
          })),
        }}
      />,
    );
    const source = FakeEventSource.instances[0];

    act(() => {
      source?.emit(
        "account.updated",
        {
          eventId: "event",
          portfolio: { availableCrowns: "250", equity: "260" },
          sharesByOutcome: { yes: "7" },
        },
        "test:2",
      );
    });

    expect(screen.getByText("250 Crowns")).toBeTruthy();
    expect(screen.getByText("7.00 shares")).toBeTruthy();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test("clears an old event account locally without fetching the account endpoint", () => {
    sessionData = { user: { id: "viewer", name: "Hydra" } };
    globalThis.fetch = mock(() =>
      Promise.reject(new Error("unexpected fetch")),
    ) as unknown as typeof fetch;
    (globalThis as { EventSource?: typeof EventSource }).EventSource =
      FakeEventSource as unknown as typeof EventSource;
    render(
      <PredictionsClient
        initial={{
          ...snapshot,
          portfolio: { availableCrowns: "100", equity: "105" },
          markets: snapshot.markets.map((market) => ({
            ...market,
            outcomes: market.outcomes.map((outcome) => ({
              ...outcome,
              viewerShares: outcome.id === "yes" ? "5" : "0",
            })),
          })),
        }}
      />,
    );
    const source = FakeEventSource.instances[0];

    act(() => {
      source?.emit(
        "accounts.invalidated",
        { eventId: "new-event", reason: "event_changed" },
        "test:2",
      );
    });

    expect(screen.queryByText("100 Crowns")).toBeNull();
    expect(screen.queryByText("5.00 shares")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
