import { App } from "../../src/App";
import { getTournamentData } from "../../src/cms";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const data = await getTournamentData();

  return <App content={data.content} leaderboardEntries={data.leaderboardEntries} />;
}
