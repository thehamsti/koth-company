import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";

mock.module("./auth", () => ({
  auth: { api: { getSession: () => Promise.resolve(null) } },
}));

const { apiError } = await import("./http");

describe("prediction API errors", () => {
  test("returns actionable field errors for malformed route payloads", async () => {
    const result = z
      .object({
        command: z.object({ eventId: z.uuid(), season: z.int().positive() }),
      })
      .safeParse({ command: { eventId: "not-an-id", season: 0 } });

    if (result.success) throw new Error("Expected validation to fail.");

    const response = apiError(result.error);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(body.error.message).toContain("command.eventId:");
    expect(body.error.message).toContain("command.season:");
  });

  test("preserves actionable service availability errors", async () => {
    const error = Object.assign(new Error("Realtime capacity reached."), {
      code: "REALTIME_CAPACITY_EXCEEDED",
      status: 503,
    });

    const response = apiError(error);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toEqual({
      error: {
        code: "REALTIME_CAPACITY_EXCEEDED",
        message: "Realtime capacity reached.",
      },
    });
  });
});
