import { describe, expect, test } from "bun:test";
import { GET } from "./route";

describe("GET /api/health", () => {
  test("reports that the Next.js server is healthy", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
