import { timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  operatorCommandInput,
  quoteInput,
  tradeInput,
  type OperatorCommand,
  type OperatorState,
  type PredictionPublicSnapshot,
  type PredictionSnapshot,
  type ViewerAccountSnapshot,
} from "../../packages/contracts/src";
import { authenticateAutomationRequest } from "../../packages/predictions/automation/http";
import { automationAction } from "../../packages/predictions/automation/contracts";
import {
  getAutomationState,
  runAutomationAction,
} from "../../packages/predictions/automation/service";
import { auth } from "../../packages/predictions/auth";
import { predictionDb } from "../../packages/predictions/db";
import { ingestionProposals } from "../../packages/predictions/db/schema";
import {
  apiError,
  getViewer,
  json,
  requireAdmin,
  requireViewer,
} from "../../packages/predictions/http";
import { PredictionError } from "../../packages/predictions/types";
import {
  ingestionProposal,
  type IngestionProposal,
} from "../../packages/predictions/ingestion/contracts";
import {
  processChannelPointRedemption,
  setRewardEnabled,
  setupTwitchRewards,
  syncTwitchEventSub,
  teardownTwitchRewards,
} from "../../packages/predictions/services/channel-points";
import { getOperatorState, runOperatorCommand } from "../../packages/predictions/services/operator";
import {
  checkInViewer,
  createTradeQuote,
  executeTrade,
  getPublicMarketSnapshot,
  getViewerAccountSnapshot,
} from "../../packages/predictions/services/trading";
import {
  exchangeTwitchAuthorizationCode,
  validateTwitchAccessToken,
} from "../../packages/predictions/services/twitch-api";
import { storeBroadcasterCredential } from "../../packages/predictions/services/twitch-auth";
import {
  isEventSubMessageFresh,
  parseEventSubHeaders,
  verifyEventSubMessage,
  type ChannelPointRedemptionEvent,
  type EventSubNotification,
} from "../../packages/predictions/services/twitch-webhook";
import type { RedemptionResult } from "../../packages/predictions/services/channel-points";
import { RealtimeCoordinator } from "./realtime/coordinator";
import { createSseResponse } from "./realtime/sse";

type RequestServer = { timeout(request: Request, seconds: number): void };

const TWITCH_AUTH_URL = "https://id.twitch.tv/oauth2/authorize";
const TWITCH_STATE_COOKIE = "twitch_broadcaster_oauth_state";
const TWITCH_SCOPES = "channel:manage:redemptions";
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const realtimeConnectionsByIp = new Map<string, number>();

export const realtime = new RealtimeCoordinator();

function requestIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function realtimeConnectionsPerIp(): number {
  const value = Number(process.env.REALTIME_MAX_CONNECTIONS_PER_IP ?? "20");
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("REALTIME_MAX_CONNECTIONS_PER_IP must be a positive integer.");
  }
  return value;
}

function realtimeMaxLifetimeMs(): number {
  const value = Number(process.env.REALTIME_MAX_LIFETIME_MS ?? "300000");
  if (!Number.isSafeInteger(value) || value < 60_000 || value > 3_600_000) {
    throw new Error("REALTIME_MAX_LIFETIME_MS must be from 60000 through 3600000.");
  }
  return value;
}

export function acquireRealtimeConnection(request: Request): () => void {
  const ip = requestIp(request);
  const current = realtimeConnectionsByIp.get(ip) ?? 0;
  if (current >= realtimeConnectionsPerIp()) {
    throw new PredictionError(
      "REALTIME_CLIENT_CAPACITY_EXCEEDED",
      "Too many live-update connections are open from this address. Retry shortly.",
      503,
    );
  }
  realtimeConnectionsByIp.set(ip, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (realtimeConnectionsByIp.get(ip) ?? 1) - 1;
    if (remaining > 0) realtimeConnectionsByIp.set(ip, remaining);
    else realtimeConnectionsByIp.delete(ip);
  };
}

async function readRequestText(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let result = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return result + decoder.decode();
    total += chunk.value.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      throw new PredictionError("PAYLOAD_TOO_LARGE", "Request body exceeds the 1 MiB limit.", 413);
    }
    result += decoder.decode(chunk.value, { stream: true });
  }
}

async function readRequestJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await readRequestText(request));
  } catch (error) {
    if (error instanceof PredictionError) throw error;
    throw new PredictionError("INVALID_JSON", "Request body must be valid JSON.", 400);
  }
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

function twitchStateCookie(value: string, baseUrl: string, maxAge: number): string {
  return [
    `${TWITCH_STATE_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(baseUrl.startsWith("https://") ? ["Secure"] : []),
  ].join("; ");
}

async function ingestionSignature(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const result = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Buffer.from(result).toString("hex");
}

async function predictionEvents(request: Request, server?: RequestServer): Promise<Response> {
  server?.timeout(request, 0);
  const viewer = await getViewer(request);
  const topics = viewer ? (["public", `account:${viewer.id}`] as const) : (["public"] as const);
  const release = acquireRealtimeConnection(request);
  let subscription: ReturnType<typeof realtime.broker.subscribe> | null = null;
  try {
    subscription = realtime.broker.subscribe(topics);
    const initial = await realtime.initialPrediction(viewer?.id);
    return createSseResponse(subscription, initial.events, {
      maxLifetimeMs: realtimeMaxLifetimeMs(),
      onClose: release,
    });
  } catch (error) {
    subscription?.close();
    release();
    throw error;
  }
}

async function operatorEvents(request: Request, server?: RequestServer): Promise<Response> {
  await requireAdmin(request);
  server?.timeout(request, 0);
  const release = acquireRealtimeConnection(request);
  let subscription: ReturnType<typeof realtime.broker.subscribe> | null = null;
  try {
    subscription = realtime.broker.subscribe(["operator"]);
    return createSseResponse(subscription, await realtime.initialOperator(), {
      maxLifetimeMs: realtimeMaxLifetimeMs(),
      onClose: release,
    });
  } catch (error) {
    subscription?.close();
    release();
    throw error;
  }
}

async function automationEvents(request: Request, server?: RequestServer): Promise<Response> {
  await authenticateAutomationRequest(request, "");
  server?.timeout(request, 0);
  const release = acquireRealtimeConnection(request);
  let subscription: ReturnType<typeof realtime.broker.subscribe> | null = null;
  try {
    subscription = realtime.broker.subscribe(["automation"]);
    return createSseResponse(subscription, await realtime.initialAutomation(), {
      maxLifetimeMs: realtimeMaxLifetimeMs(),
      onClose: release,
    });
  } catch (error) {
    subscription?.close();
    release();
    throw error;
  }
}

async function twitchConnect(request: Request): Promise<Response> {
  await requireAdmin(request);
  const clientId = process.env.TWITCH_CLIENT_ID;
  const baseUrl = process.env.BETTER_AUTH_URL;
  if (!clientId || !baseUrl) {
    return json({ error: "TWITCH_CLIENT_ID and BETTER_AUTH_URL must be set." }, { status: 500 });
  }
  const state = crypto.randomUUID();
  const redirectUri = new URL("/api/predictions/admin/twitch-callback", baseUrl).toString();
  const url = new URL(TWITCH_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", TWITCH_SCOPES);
  url.searchParams.set("state", state);
  url.searchParams.set("force_verify", "true");
  return new Response(null, {
    status: 302,
    headers: {
      location: url.toString(),
      "set-cookie": twitchStateCookie(state, baseUrl, 600),
    },
  });
}

async function twitchCallback(request: Request): Promise<Response> {
  await requireAdmin(request);
  const savedState = cookieValue(request, TWITCH_STATE_COOKIE);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");
  const baseUrl = process.env.BETTER_AUTH_URL ?? "";
  const expiredCookie = twitchStateCookie("", baseUrl, 0);
  if (oauthError) {
    return json(
      { error: errorDescription ?? oauthError },
      { status: 400, headers: { "set-cookie": expiredCookie } },
    );
  }
  if (!code || !state || !savedState || state !== savedState) {
    return json(
      { error: "Invalid OAuth state or missing authorization code." },
      { status: 400, headers: { "set-cookie": expiredCookie } },
    );
  }
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret || !baseUrl) {
    return json(
      { error: "Twitch OAuth credentials are not configured." },
      { status: 500, headers: { "set-cookie": expiredCookie } },
    );
  }
  const redirectUri = new URL("/api/predictions/admin/twitch-callback", baseUrl).toString();
  const tokens = await exchangeTwitchAuthorizationCode(code, redirectUri);
  if (!tokens.refreshToken) throw new Error("Twitch authorization did not return a refresh token.");
  const validation = await validateTwitchAccessToken(tokens.accessToken);
  const broadcasterLogin = (process.env.TWITCH_BROADCASTER_LOGIN ?? "hydramist").toLowerCase();
  if (validation.clientId !== clientId) {
    return json(
      { error: "Twitch issued the token for a different application." },
      { status: 400, headers: { "set-cookie": expiredCookie } },
    );
  }
  if (validation.login.toLowerCase() !== broadcasterLogin) {
    return json(
      { error: `Authorize the ${broadcasterLogin} Twitch account, not ${validation.login}.` },
      { status: 400, headers: { "set-cookie": expiredCookie } },
    );
  }
  if (!validation.scopes.includes(TWITCH_SCOPES)) {
    return json(
      { error: `Twitch authorization is missing ${TWITCH_SCOPES}.` },
      { status: 400, headers: { "set-cookie": expiredCookie } },
    );
  }
  await storeBroadcasterCredential(
    {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope || validation.scopes.join(" "),
    },
    validation.userId,
    validation.login,
  );
  return new Response(null, {
    status: 302,
    headers: {
      location: new URL("/predictions/control?twitch=connected", baseUrl).toString(),
      "set-cookie": expiredCookie,
    },
  });
}

type EventSubDependencies = {
  processRedemption(event: ChannelPointRedemptionEvent): Promise<RedemptionResult>;
  publishAccount(userId: string): Promise<void>;
};

const eventSubDependencies: EventSubDependencies = {
  processRedemption: processChannelPointRedemption,
  publishAccount: (userId) => realtime.publishAccountRefresh(userId),
};

export async function twitchEventSub(
  request: Request,
  dependencies: EventSubDependencies = eventSubDependencies,
): Promise<Response> {
  const secret = process.env.TWITCH_EVENTSUB_SECRET;
  if (!secret) return json({ error: "EventSub secret not configured." }, { status: 500 });
  const headers = parseEventSubHeaders(request);
  if (!headers) return json({ error: "Missing EventSub headers." }, { status: 400 });
  if (!isEventSubMessageFresh(headers.messageTimestamp)) {
    return json({ error: "Stale EventSub message." }, { status: 403 });
  }
  const rawBody = await readRequestText(request);
  if (!(await verifyEventSubMessage(secret, headers, rawBody))) {
    return json({ error: "Invalid signature." }, { status: 403 });
  }
  if (headers.messageType === "webhook_callback_verification") {
    const payload = JSON.parse(rawBody) as { challenge?: unknown };
    if (typeof payload.challenge !== "string") {
      return json({ error: "Missing EventSub challenge." }, { status: 400 });
    }
    return new Response(payload.challenge, { headers: { "content-type": "text/plain" } });
  }
  if (headers.messageType === "revocation") {
    console.warn("EventSub subscription revoked.", rawBody);
    return new Response(null, { status: 204 });
  }
  const notification = JSON.parse(rawBody) as EventSubNotification;
  if (notification.subscription.type === "channel.channel_points_custom_reward_redemption.add") {
    if (!notification.event) {
      return json({ error: "Missing redemption event." }, { status: 400 });
    }
    const result = await dependencies.processRedemption(
      notification.event as ChannelPointRedemptionEvent,
    );
    if (result.accountChanged && result.userId) {
      await dependencies.publishAccount(result.userId);
    }
    if (result.status === "failed") {
      console.error("Channel point redemption processing failed.", result);
      return json({ error: result.error ?? "Redemption failed." }, { status: 500 });
    }
  }
  return new Response(null, { status: 204 });
}

type StoredIngestionProposal = Omit<IngestionProposal, "confidence"> & {
  confidence: string;
  idempotencyKey: string;
};

type IngestionDependencies = {
  insertProposal(input: StoredIngestionProposal): Promise<string | null>;
  publishOperatorState(): Promise<void>;
};

const ingestionDependencies: IngestionDependencies = {
  async insertProposal(input) {
    const [record] = await predictionDb
      .insert(ingestionProposals)
      .values(input)
      .onConflictDoNothing({ target: ingestionProposals.idempotencyKey })
      .returning({ id: ingestionProposals.id });
    return record?.id ?? null;
  },
  publishOperatorState: () => realtime.publishOperatorState(),
};

export async function ingestion(
  request: Request,
  dependencies: IngestionDependencies = ingestionDependencies,
): Promise<Response> {
  const timestamp = request.headers.get("x-prediction-timestamp") ?? "";
  const idempotencyKey = request.headers.get("x-idempotency-key") ?? "";
  const provided = request.headers.get("x-prediction-signature") ?? "";
  const secret = process.env.PREDICTION_INGEST_SECRET;
  if (!secret || !/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 300_000) {
    return json(
      { error: { code: "INVALID_SIGNATURE", message: "Invalid ingestion signature." } },
      { status: 401 },
    );
  }
  const rawBody = await readRequestText(request);
  const expected = await ingestionSignature(secret, `${timestamp}.${idempotencyKey}.${rawBody}`);
  const valid =
    provided.length === expected.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  if (!valid) {
    return json(
      { error: { code: "INVALID_SIGNATURE", message: "Invalid ingestion signature." } },
      { status: 401 },
    );
  }
  const input = ingestionProposal.parse(JSON.parse(rawBody));
  const id = await dependencies.insertProposal({
    ...input,
    confidence: input.confidence.toFixed(4),
    idempotencyKey,
  });
  if (id) await dependencies.publishOperatorState();
  return json({ id, duplicate: !id });
}

type ViewerAccountDependencies = {
  requireViewer(request: Request): Promise<{ id: string }>;
  loadAccount(userId: string): Promise<ViewerAccountSnapshot>;
};

const viewerAccountDependencies: ViewerAccountDependencies = {
  requireViewer,
  loadAccount: getViewerAccountSnapshot,
};

export async function viewerAccount(
  request: Request,
  dependencies: ViewerAccountDependencies = viewerAccountDependencies,
): Promise<Response> {
  const viewer = await dependencies.requireViewer(request);
  return json(await dependencies.loadAccount(viewer.id));
}

export function predictionSnapshotFrom(
  publicSnapshot: PredictionPublicSnapshot,
  account: ViewerAccountSnapshot | null,
): PredictionSnapshot {
  const currentAccount = account?.eventId === (publicSnapshot.event?.id ?? null) ? account : null;
  return {
    ...publicSnapshot,
    portfolio: currentAccount?.portfolio ?? null,
    markets: publicSnapshot.markets.map((market) => ({
      ...market,
      outcomes: market.outcomes.map((outcome) => ({
        ...outcome,
        viewerShares: currentAccount?.sharesByOutcome[outcome.id] ?? "0",
      })),
    })),
  };
}

function activeEventId(state: OperatorState): string | null {
  return state.event?.status === "draft" || state.event?.status === "live" ? state.event.id : null;
}

export function accountInvalidationForCommand(
  command: OperatorCommand,
  state: OperatorState,
  previousState: OperatorState | null = null,
):
  | { eventId: string | null; reason: "event_changed" }
  | { eventId: string; reason: "balances_changed"; marketIds: string[] }
  | null {
  if (command.type === "create_event") {
    const eventId = activeEventId(state);
    if (previousState && activeEventId(previousState) === eventId) return null;
    return { eventId, reason: "event_changed" };
  }
  const changedMarketIds = state.markets
    .filter((market) => {
      const previous = previousState?.markets.find((candidate) => candidate.id === market.id);
      return !previous || previous.status !== market.status || previous.version !== market.version;
    })
    .map((market) => market.id);
  if (
    command.type === "record_result" ||
    command.type === "correct_result" ||
    command.type === "complete_event"
  ) {
    return { eventId: command.eventId, reason: "balances_changed", marketIds: changedMarketIds };
  }
  if (command.type === "review_proposal" && command.decision === "accepted") {
    return { eventId: command.eventId, reason: "balances_changed", marketIds: changedMarketIds };
  }
  return null;
}

async function publishAccountChange(
  change: ReturnType<typeof accountInvalidationForCommand>,
): Promise<void> {
  if (!change) return;
  if (change.reason === "event_changed") {
    realtime.publishAccountInvalidation(change);
    return;
  }
  await realtime.publishAffectedAccounts(change.eventId, change.marketIds);
}

function canInvalidateAccounts(command: OperatorCommand): boolean {
  return (
    command.type === "create_event" ||
    command.type === "complete_event" ||
    command.type === "record_result" ||
    command.type === "correct_result" ||
    (command.type === "review_proposal" && command.decision === "accepted")
  );
}

type IntegrationWarning = { code: "TWITCH_REWARD_SYNC_FAILED"; message: string };

export async function syncRewardStateAfterCommand(
  command: OperatorCommand,
  sync: (enabled: boolean) => Promise<void> = setRewardEnabled,
): Promise<IntegrationWarning[]> {
  if (command.type !== "activate_event" && command.type !== "complete_event") return [];
  try {
    await sync(command.type === "activate_event");
    return [];
  } catch {
    return [
      {
        code: "TWITCH_REWARD_SYNC_FAILED",
        message: "The event changed, but Twitch rewards did not sync. Run Sync rewards again.",
      },
    ];
  }
}

export async function handleRequest(request: Request, server?: RequestServer): Promise<Response> {
  const { pathname } = new URL(request.url);
  const method = request.method;
  try {
    if (pathname === "/api/health/live" && method === "GET") {
      return json({ status: "healthy" });
    }
    if (pathname === "/api/health/ready" && method === "GET") {
      try {
        await predictionDb.execute(sql`select 1`);
        return json({ status: "healthy" });
      } catch (error) {
        console.error("Prediction database readiness check failed.", error);
        return json({ status: "unhealthy" }, { status: 503 });
      }
    }
    if (pathname === "/api/predictions/health" && method === "GET") {
      if (process.env.PREDICTION_MARKETS_ENABLED !== "true") {
        return json({ status: "disabled" });
      }
      try {
        await predictionDb.execute(sql`select 1 from prediction_market.user limit 1`);
        return json({ status: "healthy" });
      } catch (error) {
        console.error("Prediction database health check failed.", error);
        return json({ status: "unhealthy" }, { status: 503 });
      }
    }
    if (pathname === "/api/predictions/events" && method === "GET") {
      return await predictionEvents(request, server);
    }
    if (pathname === "/api/predictions/operator/events" && method === "GET") {
      return await operatorEvents(request, server);
    }
    if (pathname === "/api/predictions/automation/events" && method === "GET") {
      return await automationEvents(request, server);
    }
    if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) {
      return await auth.handler(request);
    }
    if (pathname === "/api/predictions/snapshot" && method === "GET") {
      const viewer = await getViewer(request);
      const [publicSnapshot, account] = await Promise.all([
        realtime.getPublicSnapshot(),
        viewer ? getViewerAccountSnapshot(viewer.id) : null,
      ]);
      return json(predictionSnapshotFrom(publicSnapshot, account));
    }
    if (pathname === "/api/predictions/account" && method === "GET") {
      return await viewerAccount(request);
    }
    if (pathname === "/api/predictions/check-in" && method === "POST") {
      const viewer = await requireViewer(request);
      const result = await checkInViewer(viewer.id);
      await realtime.publishAccountRefresh(viewer.id);
      return json(result);
    }
    if (pathname === "/api/predictions/quotes" && method === "POST") {
      const viewer = await requireViewer(request);
      const input = quoteInput.parse(await readRequestJson(request));
      return json(await createTradeQuote({ userId: viewer.id, ...input }));
    }
    if (pathname === "/api/predictions/trades" && method === "POST") {
      const viewer = await requireViewer(request);
      const input = tradeInput.parse(await readRequestJson(request));
      const committed = await executeTrade({ userId: viewer.id, ...input });
      const [market, account] = await Promise.all([
        getPublicMarketSnapshot(committed.marketId),
        getViewerAccountSnapshot(viewer.id),
      ]);
      const result = { tradeId: committed.tradeId, market, account };
      realtime.publishTrade(viewer.id, result);
      return json(result);
    }
    if (pathname === "/api/predictions/operator/commands" && method === "GET") {
      await requireAdmin(request);
      return json(await getOperatorState());
    }
    if (pathname === "/api/predictions/operator/commands" && method === "POST") {
      const viewer = await requireAdmin(request);
      const body = operatorCommandInput.parse(await readRequestJson(request));
      const previousState = canInvalidateAccounts(body.command) ? await getOperatorState() : null;
      const result = await runOperatorCommand(viewer.id, body.command, body.idempotencyKey);
      const state = await getOperatorState();
      await realtime.publishControlChange(state);
      const invalidation = accountInvalidationForCommand(body.command, state, previousState);
      await publishAccountChange(invalidation);
      const warnings = await syncRewardStateAfterCommand(body.command);
      if (warnings.length > 0) {
        console.error("Twitch reward state did not follow the committed operator command.", {
          commandId: result.id,
          commandType: body.command.type,
        });
      }
      return json({ ...result, state, warnings });
    }
    if (pathname === "/api/predictions/automation/state" && method === "GET") {
      await authenticateAutomationRequest(request, "");
      return json(await getAutomationState());
    }
    if (pathname === "/api/predictions/automation/actions" && method === "POST") {
      const rawBody = await readRequestText(request);
      const idempotencyKey = await authenticateAutomationRequest(request, rawBody);
      const action = automationAction.parse(JSON.parse(rawBody));
      const previousState = action.type === "record_result" ? await getOperatorState() : null;
      const result = await runAutomationAction(action, idempotencyKey);
      const state = await getOperatorState();
      await Promise.all([realtime.publishOperatorState(state), realtime.publishAutomationState()]);
      if (action.type !== "heartbeat" && action.type !== "pause") realtime.publishPublicChange();
      if (action.type === "record_result") {
        const invalidation = accountInvalidationForCommand(action, state, previousState);
        await publishAccountChange(invalidation);
      }
      return json(result);
    }
    if (pathname === "/api/predictions/ingestion-proposals" && method === "POST") {
      return await ingestion(request);
    }
    if (pathname === "/api/predictions/admin/twitch-connect" && method === "GET") {
      return await twitchConnect(request);
    }
    if (pathname === "/api/predictions/admin/twitch-callback" && method === "GET") {
      return await twitchCallback(request);
    }
    if (pathname === "/api/predictions/admin/twitch-eventsub" && method === "POST") {
      await requireAdmin(request);
      await syncTwitchEventSub();
      return json({ success: true });
    }
    if (pathname === "/api/predictions/admin/twitch-rewards") {
      await requireAdmin(request);
      if (method === "POST") {
        await setupTwitchRewards();
        return json({ success: true });
      }
      if (method === "PATCH") {
        const body = await readRequestJson(request);
        if (
          typeof body !== "object" ||
          body === null ||
          !("enabled" in body) ||
          typeof body.enabled !== "boolean"
        ) {
          return json({ error: "Invalid request body." }, { status: 400 });
        }
        await setRewardEnabled(body.enabled);
        return json({ success: true, enabled: body.enabled });
      }
      if (method === "DELETE") {
        await teardownTwitchRewards();
        return json({ success: true });
      }
    }
    if (pathname === "/api/twitch/eventsub" && method === "POST") {
      return await twitchEventSub(request);
    }
    return json({ error: { code: "NOT_FOUND", message: "API route not found." } }, { status: 404 });
  } catch (error) {
    return apiError(error);
  }
}
