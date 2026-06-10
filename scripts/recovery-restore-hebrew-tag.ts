/*
 * scripts/recovery-restore-hebrew-tag.ts
 * --------------------
 * One-shot recovery for the 2026-06-10 accidental `delete tag "hebrew"`
 * operation. The delete removed "hebrew" from 14 dev-synthetic entries
 * via the M4 #4 PR-A delete primitive (each entry got a new version
 * with the tag stripped, the prior version still has it in
 * entries_versions).
 *
 * Approach: for every entry currently MISSING "hebrew" but historically
 * having had it, fetch the entry's current snapshot, append "hebrew" to
 * its tags array, and PUT it back through /api/ingest/[id]. The PUT
 * route is admin-gated, fully versioned (appends a new entries_versions
 * row), audit-logged, and re-chunks + re-embeds — so this is a
 * compliant write through the same code path the UI uses, NOT a raw
 * DB hack.
 *
 * Iron-rule footprint (same as the M4 #4 tag-management primitives):
 *   #2  no raw DB writes — recovery flows through the existing PUT
 *       /api/ingest/[id] route → updateEntry in lib/ingest.ts.
 *   #4  admin gate satisfied via STUB_ROLE_HEADER=admin (dev-only
 *       compliant; M5 swaps to session cookie).
 *   #6  sensitivity preserved verbatim from current snapshot.
 *   #10 no prompt_hash sent — direct path, route writes
 *       kind:"ingest_update" with prompt_hash:null per ADR-0021 §D4.
 *
 * Usage (from the project root with dev server running on :3000 and
 * Postgres up via docker compose):
 *
 *   DATABASE_URL="postgres://postgres:postgres@localhost:5432/priority_kb" \
 *     npx tsx scripts/recovery-restore-hebrew-tag.ts
 *
 * Or with --dry-run to list affected entries without mutating:
 *
 *   DATABASE_URL=... npx tsx scripts/recovery-restore-hebrew-tag.ts --dry-run
 *
 * Safe to re-run: idempotent. An entry that already has "hebrew" is
 * skipped (the SQL filter excludes it).
 */

import { Pool } from "pg";
import { STUB_ROLE_HEADER } from "@/lib/auth";

const RECOVERY_TAG = "hebrew";
const API_BASE = process.env.API_BASE ?? "http://localhost:3000";
const DRY_RUN = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const conn = process.env.DATABASE_URL;
  if (!conn) {
    console.error("ERROR: DATABASE_URL not set.");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: conn });

  // Find entries that:
  //   - currently DO NOT have "hebrew" in their tags
  //   - DID have "hebrew" in some prior version
  // The intersection identifies entries that lost the tag via the
  // accidental delete.
  const q = await pool.query<{
    id: string;
    title: string;
    current_tags: string[];
  }>(
    `
    SELECT e.id, e.title, e.tags AS current_tags
    FROM entries e
    WHERE NOT $1 = ANY(e.tags)
      AND EXISTS (
        SELECT 1
        FROM entries_versions ev
        WHERE ev.entry_id = e.id
          AND $1 = ANY(ev.tags)
      )
    ORDER BY e.title;
    `,
    [RECOVERY_TAG],
  );

  console.log(
    `Found ${q.rows.length} entries missing "${RECOVERY_TAG}" but historically having had it.`,
  );

  if (DRY_RUN) {
    for (const row of q.rows) {
      console.log(
        `  - ${row.id} :: "${row.title}" (current tags: [${row.current_tags.join(", ")}])`,
      );
    }
    console.log("\nDry run only. Re-run without --dry-run to apply.");
    await pool.end();
    return;
  }

  let ok = 0;
  let failed = 0;

  for (const row of q.rows) {
    // The PUT route requires the FULL entry shape (IngestBodyForPut).
    // Pull the current snapshot from `entries` so the PUT carries
    // identical values for every field except the appended tag.
    const snap = await pool.query<{
      title: string;
      category: string;
      tags: string[];
      body: string;
      source_pointer: string;
      last_verified_at: Date;
      sensitivity: string;
    }>(
      `
      SELECT title, category, tags, body, source_pointer, last_verified_at, sensitivity
      FROM entries
      WHERE id = $1;
      `,
      [row.id],
    );
    if (snap.rows.length === 0) {
      console.warn(`  ! ${row.id} :: not found in entries (race?), skipping`);
      failed++;
      continue;
    }
    const s = snap.rows[0];
    const newTags = [...s.tags, RECOVERY_TAG];

    const body = {
      title: s.title,
      category: s.category,
      tags: newTags,
      body: s.body,
      source_pointer: s.source_pointer,
      last_verified_at: s.last_verified_at.toISOString(),
      sensitivity: s.sensitivity,
    };

    const res = await fetch(`${API_BASE}/api/ingest/${row.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        [STUB_ROLE_HEADER]: "admin",
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      console.log(`  ✓ ${row.id} :: "${row.title}"`);
      ok++;
    } else {
      const text = await res.text();
      console.warn(`  ✗ ${row.id} :: HTTP ${res.status} — ${text.slice(0, 200)}`);
      failed++;
    }
  }

  console.log(`\nDone. ${ok} restored, ${failed} failed.`);
  await pool.end();
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
