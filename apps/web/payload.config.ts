import { postgresAdapter } from "@payloadcms/db-postgres";
import { lexicalEditor } from "@payloadcms/richtext-lexical";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig } from "payload";
import sharp from "sharp";
import { LeaderboardEntries } from "./src/collections/LeaderboardEntries";
import { Participants } from "./src/collections/Participants";
import { Users } from "./src/collections/Users";
import { TournamentSettings } from "./src/globals/TournamentSettings";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: { baseDir: dirname },
    meta: { titleSuffix: "· KOTH Control Room" },
    components: {
      beforeDashboard: ["/src/components/admin/KothDashboard"],
      beforeLogin: ["/src/components/admin/AdminWelcome"],
      graphics: {
        Icon: "/src/components/admin/BrandIcon",
        Logo: "/src/components/admin/BrandLogo",
      },
    },
  },
  collections: [Users, Participants, LeaderboardEntries],
  globals: [TournamentSettings],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET ?? "",
  typescript: {
    outputFile: path.resolve(dirname, "src/payload-types.ts"),
  },
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URI ?? "",
      // Payload reserves one client to monitor reconnects, so a size of one deadlocks every query.
      max: 5,
      idleTimeoutMillis: 5_000,
      maxLifetimeSeconds: 60,
    },
  }),
  sharp,
});
