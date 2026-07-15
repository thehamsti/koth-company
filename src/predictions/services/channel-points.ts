import Decimal from "decimal.js";
import { and, eq, inArray, sql, sum } from "drizzle-orm";
import { predictionDb } from "../db";
import {
  account,
  channelPointRedemptions,
  events,
  ledgerEntries,
  portfolios,
  twitchRewards,
  user,
} from "../db/schema";
import { PredictionError } from "../types";
import {
  getChannelPointRewardDenominations,
  getChannelPointsEventCap,
} from "./channel-point-config";
import {
  getBroadcasterAccessToken,
  getBroadcasterCredential,
  getBroadcasterId,
} from "./twitch-auth";
import {
  createTwitchCustomReward,
  getTwitchCustomRewards,
  getTwitchRedemptionStatus,
  updateTwitchCustomReward,
  updateTwitchRedemptionStatus,
} from "./twitch-api";
import type { ChannelPointRedemptionEvent } from "./twitch-webhook";

export type RedemptionResult = {
  id: string;
  status: "fulfilled" | "skipped" | "failed";
  crowns: string;
  error?: string;
};

async function getActiveEvent(): Promise<{
  id: string;
  status: string;
  startingCrowns: string;
} | null> {
  const [event] = await predictionDb
    .select()
    .from(events)
    .where(inArray(events.status, ["live"]))
    .orderBy(sql`${events.createdAt} desc`)
    .limit(1);
  if (!event) return null;
  return { id: event.id, status: event.status, startingCrowns: event.startingCrowns };
}

async function getOrCreatePortfolio(
  eventId: string,
  userId: string,
): Promise<{ id: string; availableCrowns: string }> {
  const [event] = await predictionDb.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) throw new Error("Event not found.");
  await predictionDb
    .insert(portfolios)
    .values({ eventId, userId, availableCrowns: event.startingCrowns })
    .onConflictDoNothing({ target: [portfolios.eventId, portfolios.userId] });
  const [portfolio] = await predictionDb
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.eventId, eventId), eq(portfolios.userId, userId)))
    .limit(1);
  if (!portfolio) throw new Error("Portfolio creation failed.");
  return { id: portfolio.id, availableCrowns: portfolio.availableCrowns };
}

async function findUserByTwitchId(
  twitchUserId: string,
): Promise<{ id: string; name: string } | null> {
  const [row] = await predictionDb
    .select({ userId: user.id, name: user.name })
    .from(account)
    .innerJoin(user, eq(user.id, account.userId))
    .where(and(eq(account.providerId, "twitch"), eq(account.accountId, twitchUserId)))
    .limit(1);
  return row ? { id: row.userId, name: row.name } : null;
}

async function findRewardByTwitchId(
  twitchRewardId: string,
): Promise<{ id: string; crowns: string; cost: number } | null> {
  const [row] = await predictionDb
    .select({ id: twitchRewards.id, crowns: twitchRewards.crowns, cost: twitchRewards.cost })
    .from(twitchRewards)
    .where(eq(twitchRewards.twitchRewardId, twitchRewardId))
    .limit(1);
  return row ?? null;
}

async function cancelRedemption(
  event: ChannelPointRedemptionEvent,
  reason: string,
): Promise<RedemptionResult> {
  const token = await getBroadcasterAccessToken();
  await updateTwitchRedemptionStatus(
    event.broadcaster_user_id,
    event.reward.id,
    event.id,
    token,
    "CANCELED",
  );
  return { id: event.id, status: "skipped", crowns: "0", error: reason };
}

async function settleRedemption(
  event: ChannelPointRedemptionEvent,
  redemptionId: string,
): Promise<void> {
  const token = await getBroadcasterAccessToken();
  try {
    await updateTwitchRedemptionStatus(
      event.broadcaster_user_id,
      event.reward.id,
      event.id,
      token,
      "FULFILLED",
    );
  } catch (error) {
    const status = await getTwitchRedemptionStatus(
      event.broadcaster_user_id,
      event.reward.id,
      event.id,
      token,
    );
    if (status !== "FULFILLED") throw error;
  }
  await predictionDb
    .update(channelPointRedemptions)
    .set({ status: "fulfilled", updatedAt: new Date() })
    .where(eq(channelPointRedemptions.id, redemptionId));
}

async function creditRedemption(
  event: ChannelPointRedemptionEvent,
  portfolioId: string,
  crowns: string,
  channelPoints: number,
  eventId: string,
  twitchUserId: string,
): Promise<
  | { kind: "credited"; redemptionId: string }
  | { kind: "duplicate"; redemptionId: string; status: string; crowns: string }
  | { kind: "cap_exceeded" }
> {
  return predictionDb.transaction(async (tx) => {
    await tx
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(eq(portfolios.id, portfolioId))
      .for("update")
      .limit(1);
    const [duplicate] = await tx
      .select({
        id: channelPointRedemptions.id,
        status: channelPointRedemptions.status,
        crowns: channelPointRedemptions.crowns,
      })
      .from(channelPointRedemptions)
      .where(eq(channelPointRedemptions.twitchRedemptionId, event.id))
      .limit(1);
    if (duplicate) {
      return {
        kind: "duplicate" as const,
        redemptionId: duplicate.id,
        status: duplicate.status,
        crowns: duplicate.crowns,
      };
    }
    const [converted] = await tx
      .select({ total: sum(channelPointRedemptions.channelPoints) })
      .from(channelPointRedemptions)
      .where(
        and(
          eq(channelPointRedemptions.eventId, eventId),
          eq(channelPointRedemptions.portfolioId, portfolioId),
        ),
      )
      .groupBy(channelPointRedemptions.portfolioId);
    if (Number(converted?.total ?? 0) + channelPoints > getChannelPointsEventCap()) {
      return { kind: "cap_exceeded" as const };
    }
    const [redemption] = await tx
      .insert(channelPointRedemptions)
      .values({
        twitchRedemptionId: event.id,
        twitchRewardId: event.reward.id,
        twitchUserId,
        eventId,
        portfolioId,
        channelPoints,
        crowns,
        status: "pending",
      })
      .returning({ id: channelPointRedemptions.id });
    if (!redemption) throw new Error("Failed to record channel point redemption.");
    await tx
      .update(portfolios)
      .set({
        availableCrowns: sql`${portfolios.availableCrowns} + ${crowns}::numeric`,
        updatedAt: new Date(),
      })
      .where(eq(portfolios.id, portfolioId));
    await tx.insert(ledgerEntries).values({
      portfolioId,
      kind: "channel_points",
      amount: crowns,
      metadata: {
        twitchRedemptionId: event.id,
        twitchRewardId: event.reward.id,
        twitchUserId,
        channelPoints,
      },
    });
    return { kind: "credited" as const, redemptionId: redemption.id };
  });
}

export async function processChannelPointRedemption(
  event: ChannelPointRedemptionEvent,
): Promise<RedemptionResult> {
  const credential = await getBroadcasterCredential();
  if (!credential || event.broadcaster_user_id !== credential.broadcasterId) {
    return { id: event.id, status: "skipped", crowns: "0", error: "Unknown broadcaster." };
  }
  if (event.status === "canceled") {
    return { id: event.id, status: "skipped", crowns: "0", error: "Redemption already canceled." };
  }
  const [existing] = await predictionDb
    .select({
      id: channelPointRedemptions.id,
      status: channelPointRedemptions.status,
      crowns: channelPointRedemptions.crowns,
    })
    .from(channelPointRedemptions)
    .where(eq(channelPointRedemptions.twitchRedemptionId, event.id))
    .limit(1);
  if (existing?.status === "fulfilled") {
    return { id: event.id, status: "fulfilled", crowns: existing.crowns };
  }
  if (existing) {
    try {
      await settleRedemption(event, existing.id);
      return { id: event.id, status: "fulfilled", crowns: existing.crowns };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Settlement failed.";
      return { id: event.id, status: "failed", crowns: "0", error: message };
    }
  }
  const reward = await findRewardByTwitchId(event.reward.id);
  if (!reward) {
    return { id: event.id, status: "skipped", crowns: "0", error: "Unknown reward." };
  }
  if (event.reward.cost !== reward.cost) {
    return await cancelRedemption(
      event,
      "Reward cost is out of sync. Ask an operator to resync it.",
    );
  }
  const activeEvent = await getActiveEvent();
  if (!activeEvent) {
    return await cancelRedemption(event, "No active event.");
  }
  const appUser = await findUserByTwitchId(event.user_id);
  if (!appUser) {
    return await cancelRedemption(
      event,
      "Twitch account is not linked to a KOTH account. Sign in first.",
    );
  }
  const portfolio = await getOrCreatePortfolio(activeEvent.id, appUser.id);
  const crowns = new Decimal(reward.crowns).toDecimalPlaces(8).toFixed(8);
  try {
    const credited = await creditRedemption(
      event,
      portfolio.id,
      crowns,
      event.reward.cost,
      activeEvent.id,
      event.user_id,
    );
    if (credited.kind === "cap_exceeded") {
      return await cancelRedemption(
        event,
        `Conversion cap of ${getChannelPointsEventCap().toLocaleString("en-US")} Channel Points per event reached.`,
      );
    }
    if (credited.kind === "duplicate" && credited.status === "fulfilled") {
      return { id: event.id, status: "fulfilled", crowns: credited.crowns };
    }
    await settleRedemption(event, credited.redemptionId);
    return {
      id: event.id,
      status: "fulfilled",
      crowns: credited.kind === "duplicate" ? credited.crowns : crowns,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Fulfillment failed.";
    console.error("Channel point fulfillment failed.", { event, error });
    return { id: event.id, status: "failed", crowns: "0", error: message };
  }
}

export async function setRewardEnabled(enabled: boolean): Promise<void> {
  const credential = await getBroadcasterCredential();
  if (!credential) return;
  const rewards = await predictionDb
    .select()
    .from(twitchRewards)
    .where(eq(twitchRewards.broadcasterCredentialId, credential.id));
  if (rewards.length === 0) return;
  const broadcasterId = credential.broadcasterId;
  const token = await getBroadcasterAccessToken();
  for (const reward of rewards) {
    if (reward.isEnabled === enabled) continue;
    await updateTwitchCustomReward(broadcasterId, reward.twitchRewardId, token, {
      isEnabled: enabled,
    });
    await predictionDb
      .update(twitchRewards)
      .set({ isEnabled: enabled, updatedAt: new Date() })
      .where(eq(twitchRewards.id, reward.id));
  }
}

export async function setupTwitchRewards(): Promise<void> {
  const broadcasterId = await getBroadcasterId();
  const token = await getBroadcasterAccessToken();
  const credential = await getBroadcasterCredential();
  if (!credential) throw new PredictionError("TWITCH_NOT_CONNECTED", "Broadcaster not connected.");

  const denominations = getChannelPointRewardDenominations();
  const remoteRewards = await getTwitchCustomRewards(broadcasterId, token);
  const isEnabled = Boolean(await getActiveEvent());

  for (const denomination of denominations) {
    const [existing] = await predictionDb
      .select()
      .from(twitchRewards)
      .where(
        and(
          eq(twitchRewards.broadcasterCredentialId, credential.id),
          eq(twitchRewards.title, denomination.title),
        ),
      )
      .limit(1);
    if (existing) {
      const remote =
        remoteRewards.find((reward) => reward.id === existing.twitchRewardId) ??
        remoteRewards.find((reward) => reward.title === denomination.title);
      const reward = remote
        ? await updateTwitchCustomReward(broadcasterId, remote.id, token, {
            cost: denomination.cost,
            isEnabled,
          })
        : await createTwitchCustomReward(broadcasterId, token, {
            title: denomination.title,
            cost: denomination.cost,
            crowns: denomination.crowns,
            prompt: "Convert Twitch channel points into KOTH Crowns.",
            isEnabled,
            shouldRedemptionsSkipRequestQueue: false,
          });
      await predictionDb
        .update(twitchRewards)
        .set({
          twitchRewardId: reward.id,
          title: reward.title,
          cost: reward.cost,
          crowns: denomination.crowns,
          isEnabled: reward.isEnabled,
          updatedAt: new Date(),
        })
        .where(eq(twitchRewards.id, existing.id));
      continue;
    }
    const remote = remoteRewards.find((reward) => reward.title === denomination.title);
    const reward = remote
      ? await updateTwitchCustomReward(broadcasterId, remote.id, token, {
          cost: denomination.cost,
          isEnabled,
        })
      : await createTwitchCustomReward(broadcasterId, token, {
          title: denomination.title,
          cost: denomination.cost,
          crowns: denomination.crowns,
          prompt: "Convert Twitch channel points into KOTH Crowns.",
          isEnabled,
          shouldRedemptionsSkipRequestQueue: false,
        });
    await predictionDb
      .insert(twitchRewards)
      .values({
        broadcasterCredentialId: credential.id,
        twitchRewardId: reward.id,
        title: reward.title,
        cost: reward.cost,
        crowns: denomination.crowns,
        isEnabled: reward.isEnabled,
      })
      .onConflictDoUpdate({
        target: twitchRewards.twitchRewardId,
        set: {
          cost: reward.cost,
          crowns: denomination.crowns,
          isEnabled: reward.isEnabled,
          updatedAt: new Date(),
        },
      });
  }
}

export async function syncTwitchEventSub(): Promise<void> {
  const broadcasterId = await getBroadcasterId();
  const appToken = await (await import("./twitch-api")).getTwitchAppAccessToken();
  const { createEventSubSubscription, deleteEventSubSubscription, getEventSubSubscriptions } =
    await import("./twitch-api");
  const callback = process.env.TWITCH_EVENTSUB_CALLBACK_URL;
  const secret = process.env.TWITCH_EVENTSUB_SECRET;
  if (!callback || !secret) {
    throw new PredictionError(
      "INVALID_COMMAND",
      "TWITCH_EVENTSUB_CALLBACK_URL and TWITCH_EVENTSUB_SECRET must be set.",
    );
  }
  if (!URL.canParse(callback)) {
    throw new PredictionError("INVALID_COMMAND", "TWITCH_EVENTSUB_CALLBACK_URL must be a URL.");
  }
  const callbackUrl = new URL(callback);
  if (callbackUrl.protocol !== "https:" || (callbackUrl.port && callbackUrl.port !== "443")) {
    throw new PredictionError(
      "INVALID_COMMAND",
      "TWITCH_EVENTSUB_CALLBACK_URL must use HTTPS on port 443.",
    );
  }
  if (!/^[\x20-\x7E]{10,100}$/.test(secret)) {
    throw new PredictionError(
      "INVALID_COMMAND",
      "TWITCH_EVENTSUB_SECRET must be 10-100 printable ASCII characters.",
    );
  }
  const existing = await getEventSubSubscriptions(
    appToken,
    "channel.channel_points_custom_reward_redemption.add",
  );
  const matchingSubscriptions = existing.data.filter(
    (sub) =>
      sub.type === "channel.channel_points_custom_reward_redemption.add" &&
      sub.condition.broadcaster_user_id === broadcasterId &&
      sub.transport.method === "webhook",
  );
  for (const subscription of matchingSubscriptions) {
    await deleteEventSubSubscription(subscription.id, appToken);
  }
  await createEventSubSubscription(
    "channel.channel_points_custom_reward_redemption.add",
    "1",
    { broadcaster_user_id: broadcasterId },
    appToken,
    callback,
    secret,
  );
}

export async function teardownTwitchRewards(): Promise<void> {
  await setRewardEnabled(false);
}
