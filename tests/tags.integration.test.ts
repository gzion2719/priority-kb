// tests/tags.integration.test.ts — M4 #4 PR-A end-to-end coverage.
//
// Per the standard DB-integration pattern: skipped locally when DATABASE_URL
// is unset (`describe.skipIf`), runs in CI against a fresh docker postgres.
// Mirrors tests/entries.integration.test.ts seed/cleanup discipline.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "@/drizzle/schema";
import { createStubEmbedder, type Embedder } from "@/lib/embedding";
import { createEntry } from "@/lib/ingest";
import { listAdminTagsForRole, listRecentTagAuditRows } from "@/lib/admin-tags";
import { MergeRollbackError, deleteTag, mergeTags, renameTag } from "@/lib/tags";

const DATABASE_URL = process.env.DATABASE_URL;

// CI integration job sets DATABASE_URL; local dev runs without unless an
// admin spins up docker-compose. Skip-when-unset mirrors the other
// `.integration.test.ts` files.
describe.skipIf(!DATABASE_URL)("tags integration (PR-A)", () => {
  let pool: Pool;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const embedder = createStubEmbedder();

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    // CI hotfix 2026-06-01: clean tagtest-* data on file teardown so the
    // last test's seed doesn't leak into the next test file. `fileParallelism`
    // is false (vitest.config.ts) so files run serially; without this
    // afterAll, the last test's tagtest-* entries survived until the next
    // file's beforeEach — which in tests/retrieval-ann.integration.test.ts
    // is actually an afterEach (it has none of its own beforeEach), so
    // ANN's first test saw leaked public-sensitivity entries (CI red:
    // expected 3, got 5 = 3 ANN-seeded + 2 of mine).
    await pool
      .query(
        `DELETE FROM audit_log WHERE entry_id IN (SELECT id FROM entries WHERE source_pointer LIKE 'tagtest-%')`,
      )
      .catch(() => {});
    await pool.query(`DELETE FROM audit_log WHERE kind LIKE 'tag\\_%' ESCAPE '\\'`).catch(() => {});
    await pool
      .query(
        `DELETE FROM chunks WHERE entry_id IN (SELECT id FROM entries WHERE source_pointer LIKE 'tagtest-%')`,
      )
      .catch(() => {});
    await pool
      .query(
        `DELETE FROM entries_versions WHERE entry_id IN (SELECT id FROM entries WHERE source_pointer LIKE 'tagtest-%')`,
      )
      .catch(() => {});
    await pool.query(`DELETE FROM entries WHERE source_pointer LIKE 'tagtest-%'`).catch(() => {});
    await pool.end();
  });

  beforeEach(async () => {
    // Tear down rows this suite seeds. The synthetic-fixture seed (M2a #8)
    // uses a stable source_pointer prefix that we're careful not to touch.
    //
    // Order matters: audit_log.entry_id has a FK to entries.id. The
    // ingest_update / ingest rows written by updateEntry carry entry_id
    // pointing to our test entries — those rows must be deleted BEFORE the
    // entries DELETE or the FK constraint blocks it. PR #394 CI caught the
    // earlier teardown only deleting operation-level kind LIKE 'tag\\_%'
    // rows + missing the per-entry ingest_update rows.
    await pool.query(
      `DELETE FROM audit_log WHERE entry_id IN (SELECT id FROM entries WHERE source_pointer LIKE 'tagtest-%')`,
    );
    // Also clean operation-level tag_* rows (no entry_id; not covered by the
    // FK-targeted DELETE above). Belt-and-suspenders for a fresh fixture.
    await pool.query(`DELETE FROM audit_log WHERE kind LIKE 'tag\\_%' ESCAPE '\\'`);
    await pool.query(
      `DELETE FROM chunks WHERE entry_id IN (SELECT id FROM entries WHERE source_pointer LIKE 'tagtest-%')`,
    );
    await pool.query(
      `DELETE FROM entries_versions WHERE entry_id IN (SELECT id FROM entries WHERE source_pointer LIKE 'tagtest-%')`,
    );
    await pool.query(`DELETE FROM entries WHERE source_pointer LIKE 'tagtest-%'`);

    // m5 CR fix: assert teardown actually drained everything. A future merge
    // test that adds rows the teardown misses should fail loudly here rather
    // than leaking FK debt to the next test (debugging this class is much
    // harder when it surfaces three tests later).
    const leakedTagRows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_log WHERE kind LIKE 'tag\\_%' ESCAPE '\\'`,
    );
    expect(leakedTagRows.rows[0].count).toBe("0");
    const leakedEntries = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM entries WHERE source_pointer LIKE 'tagtest-%'`,
    );
    expect(leakedEntries.rows[0].count).toBe("0");
  });

  async function seedEntry(
    suffix: string,
    tags: string[],
    sensitivity: schema.Sensitivity = "public",
  ): Promise<string> {
    const result = await createEntry({
      db,
      embedder,
      input: {
        title: `Tag test ${suffix}`,
        category: "test",
        tags,
        body: `Body of tag-test entry ${suffix} with enough content for a chunk.`,
        source_pointer: `tagtest-${suffix}`,
        last_verified_at: new Date("2026-05-31T00:00:00Z"),
        sensitivity,
      },
      source: { kind: "direct" },
    });
    return result.id;
  }

  describe("renameTag", () => {
    it("renames a tag across all affected entries and writes an audit row", async () => {
      const id1 = await seedEntry("rename-1", ["old-vendor", "priority"]);
      const id2 = await seedEntry("rename-2", ["old-vendor", "support"]);
      await seedEntry("rename-3", ["other"]); // not affected

      const result = await renameTag({ db, embedder, from: "old-vendor", to: "supplier" });

      expect(result.partial_failure).toBe(false);
      expect(result.affected_entry_ids.sort()).toEqual([id1, id2].sort());

      const fresh1 = await pool.query<{ tags: string[] }>(
        `SELECT tags FROM entries WHERE id = $1`,
        [id1],
      );
      expect(fresh1.rows[0].tags.sort()).toEqual(["priority", "supplier"].sort());

      const fresh2 = await pool.query<{ tags: string[] }>(
        `SELECT tags FROM entries WHERE id = $1`,
        [id2],
      );
      expect(fresh2.rows[0].tags.sort()).toEqual(["supplier", "support"].sort());

      // Audit row exists with affected count = 2.
      const audit = await pool.query<{ payload: { affected_entry_count: number } }>(
        `SELECT payload FROM audit_log WHERE id = $1`,
        [result.audit_id],
      );
      expect(audit.rows[0].payload.affected_entry_count).toBe(2);
    });

    it("writes an audit row with empty affected_entry_ids when no entries match (D13)", async () => {
      const result = await renameTag({ db, embedder, from: "nonexistent", to: "whatever" });
      expect(result.affected_entry_ids).toEqual([]);

      const audit = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM audit_log WHERE id = $1`,
        [result.audit_id],
      );
      expect(audit.rows[0].payload.affected_entry_count).toBe(0);
    });

    it("dedupes when `to` already exists on an affected entry", async () => {
      const id = await seedEntry("rename-dedupe", ["old", "new"]);

      const result = await renameTag({ db, embedder, from: "old", to: "new" });
      expect(result.affected_entry_ids).toEqual([id]);

      const fresh = await pool.query<{ tags: string[] }>(`SELECT tags FROM entries WHERE id = $1`, [
        id,
      ]);
      expect(fresh.rows[0].tags).toEqual(["new"]);
    });

    it("appends a new entries_versions row per affected entry (A2 sync semantics)", async () => {
      const id = await seedEntry("rename-version", ["old"]);
      const before = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM entries_versions WHERE entry_id = $1`,
        [id],
      );
      expect(before.rows[0].count).toBe("1");

      await renameTag({ db, embedder, from: "old", to: "fresh" });

      const after = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM entries_versions WHERE entry_id = $1`,
        [id],
      );
      expect(after.rows[0].count).toBe("2");
    });

    it("threads triggered_by_audit_id into each per-entry ingest_update row (A3)", async () => {
      const id = await seedEntry("rename-link", ["old"]);
      const result = await renameTag({ db, embedder, from: "old", to: "new" });

      // The ingest_update row written by updateEntry should carry our audit_id.
      const link = await pool.query<{ triggered_by_audit_id: string }>(
        `SELECT payload->>'triggered_by_audit_id' AS triggered_by_audit_id
         FROM audit_log
         WHERE kind = 'ingest_update' AND entry_id = $1
         ORDER BY occurred_at DESC
         LIMIT 1`,
        [id],
      );
      expect(link.rows[0].triggered_by_audit_id).toBe(result.audit_id);
    });
  });

  describe("deleteTag", () => {
    it("removes the tag from all entries that have it", async () => {
      const id1 = await seedEntry("del-1", ["junk", "keep"]);
      const id2 = await seedEntry("del-2", ["junk"]);

      const result = await deleteTag({ db, embedder, tag: "junk" });

      expect(result.affected_entry_ids.sort()).toEqual([id1, id2].sort());

      const fresh1 = await pool.query<{ tags: string[] }>(
        `SELECT tags FROM entries WHERE id = $1`,
        [id1],
      );
      expect(fresh1.rows[0].tags).toEqual(["keep"]);

      const fresh2 = await pool.query<{ tags: string[] }>(
        `SELECT tags FROM entries WHERE id = $1`,
        [id2],
      );
      expect(fresh2.rows[0].tags).toEqual([]);
    });
  });

  describe("listAdminTagsForRole sensitivity filter (D5)", () => {
    it("admin role sees tags from all sensitivities", async () => {
      await seedEntry("admin-public", ["onlypublic"], "public");
      await seedEntry("admin-restricted", ["onlyrestricted"], "restricted");

      const catalog = await listAdminTagsForRole(pool, "admin");
      const names = catalog.map((c) => c.name);
      expect(names).toContain("onlypublic");
      expect(names).toContain("onlyrestricted");
    });

    it("user role does NOT see tags that exist only on restricted entries", async () => {
      await seedEntry("user-public", ["onlypublic"], "public");
      await seedEntry("user-restricted", ["onlyrestricted"], "restricted");

      const catalog = await listAdminTagsForRole(pool, "user");
      const names = catalog.map((c) => c.name);
      expect(names).toContain("onlypublic");
      expect(names).not.toContain("onlyrestricted");
    });
  });

  describe("mergeTags (PR-B)", () => {
    /**
     * Build a poisoned embedder that throws on the Nth `embed`/`embedBatch`
     * call. Used by the atomic-rollback gate test (ADR-0025 Amendment 2026-06-01
     * §B1).
     *
     * What the gate test proves (M1 CR clarification 2026-06-01): the
     * **load-bearing** assertions are the per-entry tag + entries_versions
     * count checks BEFORE vs AFTER the merge. Under a hypothetical "savepoint-
     * only rollback" implementation, iterations 1 and 2 would commit their
     * savepoints — their tags would change to the merge target AND their
     * entries_versions count would go from 1 to 2. Under the actual outer-tx
     * atomic-or-bust rollback, both stay at the pre-merge snapshot. THAT
     * difference distinguishes the two regimes; the `MergeRollbackError` throw
     * assertion is documentary (drizzle savepoints re-throw on failure either
     * way, so the throw shape alone doesn't pin atomicity). The auxiliary
     * `ingest_update` count + `entries_versions WHERE version_no > 1` count
     * assertions are additional cross-checks on the same property.
     */
    function poisonedEmbedderAt(failOnCall: number): Embedder {
      const stub = createStubEmbedder();
      let callCount = 0;
      return {
        ...stub,
        embed: async (text: string) => {
          callCount += 1;
          if (callCount === failOnCall) {
            throw new Error(`poisoned embedder: throwing on call ${callCount}`);
          }
          return stub.embed(text);
        },
        embedBatch: async (texts: string[]) => {
          callCount += 1;
          if (callCount === failOnCall) {
            throw new Error(`poisoned embedder: throwing on call ${callCount}`);
          }
          return stub.embedBatch(texts);
        },
      };
    }

    it("merges a single source tag into a target across all affected entries", async () => {
      const id1 = await seedEntry("merge-single-1", ["old", "keep"]);
      const id2 = await seedEntry("merge-single-2", ["old"]);
      await seedEntry("merge-single-3", ["unrelated"]);

      const result = await mergeTags({ db, embedder, from: ["old"], to: "fresh" });

      expect(result.partial_failure).toBe(false);
      expect(result.affected_entry_ids.sort()).toEqual([id1, id2].sort());

      const r1 = await pool.query<{ tags: string[] }>(`SELECT tags FROM entries WHERE id = $1`, [
        id1,
      ]);
      expect(r1.rows[0].tags.sort()).toEqual(["fresh", "keep"].sort());

      const r2 = await pool.query<{ tags: string[] }>(`SELECT tags FROM entries WHERE id = $1`, [
        id2,
      ]);
      expect(r2.rows[0].tags).toEqual(["fresh"]);
    });

    it("merges multiple source tags into one target across affected entries", async () => {
      const id1 = await seedEntry("merge-multi-1", ["foo", "bar", "extra"]);
      const id2 = await seedEntry("merge-multi-2", ["baz"]);
      const id3 = await seedEntry("merge-multi-3", ["foo"]);

      const result = await mergeTags({ db, embedder, from: ["foo", "bar", "baz"], to: "merged" });
      expect(result.affected_entry_ids.sort()).toEqual([id1, id2, id3].sort());

      const r1 = await pool.query<{ tags: string[] }>(`SELECT tags FROM entries WHERE id = $1`, [
        id1,
      ]);
      // foo + bar → merged; extra stays; result deduped.
      expect(r1.rows[0].tags.sort()).toEqual(["extra", "merged"].sort());

      const r2 = await pool.query<{ tags: string[] }>(`SELECT tags FROM entries WHERE id = $1`, [
        id2,
      ]);
      expect(r2.rows[0].tags).toEqual(["merged"]);

      const r3 = await pool.query<{ tags: string[] }>(`SELECT tags FROM entries WHERE id = $1`, [
        id3,
      ]);
      expect(r3.rows[0].tags).toEqual(["merged"]);
    });

    it("collision-dedupes when the target tag is already present on an affected entry", async () => {
      // Entry with both "foo" and "bar"; merge foo → bar should produce ["bar"], NOT ["bar", "bar"].
      const id = await seedEntry("merge-collision", ["foo", "bar"]);
      await mergeTags({ db, embedder, from: ["foo"], to: "bar" });

      const r = await pool.query<{ tags: string[] }>(`SELECT tags FROM entries WHERE id = $1`, [
        id,
      ]);
      expect(r.rows[0].tags).toEqual(["bar"]);
    });

    it("ATOMIC-OR-BUST GATE (B1): a mid-loop embedder throw rolls back ALL prior iterations", async () => {
      // Seed 5 entries that all match the candidate set.
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        ids.push(await seedEntry(`atomic-${i}`, ["dontchange"]));
      }
      const sortedIds = [...ids].sort();

      // Snapshot the pre-merge state for every entry: tags + entries_versions count.
      const preState = await pool.query<{
        id: string;
        tags: string[];
        versions: string;
      }>(
        `SELECT e.id, e.tags, (SELECT COUNT(*)::text FROM entries_versions WHERE entry_id = e.id) AS versions
           FROM entries e
           WHERE e.id = ANY($1::uuid[])
           ORDER BY e.id`,
        [sortedIds],
      );
      expect(preState.rows.length).toBe(5);
      for (const row of preState.rows) {
        expect(row.tags).toEqual(["dontchange"]);
        expect(row.versions).toBe("1");
      }

      // Poison the embedder on the 3rd embed call. Each updateEntry inside
      // the merge loop calls embedBatch once per re-chunk; with 5 candidates
      // we expect 5 calls; failing on call 3 means iterations 1 and 2
      // completed their savepoints before iteration 3 throws. The atomic-or-bust
      // contract claims iterations 1 and 2 are then rolled back too.
      const poisoned = poisonedEmbedderAt(3);

      await expect(
        mergeTags({ db, embedder: poisoned, from: ["dontchange"], to: "ifyouseethisDPfailed" }),
      ).rejects.toBeInstanceOf(MergeRollbackError);

      // Post-merge state: every entry MUST be identical to its pre-merge
      // snapshot. If even one entry has its tags changed or a version 2 row,
      // atomic-or-bust is broken and DP1(a) is impossible.
      const postState = await pool.query<{
        id: string;
        tags: string[];
        versions: string;
      }>(
        `SELECT e.id, e.tags, (SELECT COUNT(*)::text FROM entries_versions WHERE entry_id = e.id) AS versions
           FROM entries e
           WHERE e.id = ANY($1::uuid[])
           ORDER BY e.id`,
        [sortedIds],
      );
      expect(postState.rows.length).toBe(5);
      for (const row of postState.rows) {
        // Negative-assertion: distinguishes "atomic-or-bust held" from "savepoint-only rollback".
        // Under savepoint-only rollback, iterations 1+2 would show tags=["ifyouseethisDPfailed"]
        // and versions="2". Under outer-tx rollback they stay ["dontchange"] and versions="1".
        expect(row.tags).toEqual(["dontchange"]);
        expect(row.versions).toBe("1");
      }

      // No NEW entries_versions rows for any of these entries beyond the
      // seed version (additional cross-check on the per-entry count above).
      const newVersions = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM entries_versions
           WHERE entry_id = ANY($1::uuid[]) AND version_no > 1`,
        [sortedIds],
      );
      expect(newVersions.rows[0].count).toBe("0");

      // No ingest_update audit rows for these entries either (per-entry audit
      // is written inside updateEntry; rollback should drop them all).
      const ingestUpdates = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM audit_log
           WHERE kind = 'ingest_update' AND entry_id = ANY($1::uuid[])`,
        [sortedIds],
      );
      expect(ingestUpdates.rows[0].count).toBe("0");
    }, 30_000); // longer timeout; the 5-iteration merge loop can take a few seconds with chunking

    it("MergeRollbackError carries the audit_id captured before the outer tx opened", async () => {
      await seedEntry("rollback-audit-1", ["needsfail"]);
      await seedEntry("rollback-audit-2", ["needsfail"]);

      // Poison on call 2 (mid-loop) to force rollback.
      const poisoned = poisonedEmbedderAt(2);
      let caught: MergeRollbackError | undefined;
      try {
        await mergeTags({ db, embedder: poisoned, from: ["needsfail"], to: "shouldnotapply" });
      } catch (err) {
        if (err instanceof MergeRollbackError) caught = err;
      }
      expect(caught).toBeInstanceOf(MergeRollbackError);
      expect(caught?.audit_id).toBeTruthy();

      // The start audit row should exist with empty affected_entry_ids (the
      // finalize-inside-outer-tx UPDATE never fired because the tx rolled
      // back). The route's MergeRollbackError handler is responsible for
      // setting partial_failure: true; this is verified separately in route tests.
      const audit = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM audit_log WHERE id = $1`,
        [caught?.audit_id],
      );
      expect(audit.rows.length).toBe(1);
      const p = audit.rows[0].payload;
      expect(p.affected_entry_count).toBe(0);
      expect(
        Array.isArray(p.affected_entry_ids) && (p.affected_entry_ids as unknown[]).length,
      ).toBe(0);
    });

    it("threads triggered_by_audit_id into each per-entry ingest_update row", async () => {
      const id = await seedEntry("merge-thread", ["old"]);
      const result = await mergeTags({ db, embedder, from: ["old"], to: "new" });

      const link = await pool.query<{ triggered_by_audit_id: string }>(
        `SELECT payload->>'triggered_by_audit_id' AS triggered_by_audit_id
         FROM audit_log
         WHERE kind = 'ingest_update' AND entry_id = $1
         ORDER BY occurred_at DESC
         LIMIT 1`,
        [id],
      );
      expect(link.rows[0].triggered_by_audit_id).toBe(result.audit_id);
    });

    it("writes an audit row with empty affected_entry_ids when no entries match (D13)", async () => {
      const result = await mergeTags({
        db,
        embedder,
        from: ["nonexistent-tag"],
        to: "alsononexistent",
      });
      expect(result.affected_entry_ids).toEqual([]);

      const audit = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM audit_log WHERE id = $1`,
        [result.audit_id],
      );
      expect(audit.rows[0].payload.affected_entry_count).toBe(0);
    });

    it("appends a new entries_versions row per affected entry on successful merge", async () => {
      const id = await seedEntry("merge-version", ["old"]);
      const before = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM entries_versions WHERE entry_id = $1`,
        [id],
      );
      expect(before.rows[0].count).toBe("1");

      await mergeTags({ db, embedder, from: ["old"], to: "new" });

      const after = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM entries_versions WHERE entry_id = $1`,
        [id],
      );
      expect(after.rows[0].count).toBe("2");
    });
  });

  describe("listRecentTagAuditRows", () => {
    it("returns recent tag_rename + tag_delete + tag_merge rows newest first", async () => {
      // N3 CR clarification 2026-06-01: this test deliberately sequences
      // rename → seed → merge → delete against the same `b` tag to verify
      // that listRecentTagAuditRows picks up all three operation-level
      // discriminators in one assertion. The data flow:
      //   seed audit-1 ["a"] → rename a→b → audit-1 now has ["b"]
      //   seed audit-2 ["c"] → merge ["c"]→b → audit-2 now has ["b"]
      //   delete b → both entries lose b
      // The end state isn't load-bearing for the test; the audit-row
      // discriminator coverage is.
      const id = await seedEntry("audit-1", ["a"]);
      await renameTag({ db, embedder, from: "a", to: "b" });
      await seedEntry("audit-2", ["c"]);
      await mergeTags({ db, embedder, from: ["c"], to: "b" });
      await deleteTag({ db, embedder, tag: "b" });

      const rows = await listRecentTagAuditRows(pool, 10);
      expect(rows.length).toBeGreaterThanOrEqual(3);
      const kinds = rows.map((r) => r.kind);
      expect(kinds).toContain("tag_rename");
      expect(kinds).toContain("tag_merge");
      expect(kinds).toContain("tag_delete");
      // Negative-assertion: entry id used by the seed should not appear as an
      // entry_id on tag_rename / tag_delete / tag_merge (operation-level rows
      // are entry-agnostic).
      const entryIdsOnTagRows = await pool.query<{ entry_id: string | null }>(
        `SELECT entry_id FROM audit_log WHERE kind IN ('tag_rename', 'tag_delete', 'tag_merge')`,
      );
      expect(entryIdsOnTagRows.rows.every((r) => r.entry_id === null)).toBe(true);
      // Negative-assertion to keep the linter happy about id usage:
      expect(id.length).toBeGreaterThan(0);
    });
  });
});
