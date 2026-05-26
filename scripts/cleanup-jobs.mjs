#!/usr/bin/env node
// scripts/cleanup-jobs.mjs
//
// ADR-0019 §D12 — prune `done` rows from the `jobs` table older than 7 days.
//
// Scope (intentionally narrow):
//   - Only `state='done'` rows are pruned. `dead` rows are retained
//     indefinitely as the dead-letter audit surface (ADR-0019 §D12).
//   - `failed`-but-not-yet-`dead` rows (attempts < max_attempts) are NOT
//     pruned by this script. They are actively retried by the worker and
//     either transition to `done` (then become eligible for the 7-day
//     prune) or `dead` (retained). A slow-failing job that sits at
//     attempts < max_attempts indefinitely is uncommon in M2b scope —
//     OCR/parse failures terminate quickly. If this becomes a real
//     storage pressure, add a separate "stale-failed" sweep with a
//     longer window; do not extend this script's scope.
//
// Scheduling: this script is invoked from a cron / scheduled task by the
// operator (the M1 `scripts/backup-db.ps1` pattern — no in-process
// cron in M2b). Run nightly is sufficient.

import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  console.error("cleanup-jobs: DATABASE_URL must be set");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const res = await pool.query(
    `DELETE FROM "jobs"
     WHERE "state" = 'done'
       AND "updated_at" < now() - interval '7 days'
     RETURNING "id"`,
  );
  // One-line summary suitable for cron log capture. Not LogEvent-shaped —
  // this is operator-facing housekeeping output, not the structured
  // observability surface. `?? 0` guards against pg's nullable rowCount
  // typing (code-CR n3).
  console.log(`cleanup-jobs: pruned ${res.rowCount ?? 0} done row(s)`);
} catch (err) {
  // Silent-on-failure would be the worst housekeeping-cron failure mode
  // (operator sees nothing in stdout; downstream alerting depends on a
  // visible non-zero exit). Code-CR M4 (2026-05-26).
  console.error("cleanup-jobs: failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
