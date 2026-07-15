import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { auth } from "./auth";
import { PredictionError } from "./types";

export async function getViewer() {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user ?? null;
}

export async function requireViewer() {
  const viewer = await getViewer();
  if (!viewer) throw new PredictionError("AUTH_REQUIRED", "Sign in with Twitch to continue.", 401);
  return viewer;
}

export async function requireAdmin() {
  const viewer = await requireViewer();
  if (viewer.role !== "admin") {
    throw new PredictionError("ADMIN_REQUIRED", "Tournament operator access is required.", 403);
  }
  return viewer;
}

export function apiError(error: unknown): NextResponse {
  if (error instanceof PredictionError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    const message = error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "request"}: ${issue.message}`)
      .join("; ");
    return NextResponse.json({ error: { code: "INVALID_REQUEST", message } }, { status: 400 });
  }
  console.error("Prediction API request failed.", error);
  return NextResponse.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "The prediction service could not complete that request.",
      },
    },
    { status: 500 },
  );
}
