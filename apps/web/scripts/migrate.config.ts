import { postgresAdapter } from "@payloadcms/db-postgres";
import path from "node:path";
import { buildConfig } from "payload";

export default buildConfig({
  collections: [],
  telemetry: false,
  secret: process.env.PAYLOAD_SECRET ?? "",
  typescript: { autoGenerate: false },
  db: postgresAdapter({
    migrationDir: path.resolve(import.meta.dir, "../src/migrations"),
    pool: {
      connectionString: process.env.DATABASE_URI ?? "",
      // Payload keeps one client checked out while the migrator uses the other.
      max: 2,
      idleTimeoutMillis: 5_000,
      maxLifetimeSeconds: 60,
    },
  }),
});
