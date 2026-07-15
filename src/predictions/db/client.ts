import postgres from "postgres";

type PredictionSqlClient = ReturnType<typeof postgres>;

const poolOptions = {
  prepare: false,
  max: 1,
  idle_timeout: 5,
  max_lifetime: 60,
} as const;

const globalForPredictionDb = globalThis as typeof globalThis & {
  predictionSqlClient?: PredictionSqlClient;
};

export function getPredictionSqlClient(connectionString: string): PredictionSqlClient {
  if (process.env.NODE_ENV === "production") {
    return postgres(connectionString, poolOptions);
  }

  globalForPredictionDb.predictionSqlClient ??= postgres(connectionString, poolOptions);
  return globalForPredictionDb.predictionSqlClient;
}
