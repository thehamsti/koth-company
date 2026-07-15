import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { predictionDb } from "@/src/predictions/db";

export async function GET() {
  if (process.env.PREDICTION_MARKETS_ENABLED !== "true") {
    return NextResponse.json({ status: "disabled" });
  }
  try {
    await predictionDb.execute(sql`select 1 from prediction_market.user limit 1`);
    return NextResponse.json({ status: "healthy" });
  } catch (error) {
    console.error("Prediction database health check failed.", error);
    return NextResponse.json({ status: "unhealthy" }, { status: 503 });
  }
}
