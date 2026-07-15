import { describe, expect, test } from "bun:test";
import {
  isEventSubMessageFresh,
  parseEventSubHeaders,
  verifyEventSubMessage,
} from "./twitch-webhook";

function makeRequest(headers: Record<string, string>, body: string): Request {
  return new Request("http://localhost/api/twitch/eventsub", {
    method: "POST",
    headers,
    body,
  });
}

async function sign(secret: string, messageId: string, timestamp: string, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const value = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${messageId}${timestamp}${body}`),
  );
  return `sha256=${Buffer.from(value).toString("hex")}`;
}

describe("EventSub webhook verification", () => {
  test("parses EventSub headers", () => {
    const request = makeRequest(
      {
        "twitch-eventsub-message-id": "test-id",
        "twitch-eventsub-message-timestamp": "2024-01-01T00:00:00Z",
        "twitch-eventsub-message-signature": "sha256=abc",
        "twitch-eventsub-message-type": "notification",
      },
      "{}",
    );
    const parsed = parseEventSubHeaders(request);
    expect(parsed).toEqual({
      messageId: "test-id",
      messageTimestamp: "2024-01-01T00:00:00Z",
      messageSignature: "sha256=abc",
      messageType: "notification",
    });
  });

  test("returns null for missing headers", () => {
    const request = makeRequest({}, "{}");
    expect(parseEventSubHeaders(request)).toBeNull();
  });

  test("returns null for an unknown message type", () => {
    const request = makeRequest(
      {
        "twitch-eventsub-message-id": "test-id",
        "twitch-eventsub-message-timestamp": "2024-01-01T00:00:00Z",
        "twitch-eventsub-message-signature": "sha256=abc",
        "twitch-eventsub-message-type": "unexpected",
      },
      "{}",
    );
    expect(parseEventSubHeaders(request)).toBeNull();
  });

  test("rejects messages outside the ten-minute replay window", () => {
    const now = Date.parse("2024-01-01T00:10:01Z");
    expect(isEventSubMessageFresh("2024-01-01T00:00:00Z", now)).toBe(false);
    expect(isEventSubMessageFresh("2024-01-01T00:00:01Z", now)).toBe(true);
    expect(isEventSubMessageFresh("not-a-date", now)).toBe(false);
  });

  test("verifies a valid signature", async () => {
    const secret = "super-secret-64-char-ascii-string-for-hmac-sha256!!";
    const messageId = "msg-1";
    const timestamp = "2024-01-01T00:00:00Z";
    const body = JSON.stringify({ subscription: { id: "sub-1" }, event: { id: "evt-1" } });
    const signature = await sign(secret, messageId, timestamp, body);
    const valid = await verifyEventSubMessage(
      secret,
      {
        messageId,
        messageTimestamp: timestamp,
        messageSignature: signature,
        messageType: "notification",
      },
      body,
    );
    expect(valid).toBe(true);
  });

  test("rejects an invalid signature", async () => {
    const secret = "super-secret-64-char-ascii-string-for-hmac-sha256!!";
    const body = "{}";
    const valid = await verifyEventSubMessage(
      secret,
      {
        messageId: "msg-1",
        messageTimestamp: "2024-01-01T00:00:00Z",
        messageSignature: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        messageType: "notification",
      },
      body,
    );
    expect(valid).toBe(false);
  });
});
