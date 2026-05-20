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

  // ─── ADR-0013 migrations 0002 + 0003: tsv column + trigger + GIN ───────────

  it("entries.tsv exists as a NOT NULL tsvector column with default ''::tsvector", async () => {
    const res = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = 'entries' AND column_name = 'tsv'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].data_type).toBe("tsvector");
    expect(res.rows[0].is_nullable).toBe("NO");
    expect(res.rows[0].column_default).toMatch(/tsvector/);
  });

  it("entries.tsv has a GIN index entries_tsv_gin_idx", async () => {
    const res = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'entries' AND indexname = 'entries_tsv_gin_idx'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].indexdef).toMatch(/USING gin/i);
    expect(res.rows[0].indexdef).toMatch(/\btsv\b/);
  });

  it("entries_tsv_refresh_trigger is BEFORE INSERT OR UPDATE OF (title, tags, body) only", async () => {
    const res = await pool.query<{ event_manipulation: string; action_timing: string }>(
      `SELECT event_manipulation, action_timing
       FROM information_schema.triggers
       WHERE event_object_table = 'entries'
         AND trigger_name = 'entries_tsv_refresh_trigger'
       ORDER BY event_manipulation`,
    );
    // Two rows: INSERT + UPDATE (column-scoped UPDATE shows up once in this view).
    const ops = res.rows.map((r) => `${r.action_timing}/${r.event_manipulation}`);
    expect(ops).toContain("BEFORE/INSERT");
    expect(ops).toContain("BEFORE/UPDATE");
  });

  it("trigger populates tsv on INSERT with the expected lexemes (negative-assertion: not empty)", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ tsv: string }>(
        `INSERT INTO entries (title, category, tags, body, source_pointer, last_verified_at, sensitivity)
         VALUES ('Invoice workflow', 'cat', ARRAY['inv','billing']::text[], 'invoice approval body text',
                 'src://x', now(), 'public')
         RETURNING tsv::text`,
      );
      expect(rows).toHaveLength(1);
      // Without the trigger, tsv would be the DEFAULT ''::tsvector → empty string.
      expect(rows[0].tsv).not.toBe("");
      // Specific lexemes from title/tags/body must be present (proves all three
      // sources feed the trigger — single-source bugs would pass a "not empty"
      // check but fail this).
      expect(rows[0].tsv).toMatch(/'invoice'/);
      expect(rows[0].tsv).toMatch(/'workflow'/);
      expect(rows[0].tsv).toMatch(/'billing'/);
      expect(rows[0].tsv).toMatch(/'approval'/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("UPDATE of last_verified_at does NOT invoke entries_tsv_refresh; UPDATE of title DOES (EXPLAIN ANALYZE Triggers)", async () => {
    // The byte-identical-tsv assertion alone is tautological: under a
    // hypothetical "BEFORE UPDATE" (no column list) trigger, the refresh
    // function would still re-fire and re-compute the same tsv (the function
    // is deterministic on title/tags/body), producing identical bytes. To
    // truly distinguish "trigger did not fire" from "trigger fired and
    // recomputed identically", we ask Postgres directly: EXPLAIN ANALYZE's
    // JSON output lists which triggers executed under "Triggers".
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: inserted } = await client.query<{ id: string }>(
        `INSERT INTO entries (title, category, tags, body, source_pointer, last_verified_at, sensitivity)
         VALUES ('Original title', 'cat', '{}'::text[], 'original body',
                 'src://x', now(), 'public')
         RETURNING id`,
      );
      const id = inserted[0].id;

      type TriggerEntry = { "Trigger Name": string };
      type PlanRoot = { Triggers?: TriggerEntry[] };

      // Update an unrelated column → refresh trigger MUST NOT appear in Triggers.
      const lvaPlan = await client.query<{ "QUERY PLAN": PlanRoot[] }>(
        `EXPLAIN (ANALYZE, FORMAT JSON) UPDATE entries SET last_verified_at = now() + interval '1 day' WHERE id = $1`,
        [id],
      );
      const lvaTriggers = lvaPlan.rows[0]["QUERY PLAN"][0]?.Triggers ?? [];
      const lvaNames = lvaTriggers.map((t) => t["Trigger Name"]);
      expect(lvaNames).not.toContain("entries_tsv_refresh_trigger");

      // Update title → refresh trigger MUST appear.
      const titlePlan = await client.query<{ "QUERY PLAN": PlanRoot[] }>(
        `EXPLAIN (ANALYZE, FORMAT JSON) UPDATE entries SET title = 'Completely different title' WHERE id = $1`,
        [id],
      );
      const titleTriggers = titlePlan.rows[0]["QUERY PLAN"][0]?.Triggers ?? [];
      const titleNames = titleTriggers.map((t) => t["Trigger Name"]);
      expect(titleNames).toContain("entries_tsv_refresh_trigger");

      // Sanity: tsv content reflects the new title.
      const after = await client.query<{ tsv: string }>(
        `SELECT tsv::text AS tsv FROM entries WHERE id = $1`,
        [id],
      );
      expect(after.rows[0].tsv).toMatch(/'differ/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("direct UPDATE of tsv is rejected by entries_tsv_no_direct_write guard trigger", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO entries (title, category, tags, body, source_pointer, last_verified_at, sensitivity)
         VALUES ('Guarded', 'cat', '{}'::text[], 'body', 'src://x', now(), 'public')
         RETURNING id`,
      );
      const id = rows[0].id;
      await expect(
        client.query(`UPDATE entries SET tsv = ''::tsvector WHERE id = $1`, [id]),
      ).rejects.toThrow(/direct UPDATE of entries\.tsv is forbidden/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("unaccent collapses Hebrew niqqud at index time", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ tsv: string }>(
        `INSERT INTO entries (title, category, tags, body, source_pointer, last_verified_at, sensitivity)
         VALUES ('שָׁלוֹם', 'cat', '{}'::text[], '', 'src://x', now(), 'public')
         RETURNING tsv::text`,
      );
      // Niqqud (combining marks) stripped → 'שלום' is the indexed lexeme.
      expect(rows[0].tsv).toMatch(/'שלום'/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("unaccent collapses Latin diacritics at index time", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ tsv: string }>(
        `INSERT INTO entries (title, category, tags, body, source_pointer, last_verified_at, sensitivity)
         VALUES ('Café notes', 'cat', '{}'::text[], '', 'src://x', now(), 'public')
         RETURNING tsv::text`,
      );
      expect(rows[0].tsv).toMatch(/'cafe'/);
      expect(rows[0].tsv).not.toMatch(/'café'/);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
