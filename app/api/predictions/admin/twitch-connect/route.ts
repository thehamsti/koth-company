import { requireAdmin } from "@/src/predictions/http";
import { NextResponse } from "next/server";

const TWITCH_AUTH_URL = "https://id.twitch.tv/oauth2/authorize";
const COOKIE_NAME = "twitch_broadcaster_oauth_state";
const SCOPES = "channel:manage:redemptions";

export async function GET() {
  try {
    await requireAdmin();
    const clientId = process.env.TWITCH_CLIENT_ID;
    const baseUrl = process.env.BETTER_AUTH_URL;
    if (!clientId || !baseUrl) {
      return NextResponse.json(
        { error: "TWITCH_CLIENT_ID and BETTER_AUTH_URL must be set." },
        { status: 500 },
      );
    }
    const state = crypto.randomUUID();
    const redirectUri = new URL("/api/predictions/admin/twitch-callback", baseUrl).toString();
    const url = new URL(TWITCH_AUTH_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", SCOPES);
    url.searchParams.set("state", state);
    url.searchParams.set("force_verify", "true");
    const response = NextResponse.redirect(url.toString());
    response.cookies.set(COOKIE_NAME, state, {
      httpOnly: true,
      secure: baseUrl.startsWith("https://"),
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    });
    return response;
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to initiate connect." },
      { status: 500 },
    );
  }
}
