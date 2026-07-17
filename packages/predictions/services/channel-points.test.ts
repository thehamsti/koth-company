import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  account,
  channelPointRedemptions,
  events,
  ledgerEntries,
  portfolios,
  twitchRewards,
} from "../db/schema";
import type { ChannelPointRedemptionEvent } from "./twitch-webhook";

const twitchApi = await import("./twitch-api");

type StoredRedemption = {
  id: string;
  twitchRedemptionId: string;
  twitchRewardId: string;
  twitchUserId: string;
  eventId: string;
  portfolioId: string;
  channelPoints: number;
  crowns: string;
  status: string;
  error: string | null;
};

type FakeState = {
  redemption: StoredRedemption | null;
  crownCredits: number;
  ledgerWrites: Array<Record<string, unknown>>;
  failNextClaim: boolean;
  hasPortfolio: boolean;
};

const portfolio = {
  id: "portfolio-1",
  eventId: "event-1",
  userId: "app-user-1",
  availableCrowns: "100.00000000",
};
const activeEvent = {
  id: "event-1",
  status: "live",
  startingCrowns: "100.00000000",
  createdAt: new Date(),
};
const reward = { id: "reward-row-1", crowns: "1.00000000", cost: 1_000 };
const appUser = { userId: "app-user-1", name: "Viewer" };
let state: FakeState;

type FakeQuery = PromiseLike<unknown[]> & {
  where(...args: unknown[]): FakeQuery;
  limit(...args: unknown[]): FakeQuery;
  orderBy(...args: unknown[]): FakeQuery;
  innerJoin(...args: unknown[]): FakeQuery;
  for(...args: unknown[]): FakeQuery;
  groupBy(...args: unknown[]): FakeQuery;
};

type FakeMutation = FakeQuery & {
  returning(...args: unknown[]): FakeQuery;
  onConflictDoNothing(...args: unknown[]): FakeMutation;
};

type FakeDatabase = {
  select(selection?: object): { from(table: object): FakeQuery };
  update(table: object): { set(values: Record<string, unknown>): FakeMutation };
  insert(table: object): { values(values: Record<string, unknown>): FakeMutation };
  transaction<T>(callback: (tx: FakeDatabase) => Promise<T>): Promise<T>;
};

function query(read: () => unknown[]): FakeQuery {
  let result: FakeQuery;
  result = {
    where: () => result,
    limit: () => result,
    orderBy: () => result,
    innerJoin: () => result,
    for: () => result,
    groupBy: () => result,
    // Drizzle builders execute mutations only when the query is awaited.
    // oxlint-disable-next-line unicorn/no-thenable
    then<TResult1 = unknown[], TResult2 = never>(
      onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve().then(read).then(onfulfilled, onrejected);
    },
  };
  return result;
}

function selectionHas(selection: object | undefined, key: string): boolean {
  return selection !== undefined && Object.hasOwn(selection, key);
}

function selectedRows(table: object, selection?: object): unknown[] {
  if (table === channelPointRedemptions) {
    if (selectionHas(selection, "total")) {
      return state.redemption && state.redemption.status !== "canceled"
        ? [{ total: state.redemption.channelPoints }]
        : [];
    }
    if (!state.redemption) return [];
    if (selectionHas(selection, "portfolioId")) return [state.redemption];
    return [
      {
        id: state.redemption.id,
        status: state.redemption.status,
        crowns: state.redemption.crowns,
      },
    ];
  }
  if (table === portfolios) {
    if (!state.hasPortfolio) return [];
    if (selectionHas(selection, "userId")) return [{ userId: portfolio.userId }];
    if (selectionHas(selection, "id")) return [{ id: portfolio.id }];
    return [portfolio];
  }
  if (table === events) return [activeEvent];
  if (table === twitchRewards) return [reward];
  if (table === account) return [appUser];
  throw new Error("Unexpected table in channel point test query.");
}

function applyUpdate(table: object, values: Record<string, unknown>): unknown[] {
  if (table === channelPointRedemptions) {
    if (!state.redemption || typeof values.status !== "string") return [];
    if (values.status === "fulfilled" && state.redemption.status === "reserved") {
      if (state.failNextClaim) {
        state.failNextClaim = false;
        throw new Error("Database unavailable after Twitch fulfillment");
      }
      state.redemption = { ...state.redemption, status: "fulfilled", error: null };
      return [{ id: state.redemption.id }];
    }
    if (values.status === "fulfilled" && state.redemption.status === "pending") {
      state.redemption = { ...state.redemption, status: "fulfilled", error: null };
      return [{ id: state.redemption.id }];
    }
    if (values.status === "canceled" && state.redemption.status === "reserved") {
      state.redemption = { ...state.redemption, status: "canceled", error: null };
      return [{ id: state.redemption.id }];
    }
    return [];
  }
  if (table === portfolios && "availableCrowns" in values) {
    state.crownCredits += 1;
    return [];
  }
  throw new Error("Unexpected update in channel point test.");
}

function mutation(apply: () => unknown[]): FakeMutation {
  let applied: unknown[] | null = null;
  const run = (): unknown[] => {
    applied ??= apply();
    return applied;
  };
  const result = query(run) as FakeMutation;
  result.returning = () => query(run);
  result.onConflictDoNothing = () => result;
  return result;
}

function applyInsert(table: object, values: Record<string, unknown>): unknown[] {
  if (table === channelPointRedemptions) {
    if (state.redemption) throw new Error("Duplicate Twitch redemption.");
    state.redemption = {
      id: "local-redemption-1",
      twitchRedemptionId: String(values.twitchRedemptionId),
      twitchRewardId: String(values.twitchRewardId),
      twitchUserId: String(values.twitchUserId),
      eventId: String(values.eventId),
      portfolioId: String(values.portfolioId),
      channelPoints: Number(values.channelPoints),
      crowns: String(values.crowns),
      status: String(values.status),
      error: null,
    };
    return [{ id: state.redemption.id }];
  }
  if (table === ledgerEntries) {
    state.ledgerWrites.push(values);
    return [];
  }
  if (table === portfolios) return [];
  throw new Error("Unexpected insert in channel point test.");
}

const fakeDb: FakeDatabase = {
  select(selection?: object) {
    return { from: (table: object) => query(() => selectedRows(table, selection)) };
  },
  update(table: object) {
    return { set: (values: Record<string, unknown>) => mutation(() => applyUpdate(table, values)) };
  },
  insert(table: object) {
    return {
      values: (values: Record<string, unknown>) => mutation(() => applyInsert(table, values)),
    };
  },
  async transaction<T>(callback: (tx: FakeDatabase) => Promise<T>): Promise<T> {
    return callback(fakeDb);
  },
};

const updateTwitchRedemptionStatus = mock(
  (
    _broadcasterId: string,
    _rewardId: string,
    _redemptionId: string,
    _token: string,
    _status: "FULFILLED" | "CANCELED",
  ) => Promise.resolve(),
);
const getTwitchRedemptionStatus = mock(
  (): Promise<"UNFULFILLED" | "FULFILLED" | "CANCELED" | null> => Promise.resolve("FULFILLED"),
);

mock.module("../db", () => ({ predictionDb: fakeDb }));
mock.module("./twitch-auth", () => ({
  getBroadcasterCredential: () =>
    Promise.resolve({
      id: "credential-1",
      broadcasterId: "broadcaster-1",
      login: "hydramist",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 60_000),
      scope: "channel:manage:redemptions",
    }),
  getBroadcasterAccessToken: () => Promise.resolve("access"),
  getBroadcasterId: () => Promise.resolve("broadcaster-1"),
}));
mock.module("./twitch-api", () => ({
  ...twitchApi,
  updateTwitchRedemptionStatus,
  getTwitchRedemptionStatus,
}));

const { processChannelPointRedemption } = await import("./channel-points");
const consoleError = spyOn(console, "error").mockImplementation(() => {});

const event = {
  id: "twitch-redemption-1",
  broadcaster_user_id: "broadcaster-1",
  broadcaster_user_login: "hydramist",
  broadcaster_user_name: "Hydramist",
  user_id: "viewer-1",
  user_login: "viewer",
  user_name: "Viewer",
  user_input: "",
  status: "unfulfilled",
  reward: { id: "reward-1", title: "1 Crown", cost: 1_000, prompt: "" },
  redeemed_at: new Date().toISOString(),
} satisfies ChannelPointRedemptionEvent;

function seedRedemption(status: string): void {
  state.redemption = {
    id: "local-redemption-1",
    twitchRedemptionId: event.id,
    twitchRewardId: event.reward.id,
    twitchUserId: event.user_id,
    eventId: activeEvent.id,
    portfolioId: portfolio.id,
    channelPoints: event.reward.cost,
    crowns: reward.crowns,
    status,
    error: null,
  };
}

beforeEach(() => {
  state = {
    redemption: null,
    crownCredits: 0,
    ledgerWrites: [],
    failNextClaim: false,
    hasPortfolio: true,
  };
  updateTwitchRedemptionStatus.mockClear();
  updateTwitchRedemptionStatus.mockImplementation(() => Promise.resolve());
  getTwitchRedemptionStatus.mockClear();
  getTwitchRedemptionStatus.mockImplementation(() => Promise.resolve("FULFILLED"));
});

afterAll(() => {
  consoleError.mockRestore();
  mock.restore();
});

describe("channel point redemption durability", () => {
  test("refunds viewers who have not checked in to the event", async () => {
    state.hasPortfolio = false;

    const result = await processChannelPointRedemption(event);

    expect(result).toEqual({
      id: event.id,
      status: "skipped",
      crowns: "0",
      error: "Check in to the event on KOTH to claim your Crowns before converting Channel Points.",
    });
    expect(updateTwitchRedemptionStatus).toHaveBeenCalledWith(
      event.broadcaster_user_id,
      event.reward.id,
      event.id,
      "access",
      "CANCELED",
    );
    expect(state.redemption).toBeNull();
    expect(state.crownCredits).toBe(0);
    expect(state.ledgerWrites).toHaveLength(0);
  });

  test("reserves without crediting while Twitch fulfillment is unconfirmed", async () => {
    updateTwitchRedemptionStatus.mockImplementation(() => Promise.reject(new Error("Unavailable")));
    getTwitchRedemptionStatus.mockImplementation(() => Promise.resolve("UNFULFILLED"));

    const result = await processChannelPointRedemption(event);

    expect(result).toEqual({
      id: event.id,
      status: "failed",
      crowns: "0",
      error: "Unavailable",
      userId: appUser.userId,
      accountChanged: false,
    });
    expect(state.redemption?.status).toBe("reserved");
    expect(state.crownCredits).toBe(0);
    expect(state.ledgerWrites).toHaveLength(0);
  });

  test("reconciles Twitch success on retry before applying the local credit", async () => {
    updateTwitchRedemptionStatus.mockImplementation(() =>
      Promise.reject(new Error("Connection reset")),
    );
    getTwitchRedemptionStatus.mockImplementationOnce(() => Promise.resolve("UNFULFILLED"));
    await processChannelPointRedemption(event);
    getTwitchRedemptionStatus.mockImplementation(() => Promise.resolve("FULFILLED"));

    const result = await processChannelPointRedemption(event);

    expect(result).toEqual({
      id: event.id,
      status: "fulfilled",
      crowns: reward.crowns,
      userId: appUser.userId,
      accountChanged: true,
    });
    expect(state.redemption?.status).toBe("fulfilled");
    expect(state.crownCredits).toBe(1);
    expect(state.ledgerWrites).toHaveLength(1);
  });

  test("finishes local credit after Twitch succeeded and the first database attempt failed", async () => {
    state.failNextClaim = true;

    const failed = await processChannelPointRedemption(event);
    expect(failed.status).toBe("failed");
    expect(state.redemption?.status).toBe("reserved");
    expect(state.crownCredits).toBe(0);
    expect(state.ledgerWrites).toHaveLength(0);

    const recovered = await processChannelPointRedemption({ ...event, status: "fulfilled" });

    expect(state.redemption?.status).toBe("fulfilled");
    expect(recovered.accountChanged).toBe(true);
    expect(state.crownCredits).toBe(1);
    expect(state.ledgerWrites).toHaveLength(1);
  });

  test("marks a reserved redemption canceled without crediting it", async () => {
    seedRedemption("reserved");
    updateTwitchRedemptionStatus.mockImplementation(() =>
      Promise.reject(new Error("Already canceled")),
    );
    getTwitchRedemptionStatus.mockImplementation(() => Promise.resolve("CANCELED"));

    const result = await processChannelPointRedemption(event);

    expect(result).toEqual({
      id: event.id,
      status: "skipped",
      crowns: "0",
      error: "Redemption was canceled on Twitch.",
    });
    expect(state.redemption?.status).toBe("canceled");
    expect(state.crownCredits).toBe(0);
    expect(state.ledgerWrites).toHaveLength(0);
  });

  test("does not double credit a fulfilled redemption", async () => {
    seedRedemption("reserved");
    const fulfilledEvent = { ...event, status: "fulfilled" } satisfies ChannelPointRedemptionEvent;

    const first = await processChannelPointRedemption(fulfilledEvent);
    const second = await processChannelPointRedemption(fulfilledEvent);

    expect(first.accountChanged).toBe(true);
    expect(second).toEqual({ id: event.id, status: "fulfilled", crowns: reward.crowns });
    expect(updateTwitchRedemptionStatus).not.toHaveBeenCalled();
    expect(state.crownCredits).toBe(1);
    expect(state.ledgerWrites).toHaveLength(1);
  });

  test("settles a legacy pending row without applying its historical credit again", async () => {
    seedRedemption("pending");

    const result = await processChannelPointRedemption(event);

    expect(result).toEqual({ id: event.id, status: "fulfilled", crowns: reward.crowns });
    expect(state.redemption?.status).toBe("fulfilled");
    expect(state.crownCredits).toBe(0);
    expect(state.ledgerWrites).toHaveLength(0);
  });
});
