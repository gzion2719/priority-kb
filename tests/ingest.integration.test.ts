import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { DrizzleQueryError, eq } from "drizzle-orm";

import { deriveCaption } from "@/lib/caption";
import { createEntry, updateEntry } from "@/lib/ingest";
import { createStubEmbedder } from "@/lib/embedding";
import { INGESTION_AGENT_PROMPT_HASH } from "@/lib/prompts";
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
      source: { kind: "direct" },
    });

    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.version_no).toBe(1);
    expect(result.chunk_count).toBeGreaterThan(1);

    const entries = await db.select().from(schema.entries);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(result.id);
    // ADR-0023: caption persisted, derived from the (single-giant-line)
    // body. Negative-assertion against "column added but never written":
    // it must be non-null and equal the deterministic derivation, not NULL.
    expect(entries[0].caption).not.toBeNull();
    expect(entries[0].caption).toBe(deriveCaption(longBody));
    expect(entries[0].caption!.endsWith("…")).toBe(true);

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

  it("explicit id: createEntry honors a supplied id (deterministic seed for CI eval)", async () => {
    // Negative-assertion: WITHOUT the explicit-id passthrough, the row would
    // get a random gen_random_uuid() id that does NOT equal the one we asked
    // for — which is exactly the failure that would zero CI recall@5. We pin a
    // specific UUID and assert the persisted entry + its cascaded version row
    // both carry THAT id, not a random one.
    const embedder = createStubEmbedder();
    const pinned = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"; // valid v4
    const result = await createEntry({
      db,
      embedder,
      input: {
        title: "explicit-id entry",
        category: "test",
        tags: ["t"],
        body: "Priority workflow step. ".repeat(50).trim(),
        source_pointer: "ticket://explicit-id",
        last_verified_at: new Date("2026-05-28T00:00:00Z"),
        sensitivity: "internal",
      },
      id: pinned,
      source: { kind: "direct" },
    });

    expect(result.id).toBe(pinned);

    const entries = await db.select().from(schema.entries);
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(pinned);

    const versions = await db
      .select()
      .from(schema.entries_versions)
      .where(eq(schema.entries_versions.entry_id, pinned));
    expect(versions).toHaveLength(1);
  });

  it("agent source: writes kind:'agent_ingest' + canonical prompt_hash (CHECK satisfied)", async () => {
    const embedder = createStubEmbedder();
    const result = await createEntry({
      db,
      embedder,
      input: {
        title: "agent ingest happy",
        category: "test",
        tags: [],
        body: "Agent-flow body content.",
        source_pointer: "ticket://agent",
        last_verified_at: new Date("2026-05-18T10:00:00Z"),
        sensitivity: "internal",
      },
      source: { kind: "agent" },
    });
    const audit = await db
      .select()
      .from(schema.audit_log)
      .where(eq(schema.audit_log.entry_id, result.id));
    // Negative-assertion: exact kind-count rules out a bug that writes
    // both 'ingest' AND 'agent_ingest' for the same call.
    const kindCounts = audit.reduce<Record<string, number>>((acc, a) => {
      acc[a.kind] = (acc[a.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(kindCounts).toEqual({ agent_ingest: 1 });
    expect(audit[0].kind).toBe("agent_ingest");
    // The CHECK `audit_log_prompt_hash_required_for_agent` fires for any
    // `kind LIKE 'agent_%'` row with a NULL prompt_hash. The row landing
    // at all proves the constraint did NOT reject this insert; equality
    // against the imported constant proves the row carries the canonical
    // hash sourced from `lib/prompts`, not some caller-supplied value.
    expect(audit[0].prompt_hash).toBe(INGESTION_AGENT_PROMPT_HASH);
    const payload = audit[0].payload as { source: string };
    expect(payload.source).toBe("agent");
  });

  it("CHECK rejects raw INSERT of kind:'agent_ingest' with NULL prompt_hash (negative-assertion)", async () => {
    // Negative-assertion per WORKFLOW.md: this insert would SUCCEED in a
    // world where the CHECK constraint were dropped. The error message
    // must NAME the specific CHECK so the test distinguishes "this
    // particular constraint rejected the row" from "any constraint
    // happened to fire by coincidence". Constraint name verified in
    // drizzle/migrations/0000_baseline.sql.
    await expect(
      pool.query(`INSERT INTO audit_log (kind, prompt_hash) VALUES ('agent_ingest', NULL)`),
    ).rejects.toThrow(/audit_log_prompt_hash_required_for_agent/);
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
      source: { kind: "direct" },
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
    // mockImplementation (not …Once) — every embedBatch call within this
    // test gets the broken vectors. Sibling-test pattern uses long bodies
    // that produce exactly one chunk today, but if a future refactor adds
    // a probe call the …Once flavor would silently burn the broken impl
    // on the probe and pass real-stub vectors to the actual chunks
    // INSERT, hiding the rollback path. Defended below by asserting
    // toHaveBeenCalledTimes(1).
    const embedSpy = vi.spyOn(embedder, "embedBatch").mockImplementation(async (texts) => ({
      vectors: texts.map(() => new Array(512).fill(0)), // wrong dimension (need 1024)
      model: embedder.model,
      version: embedder.version,
      tokens_used: 0,
    }));

    // Long body matching the sibling pattern in lib/ingest.test.ts L241,
    // L401 — produces ≥1 chunk under any plausible chunker tuning. A
    // tiny body that produced zero chunks would skip the chunks INSERT
    // entirely (lib/ingest.ts gates on slices.length > 0), the tx would
    // COMMIT successfully, and the rollback assertion below would flip
    // to failure — but with a misleading "entries.length === 1" signal
    // that points away from the actual cause (no chunks to insert, not
    // rollback broken). Constructing the failure case deliberately, per
    // WORKFLOW.md "Negative-assertion tests distinguish from the
    // regression."
    const longBody = "Priority workflow step. ".repeat(400);

    // Sentinel survives only when createEntry unexpectedly RESOLVES — in
    // that world the subsequent toBeInstanceOf assertion fails loudly
    // with "expected 'createEntry resolved unexpectedly' to be instance
    // of DrizzleQueryError", which is a clearer pointer to the actual
    // breakage than a generic resolved-value mismatch. drizzle-orm 0.44+
    // wraps driver errors raised inside the QueryBuilder's execute path
    // in DrizzleQueryError(query, params, cause) — the original pgvector
    // dimension-mismatch error is on `.cause`, not on `.message`.
    let captured: unknown = "createEntry resolved unexpectedly";
    try {
      await createEntry({
        db,
        embedder,
        input: {
          title: "rollback test",
          category: "test",
          tags: [],
          body: longBody,
          source_pointer: "ticket://rollback",
          last_verified_at: new Date("2026-05-18T10:00:00Z"),
          sensitivity: "internal",
        },
        source: { kind: "direct" },
      });
    } catch (e) {
      captured = e;
    }

    // Wrapper-class assertion distinguishes "Drizzle's tx wrapper fired
    // on the chunks INSERT" from "function threw before the tx opened"
    // (a hypothetical client-side pre-validation that would fail before
    // any INSERT runs — in that world rollback wouldn't be tested).
    // Anchoring on the class instead of the wrapper's message string
    // keeps the test stable across future Drizzle patch/minor bumps that
    // may reword `Failed query: …`.
    expect(captured).toBeInstanceOf(DrizzleQueryError);
    // Type-narrowing guard: ensures the next `.cause` access compiles
    // under TS strict mode AND fails loudly if a future refactor weakens
    // the assertion above (e.g. someone replaces toBeInstanceOf with
    // toBeTruthy and the cast silently becomes a footgun).
    if (!(captured instanceof DrizzleQueryError)) {
      throw new Error(`expected DrizzleQueryError, got: ${String(captured)}`);
    }

    // .cause carries the pgvector dimension-mismatch error from the
    // server. Asserting instanceof Error before .message both narrows
    // for TS and ensures the cause-chain wiring isn't silently dropped
    // in a future Drizzle release.
    expect(captured.cause).toBeInstanceOf(Error);

    // Tight regex on the wrapped cause distinguishes the intended
    // failure (pgvector dimension rejection — "expected 1024 dimensions,
    // not 512" from pgvector's ereport) from any other constraint that
    // could fire inside the chunks INSERT (a future CHECK or NOT NULL).
    // The /dimension/ branch matches pgvector's wording; /expected 1024/
    // is the precision fallback if the wording changes. Dropped the
    // earlier /vector/ alternation as too broad.
    expect((captured.cause as Error).message).toMatch(/dimension|expected 1024/i);

    // Pins the single-batch contract of deriveChunksAndEmbeddings — if a
    // future refactor splits into multiple embedBatch calls, this fires
    // and B1's rationale (sibling above) gets re-evaluated.
    expect(embedSpy).toHaveBeenCalledTimes(1);

    // Negative-assertion: if transaction.rollback weren't invoked on the
    // chunks-insert throw, the entries row from the earlier statement
    // would have been COMMITted and entries.length would be 1. Asserting
    // 0 on BOTH entries and entries_versions distinguishes "tx rolls
    // back on failure" from "we only rolled back chunks/versions but
    // kept entries via some misconfigured savepoint".
    const entries = await db.select().from(schema.entries);
    expect(entries).toHaveLength(0);
    const versions = await db.select().from(schema.entries_versions);
    expect(versions).toHaveLength(0);
  });
});

describeIfDb("updateEntry — integration against Postgres", () => {
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("TRUNCATE audit_log, chunks, entries_versions, entries CASCADE");
  });

  async function seed(sensitivity: "public" | "internal" | "restricted" = "internal") {
    const embedder = createStubEmbedder();
    return createEntry({
      db,
      embedder,
      input: {
        title: "seed",
        category: "test",
        tags: ["seed"],
        body: "Initial body content for the update path integration test.",
        source_pointer: "ticket://seed",
        last_verified_at: new Date("2026-05-18T10:00:00Z"),
        sensitivity,
      },
      source: { kind: "direct" },
    });
  }

  it("create → update twice → version_no progresses 1 → 2 → 3 and chunks are re-derived", async () => {
    const { id } = await seed();
    const embedder = createStubEmbedder();

    const r1 = await updateEntry({
      db,
      embedder,
      id,
      input: {
        title: "after first update",
        category: "test",
        tags: ["t1"],
        body: "Different body content for first update.",
        source_pointer: "ticket://seed",
        last_verified_at: new Date("2026-05-18T11:00:00Z"),
        sensitivity: "internal",
      },
      source: { kind: "direct" },
    });
    expect(r1.version_no).toBe(2);

    const r2 = await updateEntry({
      db,
      embedder,
      id,
      input: {
        title: "after second update",
        category: "test",
        tags: ["t2"],
        body: "Yet another different body content for second update.",
        source_pointer: "ticket://seed",
        last_verified_at: new Date("2026-05-18T12:00:00Z"),
        sensitivity: "internal",
      },
      source: { kind: "direct" },
    });
    expect(r2.version_no).toBe(3);

    const versions = await db
      .select()
      .from(schema.entries_versions)
      .where(eq(schema.entries_versions.entry_id, id));
    expect(versions.map((v) => v.version_no).sort()).toEqual([1, 2, 3]);

    // Audit log: exactly 3 rows for this entry — 1 'ingest' (the seed)
    // and 2 'ingest_update' rows with payload version_no 2 and 3.
    const audits = await db
      .select()
      .from(schema.audit_log)
      .where(eq(schema.audit_log.entry_id, id));
    expect(audits).toHaveLength(3);
    const kindCounts = audits.reduce<Record<string, number>>((acc, a) => {
      acc[a.kind] = (acc[a.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(kindCounts).toEqual({ ingest: 1, ingest_update: 2 });
    const updatePayloads = audits
      .filter((a) => a.kind === "ingest_update")
      .map((a) => (a.payload as { version_no: number }).version_no)
      .sort();
    // Negative-assertion: a hardcoded version_no=2 in updateEntry would
    // produce [2, 2]; asserting on [2, 3] distinguishes the MAX+1 path.
    expect(updatePayloads).toEqual([2, 3]);

    // Negative-assertion: chunks for the prior version must be gone.
    // If DELETE chunks WHERE entry_id were skipped, this count would be
    // > 1 (stale rows from version 1 + 2 would remain alongside v3).
    const chunks = await db.select().from(schema.chunks).where(eq(schema.chunks.entry_id, id));
    expect(chunks.length).toBeGreaterThan(0);
    // Every remaining chunk row's content must come from the *current*
    // entries.body — assert by checking content_end ≤ new body length.
    const [entryRow] = await db.select().from(schema.entries).where(eq(schema.entries.id, id));
    for (const c of chunks) {
      expect(c.content_end).toBeLessThanOrEqual(entryRow.body.length);
    }
    // ADR-0023: caption is RE-derived from the new body on update.
    // Negative-assertion: if updateEntry didn't set caption, this would
    // still be the seed's first line ("Initial body content..."), not the
    // second update's body. The final body is a single short line, so the
    // caption equals it verbatim (no clip/ellipsis).
    expect(entryRow.caption).toBe("Yet another different body content for second update.");
  });

  it("agent source: update writes kind:'agent_ingest_update' + canonical prompt_hash", async () => {
    const { id } = await seed();
    const embedder = createStubEmbedder();
    await updateEntry({
      db,
      embedder,
      id,
      input: {
        title: "agent update",
        category: "test",
        tags: [],
        body: "Agent-flow updated body content.",
        source_pointer: "ticket://agent-update",
        last_verified_at: new Date("2026-05-18T11:00:00Z"),
        sensitivity: "internal",
      },
      source: { kind: "agent" },
    });
    const audits = await db
      .select()
      .from(schema.audit_log)
      .where(eq(schema.audit_log.entry_id, id));
    // Negative-assertion: a bug that wrote both 'ingest_update' AND
    // 'agent_ingest_update' for the same call would pass a `.find()`
    // check but corrupt the audit trail. Asserting exact kind counts
    // distinguishes "single agent_ingest_update written" from "agent
    // path silently double-writes". Mirror of the direct-path test's
    // `kindCounts` discipline above.
    const kindCounts = audits.reduce<Record<string, number>>((acc, a) => {
      acc[a.kind] = (acc[a.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(kindCounts).toEqual({ ingest: 1, agent_ingest_update: 1 });
    const agentRow = audits.find((a) => a.kind === "agent_ingest_update")!;
    expect(agentRow.prompt_hash).toBe(INGESTION_AGENT_PROMPT_HASH);
    expect((agentRow.payload as { source: string }).source).toBe("agent");
  });

  it("update with sensitivity change: chunks land with NEW sensitivity (composite-FK satisfied)", async () => {
    const { id } = await seed("public");
    const embedder = createStubEmbedder();
    await updateEntry({
      db,
      embedder,
      id,
      input: {
        title: "sensitivity bumped",
        category: "test",
        tags: [],
        body: "Body content under restricted sensitivity now.",
        source_pointer: "ticket://seed",
        last_verified_at: new Date("2026-05-18T11:00:00Z"),
        sensitivity: "restricted",
      },
      source: { kind: "direct" },
    });
    const chunks = await db.select().from(schema.chunks).where(eq(schema.chunks.entry_id, id));
    expect(chunks.length).toBeGreaterThan(0);
    // Negative-assertion: if the new chunks were inserted with the OLD
    // sensitivity ("public"), the composite-FK would fail because
    // entries.sensitivity is now "restricted" and the (entry_id,
    // "public") tuple no longer exists on entries. The fact that the
    // insert succeeded AND the rows carry "restricted" together
    // distinguish "sensitivity propagated correctly" from "stale value".
    for (const c of chunks) {
      expect(c.sensitivity).toBe("restricted");
    }
  });

  it("updated_at trigger bumps the timestamp on UPDATE entries (negative-assertion)", async () => {
    const { id } = await seed();
    const [before] = await db.select().from(schema.entries).where(eq(schema.entries.id, id));

    // Sleep 50ms so the trigger's `now()` lands a measurably later value.
    await new Promise((r) => setTimeout(r, 50));

    const embedder = createStubEmbedder();
    await updateEntry({
      db,
      embedder,
      id,
      input: {
        title: "trigger test",
        category: "test",
        tags: [],
        body: "Body content for trigger test.",
        source_pointer: "ticket://seed",
        last_verified_at: new Date("2026-05-18T11:00:00Z"),
        sensitivity: "internal",
      },
      source: { kind: "direct" },
    });

    const [after] = await db.select().from(schema.entries).where(eq(schema.entries.id, id));
    // Negative-assertion: if migration 0001's BEFORE UPDATE trigger were
    // dropped, updated_at would remain equal to created_at. Asserting
    // strict-greater distinguishes "trigger fired" from "row was
    // updated but updated_at column was not touched".
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
  });

  it("SELECT FOR UPDATE serializes concurrent updaters (real two-connection lock-contention)", async () => {
    const { id } = await seed();

    // Acquire two independent connections from the pool. Drizzle's
    // db.transaction would serialize them on a single connection; we want
    // real concurrent contention, so we drive Postgres directly with raw
    // pg clients.
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    let c1InTx = false;
    let c2InTx = false;
    try {
      await c1.query("BEGIN");
      c1InTx = true;
      await c1.query("SELECT id FROM entries WHERE id = $1 FOR UPDATE", [id]);

      // tx2 attempts the same lock. Should block until c1 commits.
      await c2.query("BEGIN");
      c2InTx = true;
      const c2Lock = c2.query("SELECT id FROM entries WHERE id = $1 FOR UPDATE", [id]);

      // Negative-assertion: if FOR UPDATE were dropped, c2Lock would
      // resolve immediately and the race below would have a 50/50 outcome.
      // Asserting that c2 is STILL pending after 500ms distinguishes
      // "lock held" from "no locking". 500ms gives slow CI runners
      // breathing room without making a passing test slow.
      const raceResult = await Promise.race([
        c2Lock.then(() => "c2-resolved"),
        new Promise((r) => setTimeout(() => r("still-blocked"), 500)),
      ]);
      expect(raceResult).toBe("still-blocked");

      // Release c1, then c2 should resolve.
      await c1.query("COMMIT");
      c1InTx = false;
      await c2Lock;
      await c2.query("COMMIT");
      c2InTx = false;
    } finally {
      // Best-effort ROLLBACK if any tx is still open (e.g. expect failed
      // mid-test). Without this, releasing a client with an open BEGIN
      // returns a poisoned connection to the pool — the next test that
      // checks it out will see WARNING / unexpected state.
      if (c1InTx) await c1.query("ROLLBACK").catch(() => undefined);
      if (c2InTx) await c2.query("ROLLBACK").catch(() => undefined);
      c1.release();
      c2.release();
    }
  });
});
