import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/predictions/db/schema.ts",
  out: "./src/predictions/db/migrations",
  dbCredentials: {
    url: process.env.PREDICTION_DATABASE_URI ?? process.env.DATABASE_URI ?? "",
  },
  schemaFilter: ["prediction_market"],
});
