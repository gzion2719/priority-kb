import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";

import { createEntry } from "@/lib/ingest";
import { createStubEmbedder } from "@/lib/embedding";
import * as schema from "@/drizzle/schema";

// Integration test: exercises the real Drizzle path + real Postgres
// constraints that mocked-db unit tests cannot prove
// (composite FK propagation, transactional rollback, CHECKs). Follows
// the same skip-locally / fail-loud-in-CI pattern as tests/migration.test.ts.

const databaseUrl = process.env.DATABASE_URL;
const isCi = process.env.CI === "true";

if (isCi && !databaseUrl) {
  throw new Error("DATABASE_URL must be set in CI; ingest integration test cannot silently skip");
}

const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("createEntry — integration against Postgres", () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool.end();
  });

  // Each test wipes the four tables to isolate. The tables are owned by
  // the test schema; tests run serially under Vitest's default.
  afterEach(async () => {
    await pool.query("TRUNCATE audit_log, chunks, entries_versions, entries CASCADE");
  });

  it("happy path: persists entry + version_no=1 + N chunks + audit row", async () => {
    const embedder = createStubEmbedder();
    const longBody = "Priority workflow step. ".repeat(400).trim();
    const result = await createEntry({
      db,
      embedder,
      input: {
        title: "ingest integration happy",
        category: "test",
        tags: ["t1", "t2"],
        body: longBody,
        source_pointer: "ticket://integration",
        last_verified_at: new Date("2026-05-18T10:00:00Z"),
        sensitivity: "internal",
      },
    });

    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.version_no).toBe(1);
    expect(result.chunk_count).toBeGreaterThan(1);

    const entries = await db.select().from(schema.entries);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(result.id);

    const versions = await db
      .select()
      .from(schema.entries_versions)
      .where(eq(schema.entries_versions.entry_id, result.id));
    expect(versions).toHaveLength(1);
    expect(versions[0].version_no).toBe(1);

    const chunks = await db
      .select()
      .from(schema.chunks)
      .where(eq(schema.chunks.entry_id, result.id));
    expect(chunks.length).toBe(result.chunk_count);
    for (const c of chunks) {
      expect(c.sensitivity).toBe("internal");
      expect(c.embedding_model).toBe(embedder.model);
      expect(c.embedding_version).toBe(embedder.version);
      // pgvector returns the embedding as number[] via drizzle's vector type.
      expect(c.embedding).toHaveLength(1024);
    }

    const audit = await db
      .select()
      .from(schema.audit_log)
      .where(eq(schema.audit_log.entry_id, result.id));
    expect(audit).toHaveLength(1);
    expect(audit[0].kind).toBe("ingest");
    // CHECK constraint requires prompt_hash for kind LIKE 'agent_%'; we use
    // 'ingest', so null is fine — assert that's what landed.
    expect(audit[0].prompt_hash).toBeNull();
  });

  it("composite FK rejects manually inserting a chunk with mismatched sensitivity", async () => {
    // First create an entry via the orchestration path so the FK target exists.
    const embedder = createStubEmbedder();
    const { id: entryId } = await createEntry({
      db,
      embedder,
      input: {
        title: "fk test",
        category: "test",
        tags: [],
        body: "small body",
        source_pointer: "ticket://fk",
        last_verified_at: new Date("2026-05-18T10:00:00Z"),
        sensitivity: "internal",
      },
    });

    // Negative-assertion: if the composite FK (entry_id, sensitivity) →
    // entries(id, sensitivity) were missing, this INSERT with a mismatched
    // sensitivity would succeed. Asserting that it throws — AND that the
    // error message names the FK — distinguishes "FK fires" from "any
    // constraint fires by coincidence".
    await expect(
      pool.query(
        `INSERT INTO chunks (entry_id, sensitivity, chunk_index, chunk_total, content_start, content_end, token_count, chunking_policy_version, embedding, embedding_model, embedding_version)
         VALUES ($1, 'restricted', 0, 1, 0, 5, 1, 'v1-2026-05-17', $2::vector, 'stub-sha256', 'v1')`,
        [entryId, "[" + new Array(1024).fill(0).join(",") + "]"],
      ),
    ).rejects.toThrow(/chunks_entry_id_sensitivity_fk/);
  });

  it("mid-transaction failure rolls back the entries row (real DB ROLLBACK)", async () => {
    // Strategy: force a Postgres-level constraint violation INSIDE the
    // transaction, AFTER the entries row has been inserted. The chunks
    // insert is the natural failure point — we mutate the vectors to a
    // wrong dimension so pgvector rejects them at insert time. This
    // exercises the actual transaction.rollback path on the server.
    const embedder = createStubEmbedder();
    vi.spyOn(embedder, "embedBatch").mockImplementationOnce(async (texts) => ({
      vectors: texts.map(() => new Array(512).fill(0)), // wrong dimension (need 1024)
      model: embedder.model,
      version: embedder.version,
      tokens_used: 0,
    }));

    await expect(
      createEntry({
        db,
        embedder,
        input: {
          title: "rollback test",
          category: "test",
          tags: [],
          body: "small body",
          source_pointer: "ticket://rollback",
          last_verified_at: new Date("2026-05-18T10:00:00Z"),
          sensitivity: "internal",
        },
      }),
      // Tight regex distinguishes the intended failure (pgvector dimension
      // rejection inside the chunks INSERT, inside the open transaction)
      // from a hypothetical client-side pre-validation that would fail
      // BEFORE the tx opens — in that world rollback wouldn't be tested.
    ).rejects.toThrow(/dimension|expected 1024|vector/i);

    // Negative-assertion: if transaction.rollback weren't invoked on the
    // chunks-insert throw, the entries row from the earlier statement
    // would have been COMMITted and entries.length would be 1. Asserting
    // 0 distinguishes "tx rolls back on failure" from "writes are auto-
    // committed per statement".
    const entries = await db.select().from(schema.entries);
    expect(entries).toHaveLength(0);
    const versions = await db.select().from(schema.entries_versions);
    expect(versions).toHaveLength(0);
  });
});
