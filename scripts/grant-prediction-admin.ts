import { and, eq } from "drizzle-orm";
import { predictionDb } from "../src/predictions/db";
import { account, user } from "../src/predictions/db/schema";

const email = process.argv[2]?.trim().toLowerCase();

if (!email) {
  throw new Error("Usage: bun run predictions:grant-admin viewer@example.com");
}

const matches = await predictionDb
  .select({ id: user.id, email: user.email })
  .from(user)
  .innerJoin(account, and(eq(account.userId, user.id), eq(account.providerId, "twitch")))
  .where(eq(user.email, email));

if (matches.length !== 1) {
  throw new Error(`Expected one Twitch-authenticated user for ${email}; found ${matches.length}.`);
}

await predictionDb
  .update(user)
  .set({ role: "admin", updatedAt: new Date() })
  .where(eq(user.id, matches[0]!.id));

console.info(`Granted prediction operator access to ${matches[0]!.email}.`);
