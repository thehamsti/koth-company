import { timingSafeEqual } from "node:crypto";

export type EventSubHeaders = {
  messageId: string;
  messageTimestamp: string;
  messageSignature: string;
  messageType: "notification" | "webhook_callback_verification" | "revocation";
};

export function parseEventSubHeaders(request: Request): EventSubHeaders | null {
  const messageId = request.headers.get("twitch-eventsub-message-id");
  const messageTimestamp = request.headers.get("twitch-eventsub-message-timestamp");
  const messageSignature = request.headers.get("twitch-eventsub-message-signature");
  const messageType = request.headers.get("twitch-eventsub-message-type");
  if (
    !messageId ||
    !messageTimestamp ||
    !messageSignature ||
    !messageType ||
    !["notification", "webhook_callback_verification", "revocation"].includes(messageType)
  ) {
    return null;
  }
  return {
    messageId,
    messageTimestamp,
    messageSignature,
    messageType: messageType as EventSubHeaders["messageType"],
  };
}

export function isEventSubMessageFresh(timestamp: string, now = Date.now()): boolean {
  const sentAt = Date.parse(timestamp);
  return Number.isFinite(sentAt) && Math.abs(now - sentAt) <= 10 * 60 * 1_000;
}

export async function verifyEventSubMessage(
  secret: string,
  headers: EventSubHeaders,
  rawBody: string,
): Promise<boolean> {
  const message = `${headers.messageId}${headers.messageTimestamp}${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const expected = `sha256=${Buffer.from(signature).toString("hex")}`;
  if (
    expected.length !== headers.messageSignature.length ||
    !/^[a-f\d]{64}$/i.test(headers.messageSignature.replace("sha256=", ""))
  ) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected), Buffer.from(headers.messageSignature));
}

export type ChannelPointRedemptionEvent = {
  id: string;
  broadcaster_user_id: string;
  broadcaster_user_login: string;
  broadcaster_user_name: string;
  user_id: string;
  user_login: string;
  user_name: string;
  user_input: string;
  status: "unknown" | "unfulfilled" | "fulfilled" | "canceled";
  reward: {
    id: string;
    title: string;
    cost: number;
    prompt: string;
  };
  redeemed_at: string;
};

export type EventSubNotification = {
  subscription: {
    id: string;
    type: string;
    version: string;
    status: string;
    condition: Record<string, string>;
  };
  event?: ChannelPointRedemptionEvent;
};
