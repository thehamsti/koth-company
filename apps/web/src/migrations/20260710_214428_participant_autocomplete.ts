import { sql, type MigrateDownArgs, type MigrateUpArgs } from "@payloadcms/db-postgres";

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_participants_faction" AS ENUM('Horde', 'Alliance');
  CREATE TABLE "participants" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"display_name" varchar NOT NULL,
  	"faction" "enum_participants_faction",
  	"notes" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  DROP INDEX "leaderboard_entries_player_name_idx";
  ALTER TABLE "leaderboard_entries" ADD COLUMN "participant_id" integer NOT NULL;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "participants_id" integer;
  CREATE UNIQUE INDEX "participants_display_name_idx" ON "participants" USING btree ("display_name");
  CREATE INDEX "participants_updated_at_idx" ON "participants" USING btree ("updated_at");
  CREATE INDEX "participants_created_at_idx" ON "participants" USING btree ("created_at");
  ALTER TABLE "leaderboard_entries" ADD CONSTRAINT "leaderboard_entries_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_participants_fk" FOREIGN KEY ("participants_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;
  CREATE UNIQUE INDEX "leaderboard_entries_participant_idx" ON "leaderboard_entries" USING btree ("participant_id");
  CREATE INDEX "payload_locked_documents_rels_participants_id_idx" ON "payload_locked_documents_rels" USING btree ("participants_id");
  ALTER TABLE "leaderboard_entries" DROP COLUMN "player_name";`);
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "participants" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "participants" CASCADE;
  ALTER TABLE "leaderboard_entries" DROP CONSTRAINT "leaderboard_entries_participant_id_participants_id_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_participants_fk";
  
  DROP INDEX "leaderboard_entries_participant_idx";
  DROP INDEX "payload_locked_documents_rels_participants_id_idx";
  ALTER TABLE "leaderboard_entries" ADD COLUMN "player_name" varchar NOT NULL;
  CREATE UNIQUE INDEX "leaderboard_entries_player_name_idx" ON "leaderboard_entries" USING btree ("player_name");
  ALTER TABLE "leaderboard_entries" DROP COLUMN "participant_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "participants_id";
  DROP TYPE "public"."enum_participants_faction";`);
}
