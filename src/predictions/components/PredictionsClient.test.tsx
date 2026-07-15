import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PredictionSnapshot } from "../types";

let sessionData: { user: { name: string; image?: string | null } } | null = null;

mock.module("../auth-client", () => ({
  authClient: {
    useSession: () => ({ data: sessionData }),
    signIn: { social: () => Promise.resolve() },
    signOut: () => Promise.resolve(),
  },
}));

const { PredictionsClient } = await import("./PredictionsClient");

afterEach(() => {
  sessionData = null;
  cleanup();
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

    fireEvent.click(screen.getByRole("button", { name: /Wins 63%/ }));

    expect(
      screen.getByRole("heading", { name: "Hydra wins the next arena", level: 2 }),
    ).toBeTruthy();
    expect(screen.getByText("Sign in with Twitch to take a position.")).toBeTruthy();
  });

  test("identifies the signed-in Twitch viewer", () => {
    sessionData = { user: { name: "Hydra" } };

    render(<PredictionsClient initial={snapshot} />);

    expect(screen.getByText("Signed in as")).toBeTruthy();
    expect(screen.getByText("Hydra")).toBeTruthy();
    expect(screen.getByText("H").getAttribute("aria-hidden")).toBe("true");
  });
});
