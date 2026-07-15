import { describe, expect, mock, test } from "bun:test";

const processChannelPointRedemption = mock(
  (
    event: unknown,
  ): Promise<{
    id: string;
    status: "fulfilled" | "failed";
    crowns: string;
    error?: string;
  }> => Promise.resolve({ id: (event as { id: string }).id, status: "fulfilled", crowns: "1" }),
);

mock.module("@/src/predictions/services/channel-points", () => ({
  processChannelPointRedemption,
}));

const { POST } = await import("@/app/api/twitch/eventsub/route");

async function sign(secret: string, messageId: string, timestamp: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `sha256=${Buffer.from(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${messageId}${timestamp}${body}`),
    ),
  ).toString("hex")}`;
}

describe("Twitch EventSub webhook route", () => {
  test("returns challenge for verification", async () => {
    const secret = "super-secret-64-char-ascii-string-for-hmac-sha256!!";
    process.env.TWITCH_EVENTSUB_SECRET = secret;
    const messageId = "msg-verify";
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({ challenge: "pogchamp-kappa-360noscope-vohiyo" });
    const request = new Request("http://localhost/api/twitch/eventsub", {
      method: "POST",
      headers: {
        "twitch-eventsub-message-id": messageId,
        "twitch-eventsub-message-timestamp": timestamp,
        "twitch-eventsub-message-signature": await sign(secret, messageId, timestamp, body),
        "twitch-eventsub-message-type": "webhook_callback_verification",
      },
      body,
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pogchamp-kappa-360noscope-vohiyo");
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  test("rejects invalid signature", async () => {
    process.env.TWITCH_EVENTSUB_SECRET = "secret";
    const request = new Request("http://localhost/api/twitch/eventsub", {
      method: "POST",
      headers: {
        "twitch-eventsub-message-id": "id",
        "twitch-eventsub-message-timestamp": new Date().toISOString(),
        "twitch-eventsub-message-signature": "sha256=invalid",
        "twitch-eventsub-message-type": "notification",
      },
      body: "{}",
    });
    const response = await POST(request);
    expect(response.status).toBe(403);
  });

  test("processes notifications and returns 204", async () => {
    const secret = "super-secret-64-char-ascii-string-for-hmac-sha256!!";
    process.env.TWITCH_EVENTSUB_SECRET = secret;
    const messageId = "msg-1";
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({
      subscription: { type: "channel.channel_points_custom_reward_redemption.add" },
      event: { id: "redemption-1" },
    });
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = `sha256=${Buffer.from(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${messageId}${timestamp}${body}`),
      ),
    ).toString("hex")}`;
    const request = new Request("http://localhost/api/twitch/eventsub", {
      method: "POST",
      headers: {
        "twitch-eventsub-message-id": messageId,
        "twitch-eventsub-message-timestamp": timestamp,
        "twitch-eventsub-message-signature": signature,
        "twitch-eventsub-message-type": "notification",
      },
      body,
    });
    const response = await POST(request);
    expect(response.status).toBe(204);
    expect(processChannelPointRedemption).toHaveBeenCalled();
  });

  test("returns 500 so Twitch retries failed processing", async () => {
    processChannelPointRedemption.mockResolvedValueOnce({
      id: "redemption-2",
      status: "failed",
      crowns: "0",
      error: "Twitch unavailable.",
    });
    const secret = "super-secret-64-char-ascii-string-for-hmac-sha256!!";
    process.env.TWITCH_EVENTSUB_SECRET = secret;
    const messageId = "msg-2";
    const timestamp = new Date().toISOString();
    const body = JSON.stringify({
      subscription: { type: "channel.channel_points_custom_reward_redemption.add" },
      event: { id: "redemption-2" },
    });
    const request = new Request("http://localhost/api/twitch/eventsub", {
      method: "POST",
      headers: {
        "twitch-eventsub-message-id": messageId,
        "twitch-eventsub-message-timestamp": timestamp,
        "twitch-eventsub-message-signature": await sign(secret, messageId, timestamp, body),
        "twitch-eventsub-message-type": "notification",
      },
      body,
    });

    expect((await POST(request)).status).toBe(500);
  });
});
