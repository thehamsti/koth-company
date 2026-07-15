import { ZodError } from "zod";
import { auth } from "./auth";
import { PredictionError } from "./types";

type ValidationIssue = { path: PropertyKey[]; message: string };
type ServiceError = Error & { code: string; status: number };

function validationIssues(error: unknown): ValidationIssue[] | null {
  if (error instanceof ZodError) return error.issues;
  if (
    typeof error !== "object" ||
    error === null ||
    !("name" in error) ||
    error.name !== "ZodError" ||
    !("issues" in error) ||
    !Array.isArray(error.issues)
  ) {
    return null;
  }
  return error.issues.every(
    (issue): issue is ValidationIssue =>
      typeof issue === "object" &&
      issue !== null &&
      "path" in issue &&
      Array.isArray(issue.path) &&
      "message" in issue &&
      typeof issue.message === "string",
  )
    ? error.issues
    : null;
}

function serviceError(error: unknown): ServiceError | null {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    typeof error.code !== "string" ||
    !("status" in error) ||
    typeof error.status !== "number" ||
    !Number.isSafeInteger(error.status) ||
    error.status < 400 ||
    error.status > 599
  ) {
    return null;
  }
  return error as ServiceError;
}

export async function getViewer(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user ?? null;
}

export async function requireViewer(request: Request) {
  const viewer = await getViewer(request);
  if (!viewer) {
    throw new PredictionError("AUTH_REQUIRED", "Sign in with Twitch to continue.", 401);
  }
  return viewer;
}

export async function requireAdmin(request: Request) {
  const viewer = await requireViewer(request);
  if (viewer.role !== "admin") {
    throw new PredictionError("ADMIN_REQUIRED", "Tournament operator access is required.", 403);
  }
  return viewer;
}

export function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init);
}

export function apiError(error: unknown): Response {
  if (error instanceof PredictionError) {
    return json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  const issues = validationIssues(error);
  if (issues) {
    const message = issues
      .map((issue) => `${issue.path.map(String).join(".") || "request"}: ${issue.message}`)
      .join("; ");
    return json({ error: { code: "INVALID_REQUEST", message } }, { status: 400 });
  }
  const actionable = serviceError(error);
  if (actionable) {
    return json(
      { error: { code: actionable.code, message: actionable.message } },
      {
        status: actionable.status,
        headers: actionable.status === 503 ? { "retry-after": "30" } : undefined,
      },
    );
  }
  console.error("Prediction API request failed.", error);
  return json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "The prediction service could not complete that request.",
      },
    },
    { status: 500 },
  );
}
