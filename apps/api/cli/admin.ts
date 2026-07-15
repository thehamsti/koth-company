export type AdminUser = {
  id: string;
  email: string;
  role: string | null;
};

export type GrantAdminDependencies = {
  resolveTwitchUser(login: string): Promise<{ id: string; login: string } | null>;
  findLinkedUser(twitchUserId: string): Promise<AdminUser | null>;
  setAdminRole(userId: string): Promise<void>;
};

export function parseTwitchLogin(args: readonly string[]): string {
  const flag = args.indexOf("--twitch-login");
  const login = flag >= 0 ? args[flag + 1]?.trim().toLowerCase() : undefined;
  if (!login || args.length !== 2) {
    throw new Error("Usage: bun apps/api/cli/grant-admin.ts --twitch-login <login>");
  }
  return login;
}

export async function grantAdminByTwitchLogin(
  login: string,
  dependencies: GrantAdminDependencies,
): Promise<{ user: AdminUser; changed: boolean }> {
  const twitchUser = await dependencies.resolveTwitchUser(login);
  if (!twitchUser) throw new Error(`Twitch user ${login} does not exist.`);
  const user = await dependencies.findLinkedUser(twitchUser.id);
  if (!user) {
    throw new Error(
      `${twitchUser.login} has not signed in to koth.company with Twitch yet. Ask them to sign in once, then rerun this command.`,
    );
  }
  if (user.role === "admin") return { user, changed: false };
  await dependencies.setAdminRole(user.id);
  return { user: { ...user, role: "admin" }, changed: true };
}
