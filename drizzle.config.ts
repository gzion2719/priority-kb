// Load .env.local first (Next.js convention; takes precedence) then fall back
// to .env. `dotenv/config` default reads only `.env`, which silently breaks
// drizzle-kit for anyone whose DATABASE_URL lives in `.env.local` (the
// Next.js convention). Codified 2026-05-28 after a fresh-setup walkthrough
// surfaced the gap: Next.js dev server ran, drizzle-kit migrate failed with
// "DATABASE_URL must be set". Both files are gitignored (.gitignore lines
// `.env` + `.env.*`); the dual-load is a dev-ergonomics fix, not a secrets
// posture change. `override: false` on the second load means .env.local wins.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set for drizzle-kit. Copy .env.example to .env.local (Next.js convention) or .env (drizzle fallback).",
  );
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
