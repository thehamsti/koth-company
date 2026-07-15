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
  test("reuses a bounded pool outside production", () => {
    mutableEnv.NODE_ENV = "development";
    const first = getPredictionSqlClient(connectionString);
    const second = getPredictionSqlClient(connectionString);
    clients.push(first);

    expect(second).toBe(first);
    expect(first.options).toMatchObject({
      prepare: false,
      max: 1,
      idle_timeout: 5,
      max_lifetime: 60,
    });
  });

  test("keeps production clients scoped to their module instance", () => {
    mutableEnv.NODE_ENV = "production";
    const first = getPredictionSqlClient(connectionString);
    const second = getPredictionSqlClient(connectionString);
    clients.push(first, second);

    expect(second).not.toBe(first);
    expect(first.options.max).toBe(1);
  });
});
