export function apiErrorMessage(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null || !("error" in body)) return fallback;
  if (typeof body.error === "string") return body.error;
  if (
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
  return fallback;
}
