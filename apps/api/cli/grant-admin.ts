import { and, eq } from "drizzle-orm";
import { predictionDb } from "../../../packages/predictions/db";
import { account, user } from "../../../packages/predictions/db/schema";
import {
  getTwitchAppAccessToken,
  getTwitchUserByLogin,
} from "../../../packages/predictions/services/twitch-api";
import { grantAdminByTwitchLogin, parseTwitchLogin } from "./admin";

const login = parseTwitchLogin(Bun.argv.slice(2));
const result = await grantAdminByTwitchLogin(login, {
  async resolveTwitchUser(twitchLogin) {
    const token = await getTwitchAppAccessToken();
    return getTwitchUserByLogin(twitchLogin, token);
  },
  async findLinkedUser(twitchUserId) {
    const [linked] = await predictionDb
      .select({ id: user.id, email: user.email, role: user.role })
      .from(account)
      .innerJoin(user, eq(user.id, account.userId))
      .where(and(eq(account.providerId, "twitch"), eq(account.accountId, twitchUserId)))
      .limit(1);
    return linked ?? null;
  },
  async setAdminRole(userId) {
    await predictionDb
      .update(user)
      .set({ role: "admin", updatedAt: new Date() })
      .where(eq(user.id, userId));
  },
});

console.info(
  result.changed
    ? `Granted prediction operator access to ${login} (${result.user.email}).`
    : `${login} (${result.user.email}) already has prediction operator access.`,
);
