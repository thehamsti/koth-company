import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import postgres from "postgres";

const connectionString = process.env.PREDICTION_DATABASE_URI;
if (!connectionString) throw new Error("PREDICTION_DATABASE_URI is required for migrations.");

const client = postgres(connectionString, { max: 1, prepare: false });
try {
  await migrate(drizzle(client), {
    migrationsFolder: path.resolve(import.meta.dir, "../packages/predictions/db/migrations"),
  });
} finally {
  await client.end();
}
