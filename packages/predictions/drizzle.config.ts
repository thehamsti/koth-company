import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: new URL("./db/schema.ts", import.meta.url).pathname,
  out: new URL("./db/migrations", import.meta.url).pathname,
  dbCredentials: {
    url: process.env.PREDICTION_DATABASE_URI ?? process.env.DATABASE_URI ?? "",
  },
  schemaFilter: ["prediction_market"],
});
