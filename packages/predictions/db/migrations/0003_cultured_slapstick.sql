ALTER TABLE "prediction_market"."portfolio" ADD COLUMN "settlement_debt" numeric(24, 8) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "prediction_market"."portfolio" ADD CONSTRAINT "portfolio_settlement_debt_nonnegative" CHECK ("prediction_market"."portfolio"."settlement_debt" >= 0);
