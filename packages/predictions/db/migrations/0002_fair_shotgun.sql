CREATE TABLE "prediction_market"."automation_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"worker_id" text,
	"last_heartbeat_at" timestamp with time zone,
	"pause_reason" text,
	"last_observation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_session_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "prediction_market"."automation_session" ADD CONSTRAINT "automation_session_event_id_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "prediction_market"."event"("id") ON DELETE cascade ON UPDATE no action;
