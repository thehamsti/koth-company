const TWITCH_AUTH_URL = "https://id.twitch.tv/oauth2";
const TWITCH_API_URL = "https://api.twitch.tv/helix";

export type TwitchTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  scope: string;
};

export type TwitchRewardInput = {
  title: string;
  cost: number;
  crowns: string;
  isEnabled?: boolean;
  prompt?: string;
  backgroundColor?: string;
  isUserInputRequired?: boolean;
  maxPerUserPerStream?: number;
  shouldRedemptionsSkipRequestQueue?: boolean;
};

export type TwitchReward = {
  id: string;
  title: string;
  cost: number;
  isEnabled: boolean;
  prompt: string;
  backgroundColor: string;
  isUserInputRequired: boolean;
  maxPerUserPerStream: number | null;
  shouldRedemptionsSkipRequestQueue: boolean;
};

type TwitchRewardResponse = {
  id: string;
  title: string;
  cost: number;
  is_enabled: boolean;
  prompt: string;
  background_color: string;
  is_user_input_required: boolean;
  max_per_user_per_stream_setting: { is_enabled: boolean; max_per_user_per_stream: number };
  should_redemptions_skip_request_queue: boolean;
};

export type TwitchTokenValidation = {
  clientId: string;
  login: string;
  userId: string;
  scopes: string[];
  expiresIn: number;
};

export type TwitchEventSubSubscription = {
  id: string;
  status: string;
  type: string;
  version: string;
  condition: Record<string, string>;
  transport: { method: string; callback?: string };
  createdAt: string;
};

function getClientCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are required.");
  }
  return { clientId, clientSecret };
}

function normalizeScopes(scopes: string[] | string | undefined): string {
  if (Array.isArray(scopes)) return scopes.join(" ");
  return scopes ?? "";
}

function mapReward(reward: TwitchRewardResponse): TwitchReward {
  return {
    id: reward.id,
    title: reward.title,
    cost: reward.cost,
    isEnabled: reward.is_enabled,
    prompt: reward.prompt,
    backgroundColor: reward.background_color,
    isUserInputRequired: reward.is_user_input_required,
    maxPerUserPerStream: reward.max_per_user_per_stream_setting.is_enabled
      ? reward.max_per_user_per_stream_setting.max_per_user_per_stream
      : null,
    shouldRedemptionsSkipRequestQueue: reward.should_redemptions_skip_request_queue,
  };
}

export async function validateTwitchAccessToken(token: string): Promise<TwitchTokenValidation> {
  const response = await fetch(`${TWITCH_AUTH_URL}/validate`, {
    headers: { authorization: `OAuth ${token}` },
  });
  const data = (await response.json()) as {
    client_id?: string;
    login?: string;
    user_id?: string;
    scopes?: string[];
    expires_in?: number;
    message?: string;
  };
  if (
    !response.ok ||
    !data.client_id ||
    !data.login ||
    !data.user_id ||
    !data.scopes ||
    data.expires_in === undefined
  ) {
    throw new Error(`Invalid Twitch access token: ${data.message ?? response.statusText}`);
  }
  return {
    clientId: data.client_id,
    login: data.login,
    userId: data.user_id,
    scopes: data.scopes,
    expiresIn: data.expires_in,
  };
}

export async function getTwitchAppAccessToken(): Promise<string> {
  const { clientId, clientSecret } = getClientCredentials();
  const response = await fetch(`${TWITCH_AUTH_URL}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });
  const data = (await response.json()) as { access_token?: string; message?: string };
  if (!response.ok || !data.access_token) {
    throw new Error(
      `Failed to get Twitch app access token: ${data.message ?? response.statusText}`,
    );
  }
  return data.access_token;
}

export async function refreshTwitchBroadcasterToken(refreshToken: string): Promise<TwitchTokens> {
  const { clientId, clientSecret } = getClientCredentials();
  const response = await fetch(`${TWITCH_AUTH_URL}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string[] | string;
    message?: string;
  };
  if (!response.ok || !data.access_token) {
    throw new Error(
      `Failed to refresh Twitch broadcaster token: ${data.message ?? response.statusText}`,
    );
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
    scope: normalizeScopes(data.scope),
  };
}

async function helix<T>(
  path: string,
  {
    token,
    method = "GET",
    body,
    query,
  }: {
    token: string;
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: Record<string, unknown>;
    query?: Record<string, string | string[]>;
  },
): Promise<T> {
  const { clientId } = getClientCredentials();
  const url = new URL(`${TWITCH_API_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, item);
      } else {
        url.searchParams.set(key, value);
      }
    }
  }
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "client-id": clientId,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const responseBody = await response.text();
  const data = (responseBody ? JSON.parse(responseBody) : {}) as { message?: string } & Record<
    string,
    unknown
  >;
  if (!response.ok) {
    throw new Error(`Twitch API error (${method} ${path}): ${data.message ?? response.statusText}`);
  }
  return data as T;
}

export async function getTwitchUserByLogin(
  login: string,
  appToken: string,
): Promise<{ id: string; login: string; displayName: string } | null> {
  const { data } = await helix<{
    data: Array<{ id: string; login: string; display_name: string }>;
  }>("/users", {
    token: appToken,
    query: { login: login.toLowerCase() },
  });
  const user = data[0];
  if (!user) return null;
  return { id: user.id, login: user.login, displayName: user.display_name };
}

export async function createTwitchCustomReward(
  broadcasterId: string,
  token: string,
  reward: TwitchRewardInput,
): Promise<TwitchReward> {
  const body: Record<string, unknown> = {
    title: reward.title,
    cost: reward.cost,
    is_enabled: reward.isEnabled ?? true,
    prompt: reward.prompt ?? "",
    is_user_input_required: reward.isUserInputRequired ?? false,
    should_redemptions_skip_request_queue: reward.shouldRedemptionsSkipRequestQueue ?? false,
  };
  if (reward.backgroundColor) body.background_color = reward.backgroundColor;
  if (reward.maxPerUserPerStream !== undefined) {
    body.is_max_per_user_per_stream_enabled = true;
    body.max_per_user_per_stream = reward.maxPerUserPerStream;
  }
  const { data } = await helix<{ data: TwitchRewardResponse[] }>("/channel_points/custom_rewards", {
    token,
    method: "POST",
    query: { broadcaster_id: broadcasterId },
    body,
  });
  const created = data[0];
  if (!created) throw new Error("Twitch did not return a created reward.");
  return mapReward(created);
}

export async function getTwitchCustomRewards(
  broadcasterId: string,
  token: string,
): Promise<TwitchReward[]> {
  const { data } = await helix<{ data: TwitchRewardResponse[] }>("/channel_points/custom_rewards", {
    token,
    query: { broadcaster_id: broadcasterId, only_manageable_rewards: "true" },
  });
  return data.map(mapReward);
}

export async function updateTwitchCustomReward(
  broadcasterId: string,
  rewardId: string,
  token: string,
  updates: { isEnabled?: boolean; title?: string; cost?: number },
): Promise<TwitchReward> {
  const body: Record<string, unknown> = {};
  if (updates.isEnabled !== undefined) body.is_enabled = updates.isEnabled;
  if (updates.title !== undefined) body.title = updates.title;
  if (updates.cost !== undefined) body.cost = updates.cost;
  const { data } = await helix<{ data: TwitchRewardResponse[] }>("/channel_points/custom_rewards", {
    token,
    method: "PATCH",
    query: { broadcaster_id: broadcasterId, id: rewardId },
    body,
  });
  const updated = data[0];
  if (!updated) throw new Error("Twitch did not return an updated reward.");
  return mapReward(updated);
}

export async function getTwitchRedemptionStatus(
  broadcasterId: string,
  rewardId: string,
  redemptionId: string,
  token: string,
): Promise<"UNFULFILLED" | "FULFILLED" | "CANCELED" | null> {
  const { data } = await helix<{
    data: Array<{ id: string; status: "UNFULFILLED" | "FULFILLED" | "CANCELED" }>;
  }>("/channel_points/custom_rewards/redemptions", {
    token,
    query: { id: redemptionId, broadcaster_id: broadcasterId, reward_id: rewardId },
  });
  return data[0]?.status ?? null;
}

export async function updateTwitchRedemptionStatus(
  broadcasterId: string,
  rewardId: string,
  redemptionId: string,
  token: string,
  status: "FULFILLED" | "CANCELED",
): Promise<void> {
  await helix<Record<string, unknown>>("/channel_points/custom_rewards/redemptions", {
    token,
    method: "PATCH",
    query: { id: redemptionId, broadcaster_id: broadcasterId, reward_id: rewardId },
    body: { status },
  });
}

export async function createEventSubSubscription(
  type: string,
  version: string,
  condition: Record<string, string>,
  appToken: string,
  callback: string,
  secret: string,
): Promise<TwitchEventSubSubscription> {
  const { data } = await helix<{
    data: Array<TwitchEventSubSubscription>;
  }>("/eventsub/subscriptions", {
    token: appToken,
    method: "POST",
    body: {
      type,
      version,
      condition,
      transport: { method: "webhook", callback, secret },
    },
  });
  const subscription = data[0];
  if (!subscription) throw new Error("Twitch did not return an EventSub subscription.");
  return subscription;
}

export async function getEventSubSubscriptions(
  appToken: string,
  type?: string,
): Promise<{ data: TwitchEventSubSubscription[]; total: number }> {
  return helix<{ data: TwitchEventSubSubscription[]; total: number }>("/eventsub/subscriptions", {
    token: appToken,
    ...(type ? { query: { type } } : {}),
  });
}

export async function deleteEventSubSubscription(
  subscriptionId: string,
  appToken: string,
): Promise<void> {
  await helix<Record<string, unknown>>("/eventsub/subscriptions", {
    token: appToken,
    method: "DELETE",
    query: { id: subscriptionId },
  });
}
