import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  createTwitchCustomReward,
  deleteEventSubSubscription,
  refreshTwitchBroadcasterToken,
  validateTwitchAccessToken,
} from "./twitch-api";

const originalFetch = globalThis.fetch;
const originalClientId = process.env.TWITCH_CLIENT_ID;
const originalClientSecret = process.env.TWITCH_CLIENT_SECRET;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalClientId === undefined) delete process.env.TWITCH_CLIENT_ID;
  else process.env.TWITCH_CLIENT_ID = originalClientId;
  if (originalClientSecret === undefined) delete process.env.TWITCH_CLIENT_SECRET;
  else process.env.TWITCH_CLIENT_SECRET = originalClientSecret;
});

describe("Twitch API client", () => {
  test("maps Twitch reward response fields", async () => {
    process.env.TWITCH_CLIENT_ID = "client-id";
    process.env.TWITCH_CLIENT_SECRET = "client-secret";
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({
          data: [
            {
              id: "reward-1",
              title: "1 Crown",
              cost: 1000,
              is_enabled: true,
              prompt: "Convert points",
              background_color: "#123456",
              is_user_input_required: false,
              max_per_user_per_stream_setting: {
                is_enabled: false,
                max_per_user_per_stream: 0,
              },
              should_redemptions_skip_request_queue: false,
            },
          ],
        }),
      ),
    ) as unknown as typeof fetch;

    const reward = await createTwitchCustomReward("broadcaster-1", "token", {
      title: "1 Crown",
      cost: 1000,
      crowns: "1",
    });

    expect(reward).toEqual({
      id: "reward-1",
      title: "1 Crown",
      cost: 1000,
      isEnabled: true,
      prompt: "Convert points",
      backgroundColor: "#123456",
      isUserInputRequired: false,
      maxPerUserPerStream: null,
      shouldRedemptionsSkipRequestQueue: false,
    });
  });

  test("normalizes refreshed OAuth scopes for storage", async () => {
    process.env.TWITCH_CLIENT_ID = "client-id";
    process.env.TWITCH_CLIENT_SECRET = "client-secret";
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({
          access_token: "access",
          refresh_token: "refresh-2",
          expires_in: 3600,
          scope: ["channel:manage:redemptions"],
        }),
      ),
    ) as unknown as typeof fetch;

    const tokens = await refreshTwitchBroadcasterToken("refresh-1");
    expect(tokens.scope).toBe("channel:manage:redemptions");
  });

  test("returns the account and scopes attached to a user token", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({
          client_id: "client-id",
          login: "hydramist",
          user_id: "1234",
          scopes: ["channel:manage:redemptions"],
          expires_in: 3600,
        }),
      ),
    ) as unknown as typeof fetch;

    await expect(validateTwitchAccessToken("access")).resolves.toEqual({
      clientId: "client-id",
      login: "hydramist",
      userId: "1234",
      scopes: ["channel:manage:redemptions"],
      expiresIn: 3600,
    });
  });

  test("accepts empty successful Twitch responses", async () => {
    process.env.TWITCH_CLIENT_ID = "client-id";
    process.env.TWITCH_CLIENT_SECRET = "client-secret";
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    ) as unknown as typeof fetch;

    await expect(deleteEventSubSubscription("subscription-1", "token")).resolves.toBeUndefined();
  });
});
