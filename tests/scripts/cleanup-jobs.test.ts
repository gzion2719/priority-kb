import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { enqueueJob } from "@/lib/jobs";
import { resetLogSink, setLogSink } from "@/lib/log";
import * as schema from "@/drizzle/schema";

// Integration test for scripts/cleanup-jobs.mjs (ADR-0019 §D12 + Amendment §B).
// Verifies the 7-day cutoff + the `done`-only scope.

const databaseUrl = process.env.DATABASE_URL;
const isCi = process.env.CI === "true";

if (isCi && !databaseUrl) {
  throw new Error("DATABASE_URL must be set in CI; cleanup-jobs script test cannot silently skip");
}

const describeIfDb = databaseUrl ? describe : describe.skip;

// Repo-root resolve (test file at tests/scripts/, script at scripts/).
const scriptPath = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "scripts",
  "cleanup-jobs.mjs",
);

describeIfDb("scripts/cleanup-jobs.mjs", () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });
    setLogSink(() => undefined);
  });

  afterAll(async () => {
    resetLogSink();
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("TRUNCATE jobs, audit_log CASCADE");
  });

  async function seedJobWithUpdatedAt(
    idemKey: string,
    state: schema.JobState,
    updatedAtIso: string,
  ): Promise<string> {
    const r = await enqueueJob(db, {
      queue: "ingest",
      payload: { entry_id: idemKey },
      idempotencyKey: idemKey,
    });
    await pool.query(`UPDATE jobs SET state=$1::job_state, updated_at=$2 WHERE id=$3`, [
      state,
      updatedAtIso,
      r.id,
    ]);
    return r.id;
  }

  function runScript(): { stdout: string; stderr: string; status: number } {
    const result = spawnSync("node", [scriptPath], {
      env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "test" },
      encoding: "utf8",
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      status: result.status ?? -1,
    };
  }

  it("prunes only `done` rows older than 7 days", async () => {
    const oldDone = await seedJobWithUpdatedAt("old-done", "done", "2020-01-01T00:00:00Z");
    const freshDone = await seedJobWithUpdatedAt("fresh-done", "done", new Date().toISOString());
    const result = runScript();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/pruned 1 done row/);

    const remaining = await db.select({ id: schema.jobs.id }).from(schema.jobs);
    const ids = remaining.map((r) => r.id);
    expect(ids).toContain(freshDone);
    expect(ids).not.toContain(oldDone);
  });

  it("does NOT prune `dead` rows even when older than 7 days (ADR-0019 §D12 retain-indefinitely)", async () => {
    const oldDead = await seedJobWithUpdatedAt("old-dead", "dead", "2020-01-01T00:00:00Z");
    runScript();
    const remaining = await db.select({ id: schema.jobs.id }).from(schema.jobs);
    expect(remaining.map((r) => r.id)).toContain(oldDead);
  });

  it("does NOT prune `failed`-not-yet-`dead` rows even when older than 7 days (Amendment §B)", async () => {
    // Negative-assertion shape: a script that pruned `state IN ('done','failed')`
    // would pass the prior two tests but fail this one — proves the script
    // discriminates `failed` from `done`. Slow-failing retries must not be
    // silently dropped mid-retry.
    const oldFailed = await seedJobWithUpdatedAt("old-failed", "failed", "2020-01-01T00:00:00Z");
    runScript();
    const remaining = await db.select({ id: schema.jobs.id }).from(schema.jobs);
    expect(remaining.map((r) => r.id)).toContain(oldFailed);
  });

  it("does NOT prune `queued` / `in_progress` rows (active work; older-than-7d means stuck, not stale)", async () => {
    const oldQueued = await seedJobWithUpdatedAt("old-queued", "queued", "2020-01-01T00:00:00Z");
    const oldInProgress = await seedJobWithUpdatedAt(
      "old-in-progress",
      "in_progress",
      "2020-01-01T00:00:00Z",
    );
    runScript();
    const remaining = await db.select({ id: schema.jobs.id }).from(schema.jobs);
    const ids = remaining.map((r) => r.id);
    expect(ids).toContain(oldQueued);
    expect(ids).toContain(oldInProgress);
  });
});
