import postgres from "postgres";

type PredictionSqlClient = ReturnType<typeof postgres>;

function poolSize(): number {
  const configured = Number.parseInt(process.env.PREDICTION_DATABASE_POOL_SIZE ?? "5", 10);
  return Number.isInteger(configured) && configured > 0 ? configured : 5;
}

const globalForPredictionDb = globalThis as typeof globalThis & {
  predictionSqlClient?: PredictionSqlClient;
};

export function getPredictionSqlClient(connectionString: string): PredictionSqlClient {
  globalForPredictionDb.predictionSqlClient ??= postgres(connectionString, {
    prepare: false,
    max: poolSize(),
    idle_timeout: 20,
    max_lifetime: 60 * 30,
  });
  return globalForPredictionDb.predictionSqlClient;
}
