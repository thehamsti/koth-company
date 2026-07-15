import { describe, expect, test } from "bun:test";
import { grantAdminByTwitchLogin, parseTwitchLogin, type GrantAdminDependencies } from "./admin";

function dependencies(overrides: Partial<GrantAdminDependencies> = {}): GrantAdminDependencies {
  return {
    async resolveTwitchUser(login) {
      return { id: "twitch-123", login };
    },
    async findLinkedUser() {
      return { id: "user-123", email: "hydramist@twitch.local", role: "user" };
    },
    async setAdminRole() {},
    ...overrides,
  };
}

describe("prediction admin CLI", () => {
  test("parses and normalizes the Twitch login", () => {
    expect(parseTwitchLogin(["--twitch-login", "Hydramist"])).toBe("hydramist");
  });

  test("requires the Twitch user to sign in before granting access", async () => {
    const grant = grantAdminByTwitchLogin(
      "hydramist",
      dependencies({
        async findLinkedUser() {
          return null;
        },
      }),
    );
    await expect(grant).rejects.toThrow("has not signed in to koth.company with Twitch yet");
  });

  test("updates only the resolved linked account", async () => {
    let updatedUserId = "";
    const result = await grantAdminByTwitchLogin(
      "hydramist",
      dependencies({
        async setAdminRole(userId) {
          updatedUserId = userId;
        },
      }),
    );
    expect(updatedUserId).toBe("user-123");
    expect(result.changed).toBe(true);
    expect(result.user.role).toBe("admin");
  });
});
