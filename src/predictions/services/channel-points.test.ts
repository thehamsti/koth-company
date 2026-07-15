import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { channelPointRedemptions } from "../db/schema";
import type { ChannelPointRedemptionEvent } from "./twitch-webhook";

const twitchApi = await import("./twitch-api");

const updateTwitchRedemptionStatus = mock(() => Promise.resolve());
const getTwitchRedemptionStatus = mock(
  (): Promise<"UNFULFILLED" | "FULFILLED" | "CANCELED" | null> => Promise.resolve("FULFILLED"),
);
const databaseUpdates: Array<Record<string, unknown>> = [];

mock.module("../db", () => ({
  predictionDb: {
    select: () => ({
      from: (table: object) => ({
        where: () => ({
          limit: () => {
            if (table !== channelPointRedemptions) throw new Error("Unexpected table in test.");
            return Promise.resolve([
              { id: "local-redemption-1", status: "pending", crowns: "1.00000000" },
            ]);
          },
        }),
      }),
    }),
    update: (table: object) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          if (table !== channelPointRedemptions) throw new Error("Unexpected update in test.");
          databaseUpdates.push(values);
          return Promise.resolve();
        },
      }),
    }),
  },
}));

mock.module("./twitch-auth", () => ({
  getBroadcasterCredential: () =>
    Promise.resolve({
      id: "credential-1",
      broadcasterId: "broadcaster-1",
      login: "hydramist",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 60_000),
      scope: "channel:manage:redemptions",
    }),
  getBroadcasterAccessToken: () => Promise.resolve("access"),
  getBroadcasterId: () => Promise.resolve("broadcaster-1"),
}));

mock.module("./twitch-api", () => ({
  ...twitchApi,
  updateTwitchRedemptionStatus,
  getTwitchRedemptionStatus,
}));

const { processChannelPointRedemption } = await import("./channel-points");

const event = {
  id: "twitch-redemption-1",
  broadcaster_user_id: "broadcaster-1",
  broadcaster_user_login: "hydramist",
  broadcaster_user_name: "Hydramist",
  user_id: "viewer-1",
  user_login: "viewer",
  user_name: "Viewer",
  user_input: "",
  status: "unfulfilled",
  reward: { id: "reward-1", title: "1 Crown", cost: 1000, prompt: "" },
  redeemed_at: new Date().toISOString(),
} satisfies ChannelPointRedemptionEvent;

beforeEach(() => {
  databaseUpdates.length = 0;
  updateTwitchRedemptionStatus.mockImplementation(() => Promise.resolve());
  getTwitchRedemptionStatus.mockImplementation(() => Promise.resolve("FULFILLED"));
});

afterAll(() => mock.restore());

describe("channel point redemption retries", () => {
  test("settles an already-credited pending redemption without crediting it twice", async () => {
    const result = await processChannelPointRedemption(event);

    expect(result).toEqual({
      id: "twitch-redemption-1",
      status: "fulfilled",
      crowns: "1.00000000",
    });
    expect(updateTwitchRedemptionStatus).toHaveBeenCalledTimes(1);
    expect(databaseUpdates).toHaveLength(1);
    expect(databaseUpdates[0]?.status).toBe("fulfilled");
  });

  test("reconciles a successful Twitch update after an uncertain response", async () => {
    updateTwitchRedemptionStatus.mockImplementation(() =>
      Promise.reject(new Error("Connection reset")),
    );

    const result = await processChannelPointRedemption(event);

    expect(result.status).toBe("fulfilled");
    expect(getTwitchRedemptionStatus).toHaveBeenCalledTimes(1);
    expect(databaseUpdates[0]?.status).toBe("fulfilled");
  });

  test("reports a retryable failure while Twitch remains unfulfilled", async () => {
    updateTwitchRedemptionStatus.mockImplementation(() => Promise.reject(new Error("Unavailable")));
    getTwitchRedemptionStatus.mockImplementation(() => Promise.resolve("UNFULFILLED"));

    const result = await processChannelPointRedemption(event);

    expect(result).toEqual({
      id: "twitch-redemption-1",
      status: "failed",
      crowns: "0",
      error: "Unavailable",
    });
    expect(databaseUpdates).toHaveLength(0);
  });
});
