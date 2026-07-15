import type { MigrateDownArgs, MigrateUpArgs } from "@payloadcms/db-postgres";
import payload from "payload";
import { migrations } from "../src/migrations";
import configPromise from "./migrate.config";

// Payload's core type erases adapter arguments; generated Postgres migrations require them.
const payloadMigrations = migrations.map((migration) => ({
  ...migration,
  down: (args: unknown) => migration.down(args as MigrateDownArgs),
  up: (args: unknown) => migration.up(args as MigrateUpArgs),
}));

process.env.PAYLOAD_MIGRATING = "true";
console.info("Initializing Payload migration database...");
await payload.init({ config: await configPromise, disableOnInit: true });
try {
  const migrationTable = await payload.db.pool.query<{ migrationTable: string | null }>(
    `select to_regclass(current_schema() || '.payload_migrations')::text as "migrationTable"`,
  );
  if (migrationTable.rows[0]?.migrationTable) {
    const devMigration = await payload.db.pool.query(
      `select 1 from payload_migrations where batch = -1 limit 1`,
    );
    if (devMigration.rowCount) {
      throw new Error(
        "Payload development schema changes are present. Apply a generated migration and remove the reconciled batch -1 marker before deploying.",
      );
    }
  }

  console.info("Applying Payload migrations...");
  await payload.db.migrate({ migrations: payloadMigrations });
  payload.logger.info("Payload migrations complete.");
} catch (error) {
  console.error(error);
  process.exit(1);
}

// Payload retains its reconnect-monitor client, so pool shutdown cannot finish in a one-shot process.
process.exit(0);
