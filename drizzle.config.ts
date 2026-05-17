import "dotenv/config";
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for drizzle-kit");
}

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  strict: true,
  verbose: true,
  // Pin the migration-history table location so M5's pg_dump restore drill
  // and any future schema-introspection tooling has a stable target.
  migrations: {
    table: "__drizzle_migrations",
    schema: "drizzle",
  },
});
