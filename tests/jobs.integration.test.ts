import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";

import { enqueueJob, InvalidJobPayloadError } from "@/lib/jobs";
import { resetLogSink, setLogSink } from "@/lib/log";
import * as schema from "@/drizzle/schema";

// Integration test: exercises the real Drizzle path + real Postgres
// constraints for ADR-0019 M2b #3. Follows the same skip-locally /
// fail-loud-in-CI pattern as tests/ingest.integration.test.ts.

const databaseUrl = process.env.DATABASE_URL;
const isCi = process.env.CI === "true";

if (isCi && !databaseUrl) {
  throw new Error("DATABASE_URL must be set in CI; jobs integration test cannot silently skip");
}

const describeIfDb = databaseUrl ? describe : describe.skip;

describeIfDb("jobs — integration against Postgres", () => {
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
    // jobs + audit_log only; no entries seeding in this file, so CASCADE
    // touches nothing else. Code-CR n2 (2026-05-26): if a future test
    // adds entries seeding, audit_log's FK to entries(id) ON DELETE
    // restrict means TRUNCATE...CASCADE would need entries listed too.
    await pool.query("TRUNCATE jobs, audit_log CASCADE");
  });

  it("happy path: enqueueJob inserts row + audit row + returns created:true", async () => {
    const result = await enqueueJob(db, {
      queue: "ingest",
      payload: { entry_id: "abc", blob_storage_path: "/blobs/x.png" },
      idempotencyKey: "happy-key-1",
    });
    expect(result.created).toBe(true);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = await db.select().from(schema.jobs).where(eq(schema.jobs.id, result.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.queue_name).toBe("ingest");
    expect(rows[0]!.state).toBe("queued");
    expect(rows[0]!.attempts).toBe(0);
    expect(rows[0]!.max_attempts).toBe(5);
    expect(rows[0]!.locked_until).toBeNull();
    expect(rows[0]!.locked_by).toBeNull();
    expect(rows[0]!.idempotency_key).toBe("happy-key-1");

    const audit = await db
      .select()
      .from(schema.audit_log)
      .where(eq(schema.audit_log.kind, "job_enqueued"));
    expect(audit).toHaveLength(1);
    expect((audit[0]!.payload as { job_id: string }).job_id).toBe(result.id);
    expect(audit[0]!.prompt_hash).toBeNull();
  });

  it("idempotency-key conflict: second enqueue with same key returns {created:false, existingState:'queued'} and writes no second audit row", async () => {
    const first = await enqueueJob(db, {
      queue: "ingest",
      payload: { entry_id: "abc" },
      idempotencyKey: "dup-key",
    });
    expect(first.created).toBe(true);

    const second = await enqueueJob(db, {
      queue: "ingest",
      payload: { entry_id: "different-but-same-key" },
      idempotencyKey: "dup-key",
    });
    expect(second.created).toBe(false);
    if (second.created === false) {
      expect(second.existingState).toBe("queued");
      expect(second.id).toBe(first.id);
    }

    const allJobs = await db.select().from(schema.jobs);
    expect(allJobs).toHaveLength(1);

    const audit = await db
      .select()
      .from(schema.audit_log)
      .where(eq(schema.audit_log.kind, "job_enqueued"));
    expect(audit).toHaveLength(1);
  });

  it("idempotency-key conflict against a 'done' job surfaces existingState:'done' (ADR-0019 §E)", async () => {
    const first = await enqueueJob(db, {
      queue: "ingest",
      payload: { entry_id: "abc" },
      idempotencyKey: "done-key",
    });
    // Simulate a worker transitioning the job to done (PR2 will do this
    // via api/jobs.py; here we do it inline so PR1's contract is
    // exercisable end-to-end without PR2).
    await pool.query(`UPDATE jobs SET state='done', updated_at=now() WHERE id=$1`, [first.id]);
    const second = await enqueueJob(db, {
      queue: "ingest",
      payload: { entry_id: "abc" },
      idempotencyKey: "done-key",
    });
    expect(second.created).toBe(false);
    if (second.created === false) {
      expect(second.existingState).toBe("done");
    }
  });

  it("CHECK constraint: rejects empty idempotency_key", async () => {
    await expect(
      enqueueJob(db, {
        queue: "ingest",
        payload: { entry_id: "abc" },
        idempotencyKey: "",
      }),
    ).rejects.toThrow(/idempotency_key_length/);
  });

  it("CHECK constraint: rejects 201-char idempotency_key but accepts 200-char", async () => {
    // Lower bound (1-char minimum) is implied by the empty-key test above —
    // that case proves the BETWEEN's left side. This test pins the right
    // side at 200/201. Code-CR m6 (2026-05-26).
    // 200 chars — at the boundary, must succeed.
    const okKey = "a".repeat(200);
    const ok = await enqueueJob(db, {
      queue: "ingest",
      payload: { entry_id: "abc" },
      idempotencyKey: okKey,
    });
    expect(ok.created).toBe(true);

    // 201 chars — one over, must fail.
    const tooLong = "a".repeat(201);
    await expect(
      enqueueJob(db, {
        queue: "ingest",
        payload: { entry_id: "abc" },
        idempotencyKey: tooLong,
      }),
    ).rejects.toThrow(/idempotency_key_length/);
  });

  it("Zod recursive sensitivity scan fires before SQL", async () => {
    await expect(
      enqueueJob(db, {
        queue: "ingest",
        payload: { entry_id: "abc", deeply: { nested: { entry_sensitivity: "internal" } } },
        idempotencyKey: "no-sens-key",
      }),
    ).rejects.toBeInstanceOf(InvalidJobPayloadError);
    // No row should have been written.
    const rows = await db.select().from(schema.jobs);
    expect(rows).toHaveLength(0);
  });

  // Code-CR M1 (2026-05-26): dropped the "updated_at advances" test —
  // its UPDATE statement hand-wrote `updated_at=now()`, so the
  // assertion only proved `now()` advances between two SQL statements,
  // not that ADR-0019 §I's "every UPDATE site MUST set updated_at"
  // rule is honored. PR2's mark_done/mark_failed/claim_one integration
  // tests are the right place to enforce §I (the SQL there is the
  // production SQL, not test-local).
  //
  // Code-CR M2 (2026-05-26): dropped the EXPLAIN-uses-jobs_dispatch_idx
  // test — with only 6 rows the planner often picks Seq Scan regardless
  // of partial-index existence, so the assertion was flake-prone AND
  // the pg_indexes predicate-shape test below already proves the index
  // exists with the correct partial predicate, which is the real
  // regression floor.

  it("negative-assertion: partial-index excludes terminal states (done/failed/dead rows NOT in the index)", async () => {
    // The partial-index predicate is `WHERE state IN ('queued','in_progress')`.
    // Postgres exposes this via `pg_indexes.indexdef`. We assert the predicate
    // appears verbatim — if the predicate were widened to include 'done'/etc.,
    // this assertion would flip and the dispatch index would silently bloat.
    const res = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname='jobs_dispatch_idx'`,
    );
    expect(res.rows).toHaveLength(1);
    // Postgres normalizes the predicate; we match against the state enum
    // values being restricted to non-terminal states only.
    expect(res.rows[0]!.indexdef).toMatch(/WHERE \(state = ANY \(ARRAY\['queued'.*'in_progress'\]/);
    expect(res.rows[0]!.indexdef).not.toMatch(/'done'/);
    expect(res.rows[0]!.indexdef).not.toMatch(/'failed'/);
    expect(res.rows[0]!.indexdef).not.toMatch(/'dead'/);
  });
});
