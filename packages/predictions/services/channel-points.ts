import Decimal from "decimal.js";
import { and, eq, inArray, ne, sql, sum } from "drizzle-orm";
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
  userId?: string;
  accountChanged?: boolean;
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
  const [existing] = await predictionDb
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.eventId, eventId), eq(portfolios.userId, userId)))
    .limit(1);
  if (existing) return { id: existing.id, availableCrowns: existing.availableCrowns };
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
  if (event.status === "canceled") {
    return { id: event.id, status: "skipped", crowns: "0", error: reason };
  }
  const token = await getBroadcasterAccessToken();
  try {
    await updateTwitchRedemptionStatus(
      event.broadcaster_user_id,
      event.reward.id,
      event.id,
      token,
      "CANCELED",
    );
  } catch (error) {
    const status = await getTwitchRedemptionStatus(
      event.broadcaster_user_id,
      event.reward.id,
      event.id,
      token,
    );
    if (status !== "CANCELED") throw error;
  }
  return { id: event.id, status: "skipped", crowns: "0", error: reason };
}

async function confirmTwitchFulfillment(
  event: ChannelPointRedemptionEvent,
): Promise<"fulfilled" | "canceled"> {
  if (event.status === "fulfilled") return "fulfilled";
  if (event.status === "canceled") return "canceled";
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
    if (status === "FULFILLED") return "fulfilled";
    if (status === "CANCELED") return "canceled";
    throw error;
  }
  return "fulfilled";
}

type RedemptionRecord = {
  id: string;
  status: string;
  crowns: string;
};

async function markLegacyPendingFulfilled(redemptionId: string): Promise<void> {
  await predictionDb
    .update(channelPointRedemptions)
    .set({ status: "fulfilled", error: null, updatedAt: new Date() })
    .where(
      and(
        eq(channelPointRedemptions.id, redemptionId),
        eq(channelPointRedemptions.status, "pending"),
      ),
    );
}

async function markReservedCanceled(redemptionId: string): Promise<void> {
  await predictionDb
    .update(channelPointRedemptions)
    .set({ status: "canceled", error: null, updatedAt: new Date() })
    .where(
      and(
        eq(channelPointRedemptions.id, redemptionId),
        eq(channelPointRedemptions.status, "reserved"),
      ),
    );
}

async function reserveRedemption(
  event: ChannelPointRedemptionEvent,
  portfolioId: string,
  crowns: string,
  channelPoints: number,
  eventId: string,
  twitchUserId: string,
): Promise<
  | { kind: "reserved"; redemption: RedemptionRecord }
  | { kind: "duplicate"; redemption: RedemptionRecord }
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
        redemption: duplicate,
      };
    }
    const [converted] = await tx
      .select({ total: sum(channelPointRedemptions.channelPoints) })
      .from(channelPointRedemptions)
      .where(
        and(
          eq(channelPointRedemptions.eventId, eventId),
          eq(channelPointRedemptions.portfolioId, portfolioId),
          ne(channelPointRedemptions.status, "canceled"),
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
        status: "reserved",
      })
      .returning({ id: channelPointRedemptions.id });
    if (!redemption) throw new Error("Failed to record channel point redemption.");
    return {
      kind: "reserved" as const,
      redemption: { id: redemption.id, status: "reserved", crowns },
    };
  });
}

async function creditReservedRedemption(redemptionId: string): Promise<{
  crowns: string;
  userId: string;
  accountChanged: boolean;
}> {
  return predictionDb.transaction(async (tx) => {
    const [redemption] = await tx
      .select({
        id: channelPointRedemptions.id,
        status: channelPointRedemptions.status,
        crowns: channelPointRedemptions.crowns,
        portfolioId: channelPointRedemptions.portfolioId,
        twitchRedemptionId: channelPointRedemptions.twitchRedemptionId,
        twitchRewardId: channelPointRedemptions.twitchRewardId,
        twitchUserId: channelPointRedemptions.twitchUserId,
        channelPoints: channelPointRedemptions.channelPoints,
      })
      .from(channelPointRedemptions)
      .where(eq(channelPointRedemptions.id, redemptionId))
      .for("update")
      .limit(1);
    if (!redemption) throw new Error("Reserved channel point redemption no longer exists.");

    const [portfolio] = await tx
      .select({ userId: portfolios.userId })
      .from(portfolios)
      .where(eq(portfolios.id, redemption.portfolioId))
      .limit(1);
    if (!portfolio) throw new Error("Channel point redemption portfolio no longer exists.");
    if (redemption.status === "fulfilled") {
      return { crowns: redemption.crowns, userId: portfolio.userId, accountChanged: false };
    }
    if (redemption.status !== "reserved") {
      throw new Error(`Cannot credit a ${redemption.status} channel point redemption.`);
    }

    const [claimed] = await tx
      .update(channelPointRedemptions)
      .set({ status: "fulfilled", error: null, updatedAt: new Date() })
      .where(
        and(
          eq(channelPointRedemptions.id, redemption.id),
          eq(channelPointRedemptions.status, "reserved"),
        ),
      )
      .returning({ id: channelPointRedemptions.id });
    if (!claimed) throw new Error("Channel point redemption was already finalized.");

    await tx
      .update(portfolios)
      .set({
        availableCrowns: sql`${portfolios.availableCrowns} + ${redemption.crowns}::numeric`,
        updatedAt: new Date(),
      })
      .where(eq(portfolios.id, redemption.portfolioId));
    await tx.insert(ledgerEntries).values({
      portfolioId: redemption.portfolioId,
      kind: "channel_points",
      amount: redemption.crowns,
      metadata: {
        twitchRedemptionId: redemption.twitchRedemptionId,
        twitchRewardId: redemption.twitchRewardId,
        twitchUserId: redemption.twitchUserId,
        channelPoints: redemption.channelPoints,
      },
    });
    return { crowns: redemption.crowns, userId: portfolio.userId, accountChanged: true };
  });
}

async function resumeRedemption(
  event: ChannelPointRedemptionEvent,
  redemption: RedemptionRecord,
): Promise<RedemptionResult> {
  if (redemption.status === "fulfilled") {
    return { id: event.id, status: "fulfilled", crowns: redemption.crowns };
  }
  if (redemption.status === "canceled") {
    return {
      id: event.id,
      status: "skipped",
      crowns: "0",
      error: "Redemption was canceled on Twitch.",
    };
  }

  const twitchStatus = await confirmTwitchFulfillment(event);
  if (redemption.status === "pending") {
    if (twitchStatus === "canceled") {
      throw new Error("A legacy credited redemption is canceled on Twitch and requires review.");
    }
    await markLegacyPendingFulfilled(redemption.id);
    return { id: event.id, status: "fulfilled", crowns: redemption.crowns };
  }
  if (redemption.status !== "reserved") {
    throw new Error(`Unknown channel point redemption state: ${redemption.status}.`);
  }
  if (twitchStatus === "canceled") {
    await markReservedCanceled(redemption.id);
    return {
      id: event.id,
      status: "skipped",
      crowns: "0",
      error: "Redemption was canceled on Twitch.",
    };
  }

  const credited = await creditReservedRedemption(redemption.id);
  return {
    id: event.id,
    status: "fulfilled",
    crowns: credited.crowns,
    userId: credited.userId,
    accountChanged: credited.accountChanged,
  };
}

export async function processChannelPointRedemption(
  event: ChannelPointRedemptionEvent,
): Promise<RedemptionResult> {
  const credential = await getBroadcasterCredential();
  if (!credential || event.broadcaster_user_id !== credential.broadcasterId) {
    return { id: event.id, status: "skipped", crowns: "0", error: "Unknown broadcaster." };
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
  if (existing) {
    try {
      return await resumeRedemption(event, existing);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Settlement failed.";
      return { id: event.id, status: "failed", crowns: "0", error: message };
    }
  }
  if (event.status === "canceled") {
    return { id: event.id, status: "skipped", crowns: "0", error: "Redemption already canceled." };
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
    const reservation = await reserveRedemption(
      event,
      portfolio.id,
      crowns,
      event.reward.cost,
      activeEvent.id,
      event.user_id,
    );
    if (reservation.kind === "cap_exceeded") {
      return await cancelRedemption(
        event,
        `Conversion cap of ${getChannelPointsEventCap().toLocaleString("en-US")} Channel Points per event reached.`,
      );
    }
    return await resumeRedemption(event, reservation.redemption);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Fulfillment failed.";
    console.error("Channel point fulfillment failed.", { event, error });
    return {
      id: event.id,
      status: "failed",
      crowns: "0",
      error: message,
      userId: appUser.id,
      accountChanged: false,
    };
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
