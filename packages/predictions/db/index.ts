import { drizzle } from "drizzle-orm/postgres-js";
import { getPredictionSqlClient } from "./client";
import * as schema from "./schema";

const connectionString = process.env.PREDICTION_DATABASE_URI ?? process.env.DATABASE_URI;

if (!connectionString) {
  throw new Error("PREDICTION_DATABASE_URI or DATABASE_URI is required for prediction markets.");
}

const client = getPredictionSqlClient(connectionString);

export const predictionDb = drizzle(client, { schema });
