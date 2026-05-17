import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

// Integration test: asserts the baseline migration applied a faithful copy of
// the Drizzle schema. Connects to DATABASE_URL (CI service container).
//
// Local: skipped silently when DATABASE_URL is unset, so `npm test` without
// docker still passes.
// CI: fails loud when DATABASE_URL is missing — `process.env.CI === "true"`
// catches a forgotten env var that would otherwise silently green-light a
// regression.

const databaseUrl = process.env.DATABASE_URL;
const isCi = process.env.CI === "true";

if (isCi && !databaseUrl) {
  throw new Error("DATABASE_URL must be set in CI; the migration test cannot silently skip");
}

const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("baseline migration (0000) + updated_at triggers (0001)", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("created the 4 expected tables", async () => {
    const res = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('entries','entries_versions','chunks','audit_log')
       ORDER BY table_name`,
    );
    expect(res.rows.map((r) => r.table_name)).toEqual([
      "audit_log",
      "chunks",
      "entries",
      "entries_versions",
    ]);
  });

  it("entries has the UNIQUE constraint entries_id_sensitivity_uq on (id, sensitivity)", async () => {
    const res = await pool.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu USING (constraint_schema, constraint_name)
       WHERE tc.constraint_name = 'entries_id_sensitivity_uq'
         AND tc.table_name = 'entries'
         AND tc.constraint_type = 'UNIQUE'
       ORDER BY kcu.ordinal_position`,
    );
    expect(res.rows.map((r) => r.column_name)).toEqual(["id", "sensitivity"]);
  });

  it("chunks has composite FK to entries(id, sensitivity) with ON UPDATE CASCADE + ON DELETE CASCADE", async () => {
    // Use pg_catalog with ordinal-position correlation. information_schema's
    // constraint_column_usage cannot pair the (entry_id → id) and
    // (sensitivity → sensitivity) legs of a composite FK because it joins by
    // column-name equality, not position.
    const res = await pool.query<{
      column_name: string;
      foreign_table_name: string;
      foreign_column_name: string;
      update_action: string;
      delete_action: string;
    }>(
      `SELECT
         a_from.attname AS column_name,
         cl_to.relname  AS foreign_table_name,
         a_to.attname   AS foreign_column_name,
         c.confupdtype  AS update_action,
         c.confdeltype  AS delete_action
       FROM pg_constraint c
       JOIN pg_class cl_from ON cl_from.oid = c.conrelid
       JOIN pg_class cl_to   ON cl_to.oid   = c.confrelid
       JOIN unnest(c.conkey)  WITH ORDINALITY AS k(attnum, ord) ON TRUE
       JOIN unnest(c.confkey) WITH ORDINALITY AS f(attnum, ord) ON f.ord = k.ord
       JOIN pg_attribute a_from ON a_from.attrelid = c.conrelid  AND a_from.attnum = k.attnum
       JOIN pg_attribute a_to   ON a_to.attrelid   = c.confrelid AND a_to.attnum   = f.attnum
       WHERE c.conname = 'chunks_entry_id_sensitivity_fk'
       ORDER BY k.ord`,
    );
    expect(res.rows).toHaveLength(2);
    expect(res.rows.map((r) => r.column_name)).toEqual(["entry_id", "sensitivity"]);
    expect(res.rows.map((r) => r.foreign_table_name)).toEqual(["entries", "entries"]);
    expect(res.rows.map((r) => r.foreign_column_name)).toEqual(["id", "sensitivity"]);
    // pg_constraint encodes confupdtype / confdeltype as a single char; 'c' = CASCADE.
    expect(res.rows[0].update_action).toBe("c");
    expect(res.rows[0].delete_action).toBe("c");
  });

  it("audit_log has CHECK constraint audit_log_prompt_hash_required_for_agent", async () => {
    const res = await pool.query<{ constraint_name: string; check_clause: string }>(
      `SELECT cc.constraint_name, cc.check_clause
       FROM information_schema.check_constraints cc
       JOIN information_schema.table_constraints tc
         ON cc.constraint_name = tc.constraint_name
       WHERE tc.table_name = 'audit_log'
         AND cc.constraint_name = 'audit_log_prompt_hash_required_for_agent'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].check_clause).toMatch(/agent_/);
    expect(res.rows[0].check_clause).toMatch(/prompt_hash/i);
  });

  it("chunks.embedding has an HNSW index", async () => {
    const res = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
       FROM pg_indexes
       WHERE tablename = 'chunks' AND indexname = 'chunks_embedding_hnsw_idx'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].indexdef).toMatch(/USING hnsw/i);
    expect(res.rows[0].indexdef).toMatch(/vector_cosine_ops/);
  });

  it("entries has a BEFORE UPDATE trigger that bumps updated_at", async () => {
    const res = await pool.query<{ trigger_name: string }>(
      `SELECT trigger_name FROM information_schema.triggers
       WHERE event_object_table = 'entries' AND trigger_name = 'entries_set_updated_at'`,
    );
    expect(res.rows).toHaveLength(1);
  });

  it("round-trip: can INSERT into entries + chunks respecting composite FK, then rollback", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const entryId = (
        await client.query<{ id: string }>(
          `INSERT INTO entries (title, category, tags, body, source_pointer, last_verified_at, sensitivity)
           VALUES ('test', 'cat', ARRAY['t1','t2']::text[], 'body text', 'ticket://x', now(), 'internal')
           RETURNING id`,
        )
      ).rows[0].id;

      const fakeVector = `[${Array.from({ length: 1024 }, () => 0).join(",")}]`;
      await client.query(
        `INSERT INTO chunks (entry_id, sensitivity, chunk_index, chunk_total, content_start, content_end, token_count, chunking_policy_version, embedding, embedding_model, embedding_version)
         VALUES ($1, 'internal', 0, 1, 0, 9, 2, 'v1-2026-05-17', $2::vector, 'voyage-3-large', '2026-05')`,
        [entryId, fakeVector],
      );

      // Mismatched sensitivity must be rejected by the composite FK (by name,
      // so a future regression that drops the FK and lets the insert succeed
      // — or that rejects via a different constraint — fails this test loudly).
      await expect(
        client.query(
          `INSERT INTO chunks (entry_id, sensitivity, chunk_index, chunk_total, content_start, content_end, token_count, chunking_policy_version, embedding, embedding_model, embedding_version)
           VALUES ($1, 'public', 0, 1, 0, 9, 2, 'v1-2026-05-17', $2::vector, 'voyage-3-large', '2026-05')`,
          [entryId, fakeVector],
        ),
      ).rejects.toThrow(/chunks_entry_id_sensitivity_fk/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("audit_log CHECK rejects an agent_* row without a prompt_hash", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await expect(
        client.query(`INSERT INTO audit_log (kind, prompt_hash) VALUES ('agent_ingest', NULL)`),
      ).rejects.toThrow(/audit_log_prompt_hash_required_for_agent/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
