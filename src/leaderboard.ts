export type LeaderboardEntry = {
  name: string;
  wins: number;
};

export type RankedLeaderboardEntry = LeaderboardEntry & {
  rank: number;
};

export const leaderboardUpdatedAt = "2026-07-10T00:00:00-06:00";

// Add contestants here as the tournament progresses.
export const leaderboardEntries = [] as const satisfies readonly LeaderboardEntry[];

export function rankLeaderboard(entries: readonly LeaderboardEntry[]): RankedLeaderboardEntry[] {
  for (const entry of entries) {
    if (entry.name.trim().length === 0 || !Number.isInteger(entry.wins) || entry.wins < 0) {
      throw new Error(
        "Leaderboard entries require a player name and a non-negative integer win count.",
      );
    }
  }

  const sorted = entries
    .map((entry, sourceIndex) => ({ ...entry, sourceIndex }))
    .sort((a, b) => b.wins - a.wins || a.sourceIndex - b.sourceIndex);

  return sorted.map(({ sourceIndex: _, ...entry }) => ({
    ...entry,
    rank: sorted.findIndex((candidate) => candidate.wins === entry.wins) + 1,
  }));
}
