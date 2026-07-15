CREATE TABLE "prediction_market"."channel_point_redemption" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"twitch_redemption_id" text NOT NULL,
	"twitch_reward_id" text NOT NULL,
	"twitch_user_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"channel_points" integer NOT NULL,
	"crowns" numeric(24, 8) NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "channel_point_redemption_twitch_redemption_id_unique" UNIQUE("twitch_redemption_id")
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."twitch_broadcaster_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcaster_id" text NOT NULL,
	"login" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"expires_at" timestamp with time zone,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "twitch_broadcaster_credentials_broadcaster_id_unique" UNIQUE("broadcaster_id")
);
--> statement-breakpoint
CREATE TABLE "prediction_market"."twitch_reward" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcaster_credential_id" uuid NOT NULL,
	"twitch_reward_id" text NOT NULL,
	"title" text NOT NULL,
	"cost" integer NOT NULL,
	"crowns" numeric(24, 8) NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "twitch_reward_twitch_reward_id_unique" UNIQUE("twitch_reward_id"),
	CONSTRAINT "twitch_reward_credential_title_unique" UNIQUE("broadcaster_credential_id","title")
);
--> statement-breakpoint
ALTER TABLE "prediction_market"."channel_point_redemption" ADD CONSTRAINT "channel_point_redemption_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "prediction_market"."event"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."channel_point_redemption" ADD CONSTRAINT "channel_point_redemption_portfolio_id_portfolio_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "prediction_market"."portfolio"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prediction_market"."twitch_reward" ADD CONSTRAINT "twitch_reward_broadcaster_credential_id_twitch_broadcaster_credentials_id_fk" FOREIGN KEY ("broadcaster_credential_id") REFERENCES "prediction_market"."twitch_broadcaster_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "channel_point_redemption_event_portfolio_idx" ON "prediction_market"."channel_point_redemption" USING btree ("event_id","portfolio_id");
