import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "@/drizzle/schema";

declare global {
  var __pgPool: Pool | undefined;
  var __drizzleDb: NodePgDatabase<typeof schema> | undefined;
}

export function getPool(): Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  if (!globalThis.__pgPool) {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    // Without an "error" listener, a single client crash takes the process down.
    pool.on("error", (err) => {
      console.error("pg pool error", err);
    });
    globalThis.__pgPool = pool;
  }
  return globalThis.__pgPool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (!globalThis.__drizzleDb) {
    globalThis.__drizzleDb = drizzle(getPool(), { schema });
  }
  return globalThis.__drizzleDb;
}
