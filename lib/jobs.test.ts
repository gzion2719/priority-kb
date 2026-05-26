import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { enqueueJob, InvalidJobPayloadError } from "@/lib/jobs";
import { resetLogSink, setLogSink } from "@/lib/log";
import * as schema from "@/drizzle/schema";

// Silence the logEvent sink across this suite; lib/log.test.ts owns assertions
// against the sink's content. Targeted log-capture tests in this file install
// their own sink temporarily.
beforeAll(() => setLogSink(() => undefined));
afterAll(() => resetLogSink());

// Mock-db that records inserts + returns synthetic rows. ADR-0019 §F claim/
// done/failed paths live in api/jobs.py (PR2); this file tests only the Node
// enqueue side.
type InsertOp = { table: string; rows: Record<string, unknown>[]; onConflict: boolean };

type MockOptions = {
  /** Force the INSERT to behave like an idempotency-key conflict (0 rows returned). */
  conflict?: boolean;
  /** State to return from the SELECT-after-conflict. Default: 'queued'. */
  existingState?: schema.JobState;
  /** Pre-assigned id for the inserted/looked-up row. */
  rowId?: string;
};

function makeMockDb(opts: MockOptions = {}) {
  const ops: InsertOp[] = [];
  const conflict = opts.conflict ?? false;
  const existingState = opts.existingState ?? "queued";
  const rowId = opts.rowId ?? "00000000-0000-0000-0000-000000000001";

  function tableName(t: unknown): string {
    if (t === schema.jobs) return "jobs";
    if (t === schema.audit_log) return "audit_log";
    return "unknown";
  }

  const tx = {
    insert(table: unknown) {
      const name = tableName(table);
      return {
        values(vals: Record<string, unknown>) {
          const op: InsertOp = { table: name, rows: [vals], onConflict: false };
          ops.push(op);
          const builder = {
            onConflictDoNothing(_opts: unknown) {
              op.onConflict = true;
              return {
                returning(_cols: unknown) {
                  return Promise.resolve(conflict ? [] : [{ id: rowId }]);
                },
              };
            },
            returning() {
              return Promise.resolve([{ id: rowId }]);
            },
          };
          return builder;
        },
      };
    },
    select(_cols: unknown) {
      return {
        from(table: unknown) {
          const name = tableName(table);
          return {
            where(_pred: unknown) {
              if (name === "jobs") {
                return Promise.resolve([{ id: rowId, state: existingState }]);
              }
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  };

  interface MockDb {
    transaction: <T>(cb: (tx: MockDb) => Promise<T>) => Promise<T>;
    insert: typeof tx.insert;
    select: typeof tx.select;
  }
  const db: MockDb = {
    transaction: <T>(cb: (tx: MockDb) => Promise<T>) => cb(db),
    insert: tx.insert,
    select: tx.select,
  };
  return { db: db as never, ops };
}

describe("enqueueJob — payload validator (iron-rule #6 mechanical floor, ADR-0019 §G)", () => {
  it("accepts a clean envelope payload", async () => {
    const { db } = makeMockDb();
    const result = await enqueueJob(db, {
      queue: "ingest",
      payload: { entry_id: "abc", blob_storage_path: "/blobs/foo.png", content_type: "image/png" },
      idempotencyKey: "k1",
    });
    expect(result.created).toBe(true);
  });

  it("rejects top-level `sensitivity` key", async () => {
    const { db } = makeMockDb();
    await expect(
      enqueueJob(db, {
        queue: "ingest",
        payload: { entry_id: "abc", sensitivity: "restricted" },
        idempotencyKey: "k2",
      }),
    ).rejects.toBeInstanceOf(InvalidJobPayloadError);
  });

  it("rejects nested `meta.sensitivity` (recursive scan — would slip past a top-level-only check)", async () => {
    // Negative-assertion shape (WORKFLOW.md): a top-level-only check would
    // PASS this case, so the test distinguishes recursive-vs-top-level
    // enforcement. If `findSensitivityKey` were rewritten to scan only
    // `Object.keys(payload)`, this assertion would flip green-to-red.
    const { db } = makeMockDb();
    await expect(
      enqueueJob(db, {
        queue: "ingest",
        payload: { entry_id: "abc", meta: { sensitivity: "internal" } },
        idempotencyKey: "k3",
      }),
    ).rejects.toThrow(/sensitivity/i);
  });

  it("rejects `entry_sensitivity` (case-insensitive substring match)", async () => {
    const { db } = makeMockDb();
    await expect(
      enqueueJob(db, {
        queue: "ingest",
        payload: { entry_id: "abc", entry_sensitivity: "public" },
        idempotencyKey: "k4",
      }),
    ).rejects.toBeInstanceOf(InvalidJobPayloadError);
  });

  it("rejects `SENSITIVITY` in an array element", async () => {
    const { db } = makeMockDb();
    await expect(
      enqueueJob(db, {
        queue: "ingest",
        payload: { entry_id: "abc", refs: [{ Sensitivity: "restricted" }] },
        idempotencyKey: "k5",
      }),
    ).rejects.toBeInstanceOf(InvalidJobPayloadError);
  });
});

describe("enqueueJob — return shape (ADR-0019 §E plan-CR M5)", () => {
  it("returns {created:true} on first insert (no existingState field)", async () => {
    const { db } = makeMockDb();
    const result = await enqueueJob(db, {
      queue: "ingest",
      payload: { entry_id: "x" },
      idempotencyKey: "k-create",
    });
    expect(result.created).toBe(true);
    // existingState must NOT appear on the created branch — caller TS narrowing
    // depends on the field's absence to discriminate.
    expect("existingState" in result).toBe(false);
  });

  it("returns {created:false, existingState:'done'} on idempotency-key conflict against a done job", async () => {
    const { db } = makeMockDb({ conflict: true, existingState: "done" });
    const result = await enqueueJob(db, {
      queue: "ingest",
      payload: { entry_id: "x" },
      idempotencyKey: "k-conflict",
    });
    expect(result.created).toBe(false);
    if (result.created === false) {
      expect(result.existingState).toBe("done");
    }
  });

  it("returns {created:false, existingState:'queued'} when prior insert is still pending", async () => {
    const { db } = makeMockDb({ conflict: true, existingState: "queued" });
    const result = await enqueueJob(db, {
      queue: "ingest",
      payload: { entry_id: "x" },
      idempotencyKey: "k-pending",
    });
    expect(result.created).toBe(false);
    if (result.created === false) {
      expect(result.existingState).toBe("queued");
    }
  });
});

describe("enqueueJob — audit_log row (ADR-0019 §D7)", () => {
  it("writes `kind:'job_enqueued'` row on insert", async () => {
    const { db, ops } = makeMockDb();
    await enqueueJob(db, {
      queue: "ingest",
      payload: { entry_id: "abc" },
      idempotencyKey: "k-audit",
    });
    const auditOps = ops.filter((o) => o.table === "audit_log");
    expect(auditOps).toHaveLength(1);
    expect(auditOps[0]!.rows[0]!.kind).toBe("job_enqueued");
    expect(auditOps[0]!.rows[0]!.prompt_hash).toBeNull();
  });

  it("does NOT write an audit row on idempotency-key conflict", async () => {
    const { db, ops } = makeMockDb({ conflict: true });
    await enqueueJob(db, {
      queue: "ingest",
      payload: { entry_id: "abc" },
      idempotencyKey: "k-conflict-no-audit",
    });
    const auditOps = ops.filter((o) => o.table === "audit_log");
    expect(auditOps).toHaveLength(0);
  });
});

describe("enqueueJob — LogEventJob emission (ADR-0019 §D7 + ADR-0005 §H)", () => {
  it("emits `{kind:'job', transition:'enqueued'}` on insert", async () => {
    const lines: string[] = [];
    setLogSink((chunk) => {
      lines.push(chunk);
    });
    try {
      const { db } = makeMockDb({ rowId: "11111111-1111-1111-1111-111111111111" });
      await enqueueJob(db, {
        queue: "ocr",
        payload: { entry_id: "abc" },
        idempotencyKey: "k-log-emit",
      });
    } finally {
      setLogSink(() => undefined);
    }
    const parsed = lines.map((l) => JSON.parse(l));
    const jobEvents = parsed.filter((p) => p.kind === "job");
    expect(jobEvents).toHaveLength(1);
    expect(jobEvents[0].transition).toBe("enqueued");
    expect(jobEvents[0].queue_name).toBe("ocr");
    expect(jobEvents[0].job_id).toBe("11111111-1111-1111-1111-111111111111");
    expect(jobEvents[0].cost_usd).toBeNull();
    expect(typeof jobEvents[0].latency_ms).toBe("number");
    expect(jobEvents[0].latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("does NOT emit LogEventJob on idempotency-key conflict (observability is via {created:false} return)", async () => {
    const lines: string[] = [];
    setLogSink((chunk) => {
      lines.push(chunk);
    });
    try {
      const { db } = makeMockDb({ conflict: true });
      await enqueueJob(db, {
        queue: "ocr",
        payload: { entry_id: "abc" },
        idempotencyKey: "k-conflict-no-log",
      });
    } finally {
      setLogSink(() => undefined);
    }
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.filter((p) => p.kind === "job")).toHaveLength(0);
  });
});
