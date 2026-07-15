import {
  parseEventSubHeaders,
  isEventSubMessageFresh,
  verifyEventSubMessage,
  type ChannelPointRedemptionEvent,
  type EventSubNotification,
} from "@/src/predictions/services/twitch-webhook";
import { processChannelPointRedemption } from "@/src/predictions/services/channel-points";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const secret = process.env.TWITCH_EVENTSUB_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "EventSub secret not configured." }, { status: 500 });
  }
  const headers = parseEventSubHeaders(request);
  if (!headers) {
    return NextResponse.json({ error: "Missing EventSub headers." }, { status: 400 });
  }
  if (!isEventSubMessageFresh(headers.messageTimestamp)) {
    return NextResponse.json({ error: "Stale EventSub message." }, { status: 403 });
  }
  const rawBody = await request.text();
  if (!(await verifyEventSubMessage(secret, headers, rawBody))) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 403 });
  }
  if (headers.messageType === "webhook_callback_verification") {
    const payload = JSON.parse(rawBody) as { challenge?: unknown };
    if (typeof payload.challenge !== "string") {
      return NextResponse.json({ error: "Missing EventSub challenge." }, { status: 400 });
    }
    return new Response(payload.challenge, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }
  if (headers.messageType === "revocation") {
    console.warn("EventSub subscription revoked.", rawBody);
    return new Response(null, { status: 204 });
  }
  const notification = JSON.parse(rawBody) as EventSubNotification;
  if (notification.subscription.type === "channel.channel_points_custom_reward_redemption.add") {
    if (!notification.event) {
      return NextResponse.json({ error: "Missing redemption event." }, { status: 400 });
    }
    const result = await processChannelPointRedemption(
      notification.event as ChannelPointRedemptionEvent,
    );
    if (result.status === "failed") {
      console.error("Channel point redemption processing failed.", result);
      return NextResponse.json({ error: result.error ?? "Redemption failed." }, { status: 500 });
    }
  }
  return new Response(null, { status: 204 });
}
