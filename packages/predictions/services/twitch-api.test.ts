import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  createTwitchCustomReward,
  deleteEventSubSubscription,
  exchangeTwitchAuthorizationCode,
  refreshTwitchBroadcasterToken,
  validateTwitchAccessToken,
} from "./twitch-api";

const originalFetch = globalThis.fetch;
const originalClientId = process.env.TWITCH_CLIENT_ID;
const originalClientSecret = process.env.TWITCH_CLIENT_SECRET;
const originalHttpTimeout = process.env.TWITCH_HTTP_TIMEOUT_MS;

function installAbortingFetch(): void {
  globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    if (!signal) return Promise.reject(new Error("Expected a timeout signal."));

    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalClientId === undefined) delete process.env.TWITCH_CLIENT_ID;
  else process.env.TWITCH_CLIENT_ID = originalClientId;
  if (originalClientSecret === undefined) delete process.env.TWITCH_CLIENT_SECRET;
  else process.env.TWITCH_CLIENT_SECRET = originalClientSecret;
  if (originalHttpTimeout === undefined) delete process.env.TWITCH_HTTP_TIMEOUT_MS;
  else process.env.TWITCH_HTTP_TIMEOUT_MS = originalHttpTimeout;
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

  test("exchanges broadcaster authorization codes with a deadline", async () => {
    process.env.TWITCH_CLIENT_ID = "client-id";
    process.env.TWITCH_CLIENT_SECRET = "client-secret";
    globalThis.fetch = mock((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Promise.resolve(
        Response.json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          scope: ["channel:manage:redemptions"],
        }),
      );
    }) as unknown as typeof fetch;

    await expect(
      exchangeTwitchAuthorizationCode("code", "https://koth.company/callback"),
    ).resolves.toMatchObject({
      accessToken: "access",
      refreshToken: "refresh",
      scope: "channel:manage:redemptions",
    });
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

  test("aborts access token validation with an actionable timeout", async () => {
    process.env.TWITCH_HTTP_TIMEOUT_MS = "5";
    installAbortingFetch();

    await expect(validateTwitchAccessToken("access")).rejects.toThrow(
      "Twitch access token validation timed out after 5ms. Confirm Twitch is reachable, then retry.",
    );
  });

  test("aborts broadcaster token refresh with an actionable timeout", async () => {
    process.env.TWITCH_CLIENT_ID = "client-id";
    process.env.TWITCH_CLIENT_SECRET = "client-secret";
    process.env.TWITCH_HTTP_TIMEOUT_MS = "5";
    installAbortingFetch();

    await expect(refreshTwitchBroadcasterToken("refresh-1")).rejects.toThrow(
      "Twitch broadcaster token refresh timed out after 5ms. Confirm Twitch is reachable, then retry.",
    );
  });

  test("aborts Helix reward requests with request context", async () => {
    process.env.TWITCH_CLIENT_ID = "client-id";
    process.env.TWITCH_CLIENT_SECRET = "client-secret";
    process.env.TWITCH_HTTP_TIMEOUT_MS = "5";
    installAbortingFetch();

    await expect(
      createTwitchCustomReward("broadcaster-1", "access", {
        title: "1 Crown",
        cost: 1_000,
        crowns: "1",
      }),
    ).rejects.toThrow(
      "Twitch API request (POST /channel_points/custom_rewards) timed out after 5ms. Confirm Twitch is reachable, then retry.",
    );
  });

  test("rejects an unbounded Twitch timeout configuration before fetching", async () => {
    process.env.TWITCH_HTTP_TIMEOUT_MS = "30001";
    globalThis.fetch = mock(() => Promise.resolve(Response.json({}))) as unknown as typeof fetch;

    await expect(validateTwitchAccessToken("access")).rejects.toThrow(
      "TWITCH_HTTP_TIMEOUT_MS must be an integer between 1 and 30000.",
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
