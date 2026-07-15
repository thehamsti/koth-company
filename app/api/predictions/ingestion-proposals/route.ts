import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { predictionDb } from "@/src/predictions/db";
import { ingestionProposals } from "@/src/predictions/db/schema";
import { apiError } from "@/src/predictions/http";
import { ingestionProposal } from "@/src/predictions/ingestion/contracts";

async function signatureFor(secret: string, value: string): Promise<string> {
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

export async function POST(request: Request) {
  try {
    const timestamp = request.headers.get("x-prediction-timestamp") ?? "";
    const idempotencyKey = request.headers.get("x-idempotency-key") ?? "";
    const provided = request.headers.get("x-prediction-signature") ?? "";
    const secret = process.env.PREDICTION_INGEST_SECRET;
    if (!secret || !/^\d+$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 300_000) {
      return NextResponse.json(
        { error: { code: "INVALID_SIGNATURE", message: "Invalid ingestion signature." } },
        { status: 401 },
      );
    }
    const raw = await request.text();
    const expected = await signatureFor(secret, `${timestamp}.${idempotencyKey}.${raw}`);
    const valid =
      provided.length === expected.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    if (!valid) {
      return NextResponse.json(
        { error: { code: "INVALID_SIGNATURE", message: "Invalid ingestion signature." } },
        { status: 401 },
      );
    }
    const input = ingestionProposal.parse(JSON.parse(raw));
    const [record] = await predictionDb
      .insert(ingestionProposals)
      .values({ ...input, confidence: input.confidence.toFixed(4), idempotencyKey })
      .onConflictDoNothing({ target: ingestionProposals.idempotencyKey })
      .returning({ id: ingestionProposals.id });
    return NextResponse.json({ id: record?.id ?? null, duplicate: !record });
  } catch (error) {
    return apiError(error);
  }
}
