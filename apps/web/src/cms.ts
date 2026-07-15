import type { LeaderboardEntry } from "./leaderboard";
import { defaultTournamentContent, type TournamentContent } from "./content";

type TournamentSettingsRecord = Partial<Omit<TournamentContent, "rules">> & {
  rules?: Array<{ text?: string | null }> | null;
};

type ParticipantReference = number | { displayName?: string | null } | null;

export function resolveParticipantName(participant: ParticipantReference): string | null {
  return typeof participant === "object" && participant?.displayName
    ? participant.displayName
    : null;
}

async function getPayloadClient() {
  const [{ getPayload }, { default: config }] = await Promise.all([
    import("payload"),
    import("../payload.config"),
  ]);

  return getPayload({ config });
}

export async function getTournamentData(): Promise<{
  content: TournamentContent;
  leaderboardEntries: LeaderboardEntry[];
}> {
  try {
    const payload = await getPayloadClient();
    const [settingsResult, leaderboardResult] = await Promise.all([
      payload.findGlobal({ slug: "tournament-settings", overrideAccess: true }),
      payload.find({
        collection: "leaderboard-entries",
        overrideAccess: true,
        depth: 1,
        limit: 100,
        sort: ["-wins", "createdAt"],
        where: { visible: { equals: true } },
      }),
    ]);
    const settings = settingsResult as TournamentSettingsRecord;
    const rules = settings.rules?.flatMap((rule) => (rule.text ? [rule.text] : []));
    const content: TournamentContent = {
      ...defaultTournamentContent,
      ...settings,
      rules: rules?.length ? rules : [...defaultTournamentContent.rules],
    };
    const leaderboardEntries = leaderboardResult.docs.flatMap((entry) => {
      const name = resolveParticipantName(entry.participant);
      return name && Number.isInteger(entry.wins) ? [{ name, wins: entry.wins }] : [];
    });

    return { content, leaderboardEntries };
  } catch (error) {
    console.error("Payload content fetch failed; rendering tournament defaults.", error);
    return { content: defaultTournamentContent, leaderboardEntries: [] };
  }
}
