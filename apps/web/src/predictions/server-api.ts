import type { OperatorState, PredictionSnapshot } from "@koth/contracts";
import { headers } from "next/headers";

const internalApiUrl = process.env.INTERNAL_API_URL ?? "http://localhost:4000";

async function requestApi<T>(path: string): Promise<{ response: Response; body: T | null }> {
  const incomingHeaders = await headers();
  const cookie = incomingHeaders.get("cookie");
  const response = await fetch(new URL(path, internalApiUrl), {
    cache: "no-store",
    headers: cookie ? { cookie } : undefined,
  });
  const body = response.headers.get("content-type")?.includes("application/json")
    ? ((await response.json()) as T)
    : null;
  return { response, body };
}

export async function getPredictionBootstrap(): Promise<PredictionSnapshot> {
  const { response, body } = await requestApi<PredictionSnapshot>("/api/predictions/snapshot");
  if (!response.ok || !body) {
    throw new Error(`Prediction API returned ${response.status} while loading the viewer page.`);
  }
  return body;
}

export async function getOperatorBootstrap(): Promise<
  { status: "authorized"; state: OperatorState } | { status: "unauthorized" }
> {
  const { response, body } = await requestApi<OperatorState>("/api/predictions/operator/commands");
  if (response.status === 401 || response.status === 403) return { status: "unauthorized" };
  if (!response.ok || !body) {
    throw new Error(`Prediction API returned ${response.status} while loading operator state.`);
  }
  return { status: "authorized", state: body };
}
