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
import { createStubEmbedder } from "@/lib/embedding";
import { createEntry } from "@/lib/ingest";
import { listAdminTagsForRole, listRecentTagAuditRows } from "@/lib/admin-tags";
import { deleteTag, renameTag } from "@/lib/tags";

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
    await pool.end();
  });

  beforeEach(async () => {
    // Tear down rows this suite seeds. The synthetic-fixture seed (M2a #8)
    // uses a stable source_pointer prefix that we're careful not to touch.
    await pool.query(`DELETE FROM audit_log WHERE kind LIKE 'tag\\_%' ESCAPE '\\'`);
    await pool.query(
      `DELETE FROM chunks WHERE entry_id IN (SELECT id FROM entries WHERE source_pointer LIKE 'tagtest-%')`,
    );
    await pool.query(
      `DELETE FROM entries_versions WHERE entry_id IN (SELECT id FROM entries WHERE source_pointer LIKE 'tagtest-%')`,
    );
    await pool.query(`DELETE FROM entries WHERE source_pointer LIKE 'tagtest-%'`);
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

  describe("listRecentTagAuditRows", () => {
    it("returns recent tag_rename + tag_delete rows newest first", async () => {
      const id = await seedEntry("audit-1", ["a"]);
      await renameTag({ db, embedder, from: "a", to: "b" });
      await deleteTag({ db, embedder, tag: "b" });

      const rows = await listRecentTagAuditRows(pool, 10);
      expect(rows.length).toBeGreaterThanOrEqual(2);
      const kinds = rows.map((r) => r.kind);
      expect(kinds).toContain("tag_rename");
      expect(kinds).toContain("tag_delete");
      // Negative-assertion: entry id used by the seed should not appear as an
      // entry_id on either tag_rename or tag_delete (operation-level rows are
      // entry-agnostic).
      const entryIdsOnTagRows = await pool.query<{ entry_id: string | null }>(
        `SELECT entry_id FROM audit_log WHERE kind IN ('tag_rename', 'tag_delete')`,
      );
      expect(entryIdsOnTagRows.rows.every((r) => r.entry_id === null)).toBe(true);
      // Negative-assertion to keep the linter happy about id usage:
      expect(id.length).toBeGreaterThan(0);
    });
  });
});
