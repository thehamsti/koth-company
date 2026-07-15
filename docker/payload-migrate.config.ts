import { postgresAdapter } from "@payloadcms/db-postgres";
import path from "node:path";
import { buildConfig } from "payload";

export default buildConfig({
  collections: [],
  secret: process.env.PAYLOAD_SECRET ?? "",
  db: postgresAdapter({
    migrationDir: path.resolve(import.meta.dir, "../apps/web/src/migrations"),
    pool: {
      connectionString: process.env.DATABASE_URI ?? "",
      max: 1,
      idleTimeoutMillis: 5_000,
      maxLifetimeSeconds: 60,
    },
  }),
});
