import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { predictionDb } from "./db";
import { authSchema } from "./db/schema";

export const auth = betterAuth({
  appName: "Hydramist KOTH Predictions",
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(predictionDb, {
    provider: "pg",
    schema: authSchema,
  }),
  socialProviders: {
    twitch: {
      clientId: process.env.TWITCH_CLIENT_ID ?? "",
      clientSecret: process.env.TWITCH_CLIENT_SECRET ?? "",
    },
  },
  plugins: [admin()],
});
