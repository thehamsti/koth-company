import { requireAdmin } from "@/src/predictions/http";
import { validateTwitchAccessToken } from "@/src/predictions/services/twitch-api";
import { storeBroadcasterCredential } from "@/src/predictions/services/twitch-auth";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const COOKIE_NAME = "twitch_broadcaster_oauth_state";

export async function GET(request: Request) {
  try {
    await requireAdmin();
    const cookieStore = await cookies();
    const savedState = cookieStore.get(COOKIE_NAME)?.value;
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");
    cookieStore.delete(COOKIE_NAME);
    if (error) {
      return NextResponse.json({ error: errorDescription ?? error }, { status: 400 });
    }
    if (!code || !state || !savedState || state !== savedState) {
      return NextResponse.json(
        { error: "Invalid OAuth state or missing authorization code." },
        { status: 400 },
      );
    }
    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;
    const baseUrl = process.env.BETTER_AUTH_URL;
    if (!clientId || !clientSecret || !baseUrl) {
      return NextResponse.json(
        { error: "Twitch OAuth credentials are not configured." },
        { status: 500 },
      );
    }
    const redirectUri = new URL("/api/predictions/admin/twitch-callback", baseUrl).toString();
    const tokenResponse = await fetch(TWITCH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = (await tokenResponse.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string[];
      message?: string;
    };
    if (!tokenResponse.ok || !tokenData.access_token || !tokenData.refresh_token) {
      return NextResponse.json(
        {
          error: `Failed to exchange Twitch code: ${tokenData.message ?? tokenResponse.statusText}`,
        },
        { status: 500 },
      );
    }
    const validation = await validateTwitchAccessToken(tokenData.access_token);
    const login = (process.env.TWITCH_BROADCASTER_LOGIN ?? "hydramist").toLowerCase();
    if (validation.clientId !== clientId) {
      return NextResponse.json(
        { error: "Twitch issued the token for a different application." },
        { status: 400 },
      );
    }
    if (validation.login.toLowerCase() !== login) {
      return NextResponse.json(
        { error: `Authorize the ${login} Twitch account, not ${validation.login}.` },
        { status: 400 },
      );
    }
    if (!validation.scopes.includes("channel:manage:redemptions")) {
      return NextResponse.json(
        { error: "Twitch authorization is missing channel:manage:redemptions." },
        { status: 400 },
      );
    }
    await storeBroadcasterCredential(
      {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token ?? "",
        expiresAt: new Date(Date.now() + (tokenData.expires_in ?? 3600) * 1000),
        scope: (tokenData.scope ?? validation.scopes).join(" "),
      },
      validation.userId,
      validation.login,
    );
    return NextResponse.redirect(new URL("/predictions/control?twitch=connected", baseUrl));
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("Twitch broadcaster callback failed.", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Callback failed." },
      { status: 500 },
    );
  }
}
