import { describe, expect, test } from "bun:test";
import { rankLeaderboard } from "./leaderboard";

describe("rankLeaderboard", () => {
  test("sorts scores and shares ranks for ties", () => {
    expect(
      rankLeaderboard([
        { name: "A", wins: 2 },
        { name: "B", wins: 5 },
        { name: "C", wins: 5 },
      ]),
    ).toEqual([
      { name: "B", wins: 5, rank: 1 },
      { name: "C", wins: 5, rank: 1 },
      { name: "A", wins: 2, rank: 3 },
    ]);
  });

  test("returns an empty leaderboard", () => {
    expect(rankLeaderboard([])).toEqual([]);
  });

  test("rejects invalid scores", () => {
    expect(() => rankLeaderboard([{ name: "A", wins: -1 }])).toThrow("non-negative integer");
  });
});
