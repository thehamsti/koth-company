import { describe, expect, test } from "bun:test";

const forbiddenPredictionSecrets = [
  "PREDICTION_DATABASE_URI",
  "BETTER_AUTH_SECRET",
  "TWITCH_CLIENT_SECRET",
  "TWITCH_EVENTSUB_SECRET",
  "PREDICTION_CV_SECRET",
] as const;

describe("application package boundaries", () => {
  test("keeps prediction persistence and secrets out of the web service", async () => {
    const files = new Bun.Glob("apps/web/**/*.{ts,tsx}").scan({ onlyFiles: true });
    for await (const path of files) {
      const source = await Bun.file(path).text();
      expect(source, path).not.toContain("@koth/predictions");
      for (const secret of forbiddenPredictionSecrets) {
        expect(source, `${path} references ${secret}`).not.toContain(secret);
      }
    }
  });
});
