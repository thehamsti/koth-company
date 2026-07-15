CREATE SCHEMA "prediction_market";
--> statement-breakpoint
CREATE TYPE "prediction_market"."prediction_arena_status" AS ENUM('open', 'locked', 'settled', 'void');--> statement-breakpoint
CREATE TYPE "prediction_market"."prediction_contestant_status" AS ENUM('queued', 'active', 'eliminated', 'winner');--> statement-breakpoint
CREATE TYPE "prediction_market"."prediction_event_status" AS ENUM('draft', 'live', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "prediction_market"."prediction_market_kind" AS ENUM('live_arena', 'win_threshold', 'event_winner');--> statement-breakpoint
CREATE TYPE "prediction_market"."prediction_market_status" AS ENUM('draft', 'open', 'locked', 'settled', 'void');--> statement-breakpoint
CREATE TYPE "prediction_market"."prediction_trade_side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TABLE "prediction_market"."account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_provider_unique" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."arena" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"contestant_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"status" "prediction_market"."prediction_arena_status" DEFAULT 'open' NOT NULL,
	"contestant_won" boolean,
	"started_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."contestant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"queue_position" integer,
	"wins" integer DEFAULT 0 NOT NULL,
	"best_streak" integer DEFAULT 0 NOT NULL,
	"status" "prediction_market"."prediction_contestant_status" DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contestant_event_name_unique" UNIQUE("event_id","display_name")
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."domain_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"actor_user_id" text,
	"type" text NOT NULL,
	"source" text DEFAULT 'operator' NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domain_event_idempotency_unique" UNIQUE("event_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"season" integer NOT NULL,
	"week" integer NOT NULL,
	"status" "prediction_market"."prediction_event_status" DEFAULT 'draft' NOT NULL,
	"starting_crowns" numeric(24, 8) DEFAULT '10000' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."ingestion_proposal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"confidence" numeric(5, 4) NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingestion_proposal_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."ledger_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"market_id" uuid,
	"trade_id" uuid,
	"kind" text NOT NULL,
	"amount" numeric(24, 8) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."market_outcome" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_id" uuid NOT NULL,
	"contestant_id" uuid,
	"label" text NOT NULL,
	"quantity" numeric(24, 8) DEFAULT '0' NOT NULL,
	"settlement_value" numeric(24, 8),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."market" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"arena_id" uuid,
	"contestant_id" uuid,
	"kind" "prediction_market"."prediction_market_kind" NOT NULL,
	"status" "prediction_market"."prediction_market_status" DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"threshold" integer,
	"liquidity" numeric(24, 8) DEFAULT '1000' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"locks_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."portfolio" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"available_crowns" numeric(24, 8) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_event_user_unique" UNIQUE("event_id","user_id"),
	CONSTRAINT "portfolio_nonnegative" CHECK ("prediction_market"."portfolio"."available_crowns" >= 0)
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."position" (
	"portfolio_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"shares" numeric(24, 8) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "position_portfolio_id_outcome_id_pk" PRIMARY KEY("portfolio_id","outcome_id"),
	CONSTRAINT "position_nonnegative" CHECK ("prediction_market"."position"."shares" >= 0)
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."session" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."trade_quote" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"market_version" integer NOT NULL,
	"side" "prediction_market"."prediction_trade_side" NOT NULL,
	"crown_amount" numeric(24, 8) NOT NULL,
	"share_amount" numeric(24, 8) NOT NULL,
	"average_price" numeric(24, 8) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."trade" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"market_id" uuid NOT NULL,
	"outcome_id" uuid NOT NULL,
	"side" "prediction_market"."prediction_trade_side" NOT NULL,
	"crown_amount" numeric(24, 8) NOT NULL,
	"share_amount" numeric(24, 8) NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_portfolio_idempotency_unique" UNIQUE("portfolio_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'user',
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prediction_market"."account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "prediction_market"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."arena" ADD CONSTRAINT "arena_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "prediction_market"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."arena" ADD CONSTRAINT "arena_contestant_id_contestant_id_fk" FOREIGN KEY ("contestant_id") REFERENCES "prediction_market"."contestant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."contestant" ADD CONSTRAINT "contestant_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "prediction_market"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."domain_event" ADD CONSTRAINT "domain_event_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "prediction_market"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."domain_event" ADD CONSTRAINT "domain_event_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "prediction_market"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."ingestion_proposal" ADD CONSTRAINT "ingestion_proposal_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "prediction_market"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."ingestion_proposal" ADD CONSTRAINT "ingestion_proposal_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "prediction_market"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."ledger_entry" ADD CONSTRAINT "ledger_entry_portfolio_id_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "prediction_market"."portfolio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."ledger_entry" ADD CONSTRAINT "ledger_entry_market_id_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "prediction_market"."market"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."ledger_entry" ADD CONSTRAINT "ledger_entry_trade_id_trade_id_fk" FOREIGN KEY ("trade_id") REFERENCES "prediction_market"."trade"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."market_outcome" ADD CONSTRAINT "market_outcome_market_id_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "prediction_market"."market"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."market_outcome" ADD CONSTRAINT "market_outcome_contestant_id_contestant_id_fk" FOREIGN KEY ("contestant_id") REFERENCES "prediction_market"."contestant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."market" ADD CONSTRAINT "market_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "prediction_market"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."market" ADD CONSTRAINT "market_arena_id_arena_id_fk" FOREIGN KEY ("arena_id") REFERENCES "prediction_market"."arena"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."market" ADD CONSTRAINT "market_contestant_id_contestant_id_fk" FOREIGN KEY ("contestant_id") REFERENCES "prediction_market"."contestant"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."portfolio" ADD CONSTRAINT "portfolio_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "prediction_market"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."portfolio" ADD CONSTRAINT "portfolio_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "prediction_market"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."position" ADD CONSTRAINT "position_portfolio_id_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "prediction_market"."portfolio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."position" ADD CONSTRAINT "position_outcome_id_market_outcome_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "prediction_market"."market_outcome"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "prediction_market"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."trade_quote" ADD CONSTRAINT "trade_quote_portfolio_id_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "prediction_market"."portfolio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."trade_quote" ADD CONSTRAINT "trade_quote_market_id_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "prediction_market"."market"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."trade_quote" ADD CONSTRAINT "trade_quote_outcome_id_market_outcome_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "prediction_market"."market_outcome"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."trade" ADD CONSTRAINT "trade_quote_id_trade_quote_id_fk" FOREIGN KEY ("quote_id") REFERENCES "prediction_market"."trade_quote"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."trade" ADD CONSTRAINT "trade_portfolio_id_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "prediction_market"."portfolio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."trade" ADD CONSTRAINT "trade_market_id_market_id_fk" FOREIGN KEY ("market_id") REFERENCES "prediction_market"."market"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."trade" ADD CONSTRAINT "trade_outcome_id_market_outcome_id_fk" FOREIGN KEY ("outcome_id") REFERENCES "prediction_market"."market_outcome"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "prediction_market"."account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "prediction_market"."session" USING btree ("user_id");
