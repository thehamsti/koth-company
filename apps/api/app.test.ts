import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { RedemptionResult } from "../../packages/predictions/services/channel-points";
import type { ChannelPointRedemptionEvent } from "../../packages/predictions/services/twitch-webhook";

const eventId = "00000000-0000-4000-8000-000000000001";
const arenaId = "00000000-0000-4000-8000-000000000002";
const proposalId = "00000000-0000-4000-8000-000000000003";
const ingestionSecret = "route-test-ingestion-secret";
const insertedValues: unknown[] = [];

const processRedemption = mock(
  (event: ChannelPointRedemptionEvent): Promise<RedemptionResult> =>
    Promise.resolve({
      id: event.id,
      status: "fulfilled",
      crowns: "1",
      accountChanged: false,
    }),
);
const publishAccount = mock((_userId: string) => Promise.resolve());
const publishOperatorState = mock(() => Promise.resolve());
const insertProposal = mock((input: unknown) => {
  insertedValues.push(input);
  return Promise.resolve(proposalId as string | null);
});

const previousDatabaseUri = process.env.PREDICTION_DATABASE_URI;
process.env.PREDICTION_DATABASE_URI ??= "postgresql://test:test@localhost:5432/test";
const {
  accountInvalidationForCommand,
  acquireRealtimeConnection,
  handleRequest,
  ingestion,
  predictionSnapshotFrom,
  syncRewardStateAfterCommand,
  twitchEventSub,
  viewerAccount,
} = await import("./app");
const previousEventSubSecret = process.env.TWITCH_EVENTSUB_SECRET;
const previousIngestionSecret = process.env.PREDICTION_INGEST_SECRET;
const previousRealtimePerIp = process.env.REALTIME_MAX_CONNECTIONS_PER_IP;

async function eventSubSignature(
  secret: string,
  messageId: string,
  timestamp: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${messageId}${timestamp}${body}`),
  );
  return `sha256=${Buffer.from(signature).toString("hex")}`;
}

async function eventSubRequest(
  body: string,
  messageType: string,
  messageId: string = crypto.randomUUID(),
): Promise<Request> {
  const secret = process.env.TWITCH_EVENTSUB_SECRET ?? "";
  const timestamp = new Date().toISOString();
  return new Request("http://localhost/api/twitch/eventsub", {
    method: "POST",
    headers: {
      "twitch-eventsub-message-id": messageId,
      "twitch-eventsub-message-timestamp": timestamp,
      "twitch-eventsub-message-signature": await eventSubSignature(
        secret,
        messageId,
        timestamp,
        body,
      ),
      "twitch-eventsub-message-type": messageType,
    },
    body,
  });
}

function signedIngestionRequest(body: unknown): Request {
  const rawBody = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const idempotencyKey = "proposal-route-test-1";
  const signature = createHmac("sha256", ingestionSecret)
    .update(`${timestamp}.${idempotencyKey}.${rawBody}`)
    .digest("hex");
  return new Request("http://localhost/api/predictions/ingestion-proposals", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-idempotency-key": idempotencyKey,
      "x-prediction-signature": signature,
      "x-prediction-timestamp": timestamp,
    },
    body: rawBody,
  });
}

beforeEach(() => {
  insertedValues.length = 0;
  processRedemption.mockClear();
  publishAccount.mockClear();
  publishOperatorState.mockClear();
  insertProposal.mockClear();
  process.env.TWITCH_EVENTSUB_SECRET = "super-secret-64-char-ascii-string-for-hmac-sha256!!";
  process.env.PREDICTION_INGEST_SECRET = ingestionSecret;
});

afterAll(() => {
  if (previousDatabaseUri === undefined) delete process.env.PREDICTION_DATABASE_URI;
  else process.env.PREDICTION_DATABASE_URI = previousDatabaseUri;
  if (previousEventSubSecret === undefined) delete process.env.TWITCH_EVENTSUB_SECRET;
  else process.env.TWITCH_EVENTSUB_SECRET = previousEventSubSecret;
  if (previousIngestionSecret === undefined) delete process.env.PREDICTION_INGEST_SECRET;
  else process.env.PREDICTION_INGEST_SECRET = previousIngestionSecret;
  if (previousRealtimePerIp === undefined) delete process.env.REALTIME_MAX_CONNECTIONS_PER_IP;
  else process.env.REALTIME_MAX_CONNECTIONS_PER_IP = previousRealtimePerIp;
});

describe("Twitch EventSub webhook", () => {
  test("returns the verification challenge", async () => {
    const body = JSON.stringify({ challenge: "pogchamp-kappa-360noscope-vohiyo" });
    const response = await twitchEventSub(
      await eventSubRequest(body, "webhook_callback_verification", "msg-verify"),
      { processRedemption, publishAccount },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pogchamp-kappa-360noscope-vohiyo");
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  test("rejects an invalid signature", async () => {
    const response = await twitchEventSub(
      new Request("http://localhost/api/twitch/eventsub", {
        method: "POST",
        headers: {
          "twitch-eventsub-message-id": "id",
          "twitch-eventsub-message-timestamp": new Date().toISOString(),
          "twitch-eventsub-message-signature": "sha256=invalid",
          "twitch-eventsub-message-type": "notification",
        },
        body: "{}",
      }),
      { processRedemption, publishAccount },
    );

    expect(response.status).toBe(403);
  });

  test("processes channel-point notifications", async () => {
    const body = JSON.stringify({
      subscription: { type: "channel.channel_points_custom_reward_redemption.add" },
      event: { id: "redemption-1" },
    });
    const response = await twitchEventSub(
      await eventSubRequest(body, "notification", "msg-notification"),
      { processRedemption, publishAccount },
    );

    expect(response.status).toBe(204);
    expect(processRedemption).toHaveBeenCalled();
  });

  test("returns a retryable response when processing fails", async () => {
    processRedemption.mockResolvedValueOnce({
      id: "redemption-2",
      status: "failed",
      crowns: "0",
      error: "Twitch unavailable.",
      accountChanged: false,
    });
    const body = JSON.stringify({
      subscription: { type: "channel.channel_points_custom_reward_redemption.add" },
      event: { id: "redemption-2" },
    });

    expect(
      (
        await twitchEventSub(await eventSubRequest(body, "notification", "msg-failed"), {
          processRedemption,
          publishAccount,
        })
      ).status,
    ).toBe(500);
  });

  test("rejects webhook bodies above the service limit", async () => {
    const response = await handleRequest(
      new Request("http://localhost/api/twitch/eventsub", {
        method: "POST",
        headers: {
          "twitch-eventsub-message-id": "oversized-message",
          "twitch-eventsub-message-timestamp": new Date().toISOString(),
          "twitch-eventsub-message-signature": "sha256=invalid",
          "twitch-eventsub-message-type": "notification",
        },
        body: "x".repeat(1024 * 1024 + 1),
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body exceeds the 1 MiB limit.",
      },
    });
  });
});

describe("event check-in", () => {
  test("requires a signed-in viewer", async () => {
    const response = await handleRequest(
      new Request("http://localhost/api/predictions/check-in", { method: "POST" }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "AUTH_REQUIRED", message: "Sign in with Twitch to continue." },
    });
  });
});

describe("viewer account", () => {
  test("returns only the signed-in viewer's current account", async () => {
    const loadAccount = mock((_userId: string) =>
      Promise.resolve({
        eventId,
        portfolio: { availableCrowns: "125", equity: "140" },
        sharesByOutcome: { outcome: "5" },
      }),
    );
    const response = await viewerAccount(new Request("http://localhost"), {
      requireViewer: () => Promise.resolve({ id: "viewer-1" }),
      loadAccount,
    });

    expect(response.status).toBe(200);
    expect(loadAccount).toHaveBeenCalledWith("viewer-1");
    expect(await response.json()).toMatchObject({ eventId, sharesByOutcome: { outcome: "5" } });
  });

  test("combines a cached public snapshot with only the current event account", () => {
    const snapshot = predictionSnapshotFrom(
      {
        enabled: true,
        event: {
          id: eventId,
          name: "KOTH",
          season: 2,
          week: 1,
          status: "live",
          startingCrowns: "10000",
        },
        markets: [
          {
            id: "market-1",
            version: 1,
            kind: "live_arena",
            status: "open",
            title: "Next arena",
            locksAt: null,
            outcomes: [{ id: "outcome-1", label: "Wins", probability: 0.5 }],
          },
        ],
        leaderboard: [],
        seasonLeaderboard: [],
      },
      {
        eventId,
        portfolio: { availableCrowns: "125", equity: "140" },
        sharesByOutcome: { "outcome-1": "5" },
      },
    );

    expect(snapshot.portfolio?.availableCrowns).toBe("125");
    expect(snapshot.markets[0]?.outcomes[0]?.viewerShares).toBe("5");
  });
});

describe("realtime request limits", () => {
  test("releases per-address capacity when a stream closes", () => {
    process.env.REALTIME_MAX_CONNECTIONS_PER_IP = "1";
    const request = new Request("http://localhost", {
      headers: { "cf-connecting-ip": "203.0.113.10" },
    });
    const release = acquireRealtimeConnection(request);

    expect(() => acquireRealtimeConnection(request)).toThrow(
      "Too many live-update connections are open from this address.",
    );
    release();
    const releaseAgain = acquireRealtimeConnection(request);
    releaseAgain();
  });
});

describe("account invalidation", () => {
  const state = {
    event: {
      id: eventId,
      name: "KOTH",
      season: 2,
      week: 1,
      status: "live",
      startingCrowns: "10000",
    },
    contestants: [],
    arenas: [],
    markets: [{ id: "market-1", title: "Arena", status: "settled", version: 2 }],
    proposals: [],
  };
  const previousState = {
    ...state,
    markets: [{ id: "market-1", title: "Arena", status: "locked", version: 1 }],
  };

  test("updates balances for settlement and correction but not rejected proposals", () => {
    expect(
      accountInvalidationForCommand(
        { type: "record_result", eventId, arenaId, contestantWon: true },
        state,
        previousState,
      ),
    ).toEqual({ eventId, reason: "balances_changed", marketIds: ["market-1"] });
    expect(
      accountInvalidationForCommand(
        { type: "correct_result", eventId, arenaId, contestantWon: false },
        state,
        previousState,
      ),
    ).toEqual({ eventId, reason: "balances_changed", marketIds: ["market-1"] });
    expect(
      accountInvalidationForCommand(
        { type: "review_proposal", eventId, proposalId, decision: "rejected" },
        state,
        previousState,
      ),
    ).toBeNull();
  });

  test("points clients at the new event account", () => {
    expect(
      accountInvalidationForCommand(
        { type: "create_event", name: "KOTH", season: 2, week: 2 },
        state,
      ),
    ).toEqual({ eventId, reason: "event_changed" });
  });

  test("updates holders instead of clearing accounts when an event completes", () => {
    expect(
      accountInvalidationForCommand(
        { type: "complete_event", eventId },
        {
          ...state,
          event: { ...state.event, status: "completed" },
        },
        previousState,
      ),
    ).toEqual({ eventId, reason: "balances_changed", marketIds: ["market-1"] });
  });

  test("reports a committed event when Twitch reward sync fails", async () => {
    const warnings = await syncRewardStateAfterCommand({ type: "activate_event", eventId }, () =>
      Promise.reject(new Error("Twitch unavailable")),
    );

    expect(warnings).toEqual([
      {
        code: "TWITCH_REWARD_SYNC_FAILED",
        message: "The event changed, but Twitch rewards did not sync. Run Sync rewards again.",
      },
    ]);
  });
});

describe("prediction ingestion", () => {
  test("stores a validated arena-result proposal", async () => {
    const response = await ingestion(
      signedIngestionRequest({
        eventId,
        kind: "arena_result",
        confidence: 0.98765,
        payload: { arenaId, contestantWon: false },
      }),
      { insertProposal, publishOperatorState },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: proposalId, duplicate: false });
    expect(insertedValues).toEqual([
      {
        eventId,
        kind: "arena_result",
        confidence: "0.9877",
        evidence: {},
        payload: { arenaId, contestantWon: false },
        idempotencyKey: "proposal-route-test-1",
      },
    ]);
    expect(publishOperatorState).toHaveBeenCalled();
  });

  test("rejects unsupported proposal kinds before insertion", async () => {
    const response = await handleRequest(
      signedIngestionRequest({
        eventId,
        kind: "current_contestant",
        confidence: 0.9,
        payload: { displayName: "Hydra" },
      }),
    );
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(body.error.message).toContain(
      'kind: Only "arena_result" ingestion proposals are supported.',
    );
    expect(insertedValues).toEqual([]);
  });
});
