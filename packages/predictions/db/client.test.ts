import { afterAll, describe, expect, test } from "bun:test";
import { getPredictionSqlClient } from "./client";

const connectionString = "postgres://test:test@127.0.0.1:1/test";
const mutableEnv = process.env as Record<string, string | undefined>;
const originalNodeEnv = process.env.NODE_ENV;
const clients: ReturnType<typeof getPredictionSqlClient>[] = [];

afterAll(async () => {
  if (originalNodeEnv === undefined) {
    delete mutableEnv.NODE_ENV;
  } else {
    mutableEnv.NODE_ENV = originalNodeEnv;
  }
  await Promise.all(clients.map((client) => client.end({ timeout: 0 })));
});

describe("prediction Postgres client", () => {
  test("reuses the long-lived bounded pool outside production", () => {
    mutableEnv.NODE_ENV = "development";
    const first = getPredictionSqlClient(connectionString);
    const second = getPredictionSqlClient(connectionString);
    clients.push(first);

    expect(second).toBe(first);
    expect(first.options).toMatchObject({
      prepare: false,
      max: 5,
      idle_timeout: 20,
      max_lifetime: 1800,
    });
  });

  test("reuses the same bounded pool in production", () => {
    mutableEnv.NODE_ENV = "production";
    const first = getPredictionSqlClient(connectionString);
    const second = getPredictionSqlClient(connectionString);
    expect(second).toBe(first);
    expect(first.options.max).toBe(5);
  });
});
