import { timingSafeEqual } from "node:crypto";

type SignableRequest = {
  method: string;
  path: string;
  timestamp: string;
  idempotencyKey: string;
  rawBody: string;
};

function canonicalRequest(request: SignableRequest): string {
  return [
    request.method.toUpperCase(),
    request.path,
    request.timestamp,
    request.idempotencyKey,
    request.rawBody,
  ].join("\n");
}

export async function signAutomationRequest(
  secret: string,
  request: SignableRequest,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const value = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonicalRequest(request)),
  );
  return Buffer.from(value).toString("hex");
}

export async function verifyAutomationRequest(
  secret: string,
  request: SignableRequest & { signature: string },
  now = Date.now(),
): Promise<boolean> {
  if (!/^\d+$/.test(request.timestamp) || Math.abs(now - Number(request.timestamp)) > 60_000) {
    return false;
  }
  const expected = await signAutomationRequest(secret, request);
  if (!/^[a-f\d]{64}$/i.test(request.signature)) return false;
  return timingSafeEqual(Buffer.from(request.signature, "hex"), Buffer.from(expected, "hex"));
}
