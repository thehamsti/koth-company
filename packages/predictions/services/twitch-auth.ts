import { eq } from "drizzle-orm";
import { predictionDb } from "../db";
import { twitchBroadcasterCredentials } from "../db/schema";
import { PredictionError } from "../types";
import { refreshTwitchBroadcasterToken, type TwitchTokens } from "./twitch-api";

export type BroadcasterCredential = {
  id: string;
  broadcasterId: string;
  login: string;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
};

export async function getBroadcasterCredential(): Promise<BroadcasterCredential | null> {
  const login = (process.env.TWITCH_BROADCASTER_LOGIN ?? "hydramist").toLowerCase();
  const [row] = await predictionDb
    .select()
    .from(twitchBroadcasterCredentials)
    .where(eq(twitchBroadcasterCredentials.login, login))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    broadcasterId: row.broadcasterId,
    login: row.login,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    expiresAt: row.expiresAt,
    scope: row.scope,
  };
}

export async function storeBroadcasterCredential(
  tokens: TwitchTokens,
  broadcasterId: string,
  login: string,
): Promise<BroadcasterCredential> {
  await predictionDb
    .insert(twitchBroadcasterCredentials)
    .values({
      broadcasterId,
      login,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    })
    .onConflictDoUpdate({
      target: twitchBroadcasterCredentials.broadcasterId,
      set: {
        login,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
        updatedAt: new Date(),
      },
    });
  const [credential] = await predictionDb
    .select()
    .from(twitchBroadcasterCredentials)
    .where(eq(twitchBroadcasterCredentials.broadcasterId, broadcasterId))
    .limit(1);
  if (!credential) throw new Error("Failed to store broadcaster credential.");
  return {
    id: credential.id,
    broadcasterId: credential.broadcasterId,
    login: credential.login,
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    expiresAt: credential.expiresAt,
    scope: credential.scope,
  };
}

export async function getBroadcasterAccessToken(): Promise<string> {
  const credential = await getBroadcasterCredential();
  if (!credential) {
    throw new PredictionError(
      "TWITCH_NOT_CONNECTED",
      "Twitch broadcaster account is not connected.",
      400,
    );
  }
  if (!credential.accessToken || !credential.refreshToken) {
    throw new PredictionError(
      "TWITCH_NOT_CONNECTED",
      "Twitch broadcaster tokens are missing.",
      400,
    );
  }
  const bufferMs = 60_000;
  if (credential.expiresAt && new Date(credential.expiresAt.getTime() - bufferMs) > new Date()) {
    return credential.accessToken;
  }
  const refreshed = await refreshTwitchBroadcasterToken(credential.refreshToken);
  await storeBroadcasterCredential(refreshed, credential.broadcasterId, credential.login);
  return refreshed.accessToken;
}

export async function getBroadcasterId(): Promise<string> {
  const credential = await getBroadcasterCredential();
  if (!credential) {
    throw new PredictionError(
      "TWITCH_NOT_CONNECTED",
      "Twitch broadcaster account is not connected.",
      400,
    );
  }
  return credential.broadcasterId;
}

export async function updateBroadcasterCredentialTokens(
  credentialId: string,
  tokens: TwitchTokens,
): Promise<void> {
  await predictionDb
    .update(twitchBroadcasterCredentials)
    .set({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
      updatedAt: new Date(),
    })
    .where(eq(twitchBroadcasterCredentials.id, credentialId));
}
