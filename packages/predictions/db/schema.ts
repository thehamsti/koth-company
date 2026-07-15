import { relations } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const predictionSchema = pgSchema("prediction_market");

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const user = predictionSchema.table("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  role: text("role").default("user"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires", { withTimezone: true }),
  ...timestamps,
});

export const session = predictionSchema.table(
  "session",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
    ...timestamps,
  },
  (table) => [index("session_user_idx").on(table.userId)],
);

export const account = predictionSchema.table(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (table) => [
    unique("account_provider_unique").on(table.providerId, table.accountId),
    index("account_user_idx").on(table.userId),
  ],
);

export const verification = predictionSchema.table("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ...timestamps,
});

export const eventStatus = predictionSchema.enum("prediction_event_status", [
  "draft",
  "live",
  "completed",
  "cancelled",
]);
export const contestantStatus = predictionSchema.enum("prediction_contestant_status", [
  "queued",
  "active",
  "eliminated",
  "winner",
]);
export const arenaStatus = predictionSchema.enum("prediction_arena_status", [
  "open",
  "locked",
  "settled",
  "void",
]);
export const marketKind = predictionSchema.enum("prediction_market_kind", [
  "live_arena",
  "win_threshold",
  "event_winner",
]);
export const marketStatus = predictionSchema.enum("prediction_market_status", [
  "draft",
  "open",
  "locked",
  "settled",
  "void",
]);
export const tradeSide = predictionSchema.enum("prediction_trade_side", ["buy", "sell"]);

export const events = predictionSchema.table("event", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  season: integer("season").notNull(),
  week: integer("week").notNull(),
  status: eventStatus("status").default("draft").notNull(),
  startingCrowns: numeric("starting_crowns", { precision: 24, scale: 8 })
    .default("10000")
    .notNull(),
  version: integer("version").default(1).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
});

export const contestants = predictionSchema.table(
  "contestant",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    queuePosition: integer("queue_position"),
    wins: integer("wins").default(0).notNull(),
    bestStreak: integer("best_streak").default(0).notNull(),
    status: contestantStatus("status").default("queued").notNull(),
    ...timestamps,
  },
  (table) => [unique("contestant_event_name_unique").on(table.eventId, table.displayName)],
);

export const arenas = predictionSchema.table("arena", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  contestantId: uuid("contestant_id")
    .notNull()
    .references(() => contestants.id),
  ordinal: integer("ordinal").notNull(),
  status: arenaStatus("status").default("open").notNull(),
  contestantWon: boolean("contestant_won"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  ...timestamps,
});

export const markets = predictionSchema.table("market", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  arenaId: uuid("arena_id").references(() => arenas.id, { onDelete: "set null" }),
  contestantId: uuid("contestant_id").references(() => contestants.id, { onDelete: "set null" }),
  kind: marketKind("kind").notNull(),
  status: marketStatus("status").default("draft").notNull(),
  title: text("title").notNull(),
  threshold: integer("threshold"),
  liquidity: numeric("liquidity", { precision: 24, scale: 8 }).default("1000").notNull(),
  version: integer("version").default(1).notNull(),
  locksAt: timestamp("locks_at", { withTimezone: true }),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  ...timestamps,
});

export const marketOutcomes = predictionSchema.table("market_outcome", {
  id: uuid("id").defaultRandom().primaryKey(),
  marketId: uuid("market_id")
    .notNull()
    .references(() => markets.id, { onDelete: "cascade" }),
  contestantId: uuid("contestant_id").references(() => contestants.id, { onDelete: "set null" }),
  label: text("label").notNull(),
  quantity: numeric("quantity", { precision: 24, scale: 8 }).default("0").notNull(),
  settlementValue: numeric("settlement_value", { precision: 24, scale: 8 }),
  ...timestamps,
});

export const portfolios = predictionSchema.table(
  "portfolio",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    availableCrowns: numeric("available_crowns", { precision: 24, scale: 8 }).notNull(),
    settlementDebt: numeric("settlement_debt", { precision: 24, scale: 8 }).default("0").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("portfolio_event_user_unique").on(table.eventId, table.userId),
    check("portfolio_nonnegative", sql`${table.availableCrowns} >= 0`),
    check("portfolio_settlement_debt_nonnegative", sql`${table.settlementDebt} >= 0`),
  ],
);

export const positions = predictionSchema.table(
  "position",
  {
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    outcomeId: uuid("outcome_id")
      .notNull()
      .references(() => marketOutcomes.id, { onDelete: "cascade" }),
    shares: numeric("shares", { precision: 24, scale: 8 }).default("0").notNull(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.portfolioId, table.outcomeId] }),
    check("position_nonnegative", sql`${table.shares} >= 0`),
  ],
);

export const tradeQuotes = predictionSchema.table(
  "trade_quote",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    marketId: uuid("market_id")
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    outcomeId: uuid("outcome_id")
      .notNull()
      .references(() => marketOutcomes.id, { onDelete: "cascade" }),
    marketVersion: integer("market_version").notNull(),
    side: tradeSide("side").notNull(),
    crownAmount: numeric("crown_amount", { precision: 24, scale: 8 }).notNull(),
    shareAmount: numeric("share_amount", { precision: 24, scale: 8 }).notNull(),
    averagePrice: numeric("average_price", { precision: 24, scale: 8 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("trade_quote_portfolio_created_idx").on(table.portfolioId, table.createdAt),
    index("trade_quote_portfolio_expires_idx")
      .on(table.portfolioId, table.expiresAt)
      .where(sql`${table.consumedAt} is null`),
  ],
);

export const trades = predictionSchema.table(
  "trade",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => tradeQuotes.id),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    marketId: uuid("market_id")
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    outcomeId: uuid("outcome_id")
      .notNull()
      .references(() => marketOutcomes.id),
    side: tradeSide("side").notNull(),
    crownAmount: numeric("crown_amount", { precision: 24, scale: 8 }).notNull(),
    shareAmount: numeric("share_amount", { precision: 24, scale: 8 }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    ...timestamps,
  },
  (table) => [
    unique("trade_portfolio_idempotency_unique").on(table.portfolioId, table.idempotencyKey),
  ],
);

export const ledgerEntries = predictionSchema.table("ledger_entry", {
  id: uuid("id").defaultRandom().primaryKey(),
  portfolioId: uuid("portfolio_id")
    .notNull()
    .references(() => portfolios.id, { onDelete: "cascade" }),
  marketId: uuid("market_id").references(() => markets.id, { onDelete: "set null" }),
  tradeId: uuid("trade_id").references(() => trades.id, { onDelete: "set null" }),
  kind: text("kind").notNull(),
  amount: numeric("amount", { precision: 24, scale: 8 }).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  reversedAt: timestamp("reversed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const domainEvents = predictionSchema.table(
  "domain_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    source: text("source").default("operator").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique("domain_event_idempotency_unique").on(table.eventId, table.idempotencyKey)],
);

export const ingestionProposals = predictionSchema.table("ingestion_proposal", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  status: text("status").default("pending").notNull(),
  confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
  evidence: jsonb("evidence").$type<Record<string, unknown>>().default({}).notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  reviewedBy: text("reviewed_by").references(() => user.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  ...timestamps,
});

export const automationSessions = predictionSchema.table("automation_session", {
  id: uuid("id").defaultRandom().primaryKey(),
  eventId: uuid("event_id")
    .notNull()
    .unique()
    .references(() => events.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").default(false).notNull(),
  paused: boolean("paused").default(false).notNull(),
  workerId: text("worker_id"),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  pauseReason: text("pause_reason"),
  lastObservation: jsonb("last_observation").$type<Record<string, unknown>>().default({}).notNull(),
  evidenceImage: text("evidence_image"),
  ...timestamps,
});

export const twitchBroadcasterCredentials = predictionSchema.table(
  "twitch_broadcaster_credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    broadcasterId: text("broadcaster_id").notNull().unique(),
    login: text("login").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    scope: text("scope"),
    ...timestamps,
  },
);

export const twitchRewards = predictionSchema.table(
  "twitch_reward",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    broadcasterCredentialId: uuid("broadcaster_credential_id")
      .notNull()
      .references(() => twitchBroadcasterCredentials.id, { onDelete: "cascade" }),
    twitchRewardId: text("twitch_reward_id").notNull().unique(),
    title: text("title").notNull(),
    cost: integer("cost").notNull(),
    crowns: numeric("crowns", { precision: 24, scale: 8 }).notNull(),
    isEnabled: boolean("is_enabled").default(true).notNull(),
    ...timestamps,
  },
  (table) => [
    unique("twitch_reward_credential_title_unique").on(table.broadcasterCredentialId, table.title),
  ],
);

export const channelPointRedemptions = predictionSchema.table(
  "channel_point_redemption",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    twitchRedemptionId: text("twitch_redemption_id").notNull().unique(),
    twitchRewardId: text("twitch_reward_id").notNull(),
    twitchUserId: text("twitch_user_id").notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    channelPoints: integer("channel_points").notNull(),
    crowns: numeric("crowns", { precision: 24, scale: 8 }).notNull(),
    status: text("status").notNull(),
    error: text("error"),
    ...timestamps,
  },
  (table) => [
    index("channel_point_redemption_event_portfolio_idx").on(table.eventId, table.portfolioId),
  ],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  portfolios: many(portfolios),
}));

export const portfolioRelations = relations(portfolios, ({ one, many }) => ({
  user: one(user, { fields: [portfolios.userId], references: [user.id] }),
  event: one(events, { fields: [portfolios.eventId], references: [events.id] }),
  positions: many(positions),
  ledgerEntries: many(ledgerEntries),
  channelPointRedemptions: many(channelPointRedemptions),
}));

export const twitchBroadcasterCredentialRelations = relations(
  twitchBroadcasterCredentials,
  ({ many }) => ({
    rewards: many(twitchRewards),
  }),
);

export const twitchRewardRelations = relations(twitchRewards, ({ one, many }) => ({
  broadcasterCredential: one(twitchBroadcasterCredentials, {
    fields: [twitchRewards.broadcasterCredentialId],
    references: [twitchBroadcasterCredentials.id],
  }),
  redemptions: many(channelPointRedemptions),
}));

export const channelPointRedemptionRelations = relations(channelPointRedemptions, ({ one }) => ({
  event: one(events, { fields: [channelPointRedemptions.eventId], references: [events.id] }),
  portfolio: one(portfolios, {
    fields: [channelPointRedemptions.portfolioId],
    references: [portfolios.id],
  }),
}));

export const authSchema = { user, session, account, verification };
