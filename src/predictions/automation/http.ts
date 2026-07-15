import { verifyAutomationRequest } from "./auth";
import { PredictionError } from "../types";

export async function authenticateAutomationRequest(
  request: Request,
  rawBody: string,
): Promise<string> {
  const secret = process.env.PREDICTION_CV_SECRET;
  const timestamp = request.headers.get("x-cv-timestamp") ?? "";
  const idempotencyKey = request.headers.get("x-cv-idempotency-key") ?? "";
  const signature = request.headers.get("x-cv-signature") ?? "";
  const path = new URL(request.url).pathname;
  if (
    !secret ||
    idempotencyKey.length < 8 ||
    !(await verifyAutomationRequest(secret, {
      method: request.method,
      path,
      timestamp,
      idempotencyKey,
      rawBody,
      signature,
    }))
  ) {
    throw new PredictionError("AUTH_REQUIRED", "Invalid automation signature.", 401);
  }
  return idempotencyKey;
}
