import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildEmbedInput, chunk } from "@/lib/chunk";
import { createStubEmbedder } from "@/lib/embedding";
import {
  createEntry,
  EmptyBodyAfterScrubError,
  EntryNotFoundError,
  submitEntryFromAgent,
  updateEntry,
  updateEntryFromAgent,
  type IngestInput,
} from "@/lib/ingest";
import { resetLogSink, setLogSink } from "@/lib/log";
import { INGESTION_AGENT_PROMPT_HASH } from "@/lib/prompts";
import { scrubPii } from "@/lib/scrub";
import * as schema from "@/drizzle/schema";

// Silence the logEvent NDJSON sink during this suite — every createEntry
// success writes a {kind:"voyage"} line which would otherwise spam stdout
// under `npm test`. Restored in afterAll. lib/log.test.ts owns the assertions
// against the sink's content.
beforeAll(() => setLogSink(() => undefined));
afterAll(() => resetLogSink());

// We DO NOT spin up Postgres here. These tests cover orchestration-level
// invariants: ordering (scrub → NFC → chunk → embed), vector alignment,
// sensitivity propagation, single-batch embedder call, transaction usage.
// Real-FK / CHECK / rollback semantics are exercised in
// tests/ingest.integration.test.ts against the CI Postgres service.

type Op =
  | { kind: "insert"; table: string; rows: unknown[] }
  | { kind: "update"; table: string; values: unknown }
  | { kind: "delete"; table: string }
  | { kind: "select"; table: string; forUpdate: boolean };

type MockOptions = {
  /** Rows the SELECT FOR UPDATE on entries returns. Default: [{id: 'X'}]. */
  entriesLookup?: Array<{ id: string }>;
  /** Existing MAX(version_no); next insert will use this + 1. Default: 1. */
  maxVersionNo?: number;
};

function makeMockDb(opts: MockOptions = {}) {
  const ops: Op[] = [];
  let txOpened = 0;
  let entryIdCounter = 0;
  const entriesLookup = opts.entriesLookup ?? [{ id: "existing-entry-id" }];
  const maxVersionNo = opts.maxVersionNo ?? 1;

  function tableName(t: unknown): string {
    if (t === schema.entries) return "entries";
    if (t === schema.entries_versions) return "entries_versions";
    if (t === schema.chunks) return "chunks";
    if (t === schema.audit_log) return "audit_log";
    return "unknown";
  }

  const tx = {
    insert(table: unknown) {
      const name = tableName(table);
      return {
        values(vals: unknown) {
          const rows = Array.isArray(vals) ? vals : [vals];
          ops.push({ kind: "insert", table: name, rows });
          const synthIds = rows.map(() => ({ id: `entry-${++entryIdCounter}` }));
          const promise = Promise.resolve(synthIds);
          return Object.assign(promise, {
            returning: () => Promise.resolve(synthIds),
          });
        },
      };
    },
    select(cols?: unknown) {
      return {
        from(table: unknown) {
          const name = tableName(table);
          // Sniff the column shape — { max: sql<...> } means MAX-aggregate query.
          const isMaxQuery =
            cols !== undefined && typeof cols === "object" && cols !== null && "max" in cols;
          return {
            where(_w: unknown) {
              const promise: Promise<unknown[]> = isMaxQuery
                ? Promise.resolve([{ max: maxVersionNo }])
                : Promise.resolve(name === "entries" ? entriesLookup : []);
              return Object.assign(promise, {
                for(_mode: string) {
                  ops.push({ kind: "select", table: name, forUpdate: true });
                  return Promise.resolve(entriesLookup);
                },
              });
            },
          };
        },
      };
    },
    update(table: unknown) {
      const name = tableName(table);
      return {
        set(values: unknown) {
          return {
            where(_w: unknown) {
              ops.push({ kind: "update", table: name, values });
              return Promise.resolve();
            },
          };
        },
      };
    },
    delete(table: unknown) {
      const name = tableName(table);
      return {
        where(_w: unknown) {
          ops.push({ kind: "delete", table: name });
          return Promise.resolve();
        },
      };
    },
  };

  const db = {
    transaction<T>(cb: (txArg: unknown) => Promise<T>): Promise<T> {
      txOpened++;
      return cb(tx);
    },
  } as unknown as Parameters<typeof createEntry>[0]["db"];

  return {
    db,
    ops,
    get inserts() {
      return ops.filter((o): o is Extract<Op, { kind: "insert" }> => o.kind === "insert");
    },
    get txOpened() {
      return txOpened;
    },
  };
}

function baseInput(overrides: Partial<IngestInput> = {}): IngestInput {
  return {
    title: "PO Receipt — Validation Errors",
    category: "validation",
    tags: ["po", "receipt"],
    body: "Quantity must be greater than zero. See ticket #4242 for the original report.",
    source_pointer: "ticket://4242",
    last_verified_at: new Date("2026-05-18T10:00:00Z"),
    sensitivity: "internal",
    ...overrides,
  };
}

describe("createEntry — orchestration order is load-bearing", () => {
  it("scrubs PII BEFORE storing entries.body (ADR-0009 §5)", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    const dirtyBody = "Contact gal@example.com about ticket — really.";
    await createEntry({
      db: mock.db,
      embedder,
      input: baseInput({ body: dirtyBody }),
      source: { kind: "direct" },
    });

    const entryCall = mock.inserts.find((c) => c.table === "entries")!;
    const storedBody = (entryCall.rows[0] as { body: string }).body;
    // Negative-assertion: if the scrub were skipped, storedBody would
    // contain the literal email. Asserting NOT-equal-to-dirty AND
    // equal-to-scrubbed distinguishes "scrub ran" from "stored verbatim".
    expect(storedBody).not.toContain("gal@example.com");
    expect(storedBody).toBe(scrubPii(dirtyBody).normalize("NFC"));
  });

  it("stores entries.body in NFC form so chunk offsets index correctly", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    // NFD form of "é" is "é" — two code units. Stored body must be
    // NFC ("é", one code unit) to match what `chunk()` walks internally.
    const nfdBody = "café".normalize("NFD") + " details here";
    await createEntry({
      db: mock.db,
      embedder,
      input: baseInput({ body: nfdBody }),
      source: { kind: "direct" },
    });

    const entryCall = mock.inserts.find((c) => c.table === "entries")!;
    const storedBody = (entryCall.rows[0] as { body: string }).body;
    expect(storedBody).toBe(nfdBody.normalize("NFC"));
    // Negative-assertion: if NFC were skipped, storedBody.length would
    // equal nfdBody.length (one extra code unit). Asserting on the
    // shorter NFC length distinguishes the two worlds.
    expect(storedBody.length).toBeLessThan(nfdBody.length);
  });
});

describe("createEntry — embedder contract", () => {
  it("calls embedBatch ONCE with all chunk inputs (not per-chunk)", async () => {
    const mock = makeMockDb();
    const stub = createStubEmbedder();
    const spy = vi.spyOn(stub, "embedBatch");
    await createEntry({
      db: mock.db,
      embedder: stub,
      input: baseInput(),
      source: { kind: "direct" },
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("propagates embedder.model + version onto every chunk row (#9)", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    await createEntry({ db: mock.db, embedder, input: baseInput(), source: { kind: "direct" } });

    const chunkCall = mock.inserts.find((c) => c.table === "chunks");
    // Small body fits in one chunk; assert on the row that exists.
    if (chunkCall) {
      for (const row of chunkCall.rows as Array<{
        embedding_model: string;
        embedding_version: string;
      }>) {
        expect(row.embedding_model).toBe(embedder.model);
        expect(row.embedding_version).toBe(embedder.version);
      }
    }
  });
});

describe("createEntry — vector alignment + sensitivity propagation", () => {
  it("chunk row embedding[i] equals embedder.embed(buildEmbedInput(slice[i])).vector", async () => {
    // Negative-assertion: if embedBatch results were reversed or randomly
    // re-ordered, this exact-equality assertion would fail. A
    // `vectors.length === slices.length` assertion would NOT — it would
    // pass for any permutation. This is the WORKFLOW.md negative-assertion
    // discipline applied to batch ordering.
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    // Use a body long enough to produce ≥ 2 chunks for a meaningful test.
    const longBody = "Priority workflow step. ".repeat(400).trim();
    const input = baseInput({ body: longBody });
    const canonicalBody = scrubPii(input.body).normalize("NFC");
    const expectedSlices = chunk(canonicalBody);
    expect(expectedSlices.length).toBeGreaterThan(1);

    await createEntry({ db: mock.db, embedder, input, source: { kind: "direct" } });

    const chunkCall = mock.inserts.find((c) => c.table === "chunks")!;
    const rows = chunkCall.rows as Array<{ embedding: number[] }>;
    expect(rows.length).toBe(expectedSlices.length);

    for (let i = 0; i < expectedSlices.length; i++) {
      const expectedInput = buildEmbedInput({
        title: input.title,
        tags: input.tags,
        body: canonicalBody,
        content_start: expectedSlices[i].content_start,
        content_end: expectedSlices[i].content_end,
      });
      const { vector: expectedVec } = await embedder.embed(expectedInput);
      expect(rows[i].embedding).toEqual(expectedVec);
    }
  });

  it("propagates parent entry.sensitivity onto every chunk row (composite FK precondition)", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    await createEntry({
      db: mock.db,
      embedder,
      input: baseInput({ sensitivity: "restricted" }),
      source: { kind: "direct" },
    });

    const chunkCall = mock.inserts.find((c) => c.table === "chunks");
    if (chunkCall) {
      for (const row of chunkCall.rows as Array<{ sensitivity: string }>) {
        expect(row.sensitivity).toBe("restricted");
      }
    }
    const versionCall = mock.inserts.find((c) => c.table === "entries_versions")!;
    expect((versionCall.rows[0] as { sensitivity: string }).sensitivity).toBe("restricted");
  });
});

describe("createEntry — transaction + audit row", () => {
  it("opens exactly one transaction", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    await createEntry({ db: mock.db, embedder, input: baseInput(), source: { kind: "direct" } });
    expect(mock.txOpened).toBe(1);
  });

  it("writes one audit_log row with kind:'ingest' and a non-null entry_id", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    await createEntry({ db: mock.db, embedder, input: baseInput(), source: { kind: "direct" } });

    const auditCalls = mock.inserts.filter((c) => c.table === "audit_log");
    expect(auditCalls.length).toBe(1);
    const auditRow = auditCalls[0].rows[0] as {
      kind: string;
      entry_id: string;
      prompt_hash: string | null;
      payload: Record<string, unknown>;
    };
    expect(auditRow.kind).toBe("ingest");
    expect(auditRow.entry_id).toBeTruthy();
    expect(auditRow.prompt_hash).toBeNull();
    expect(auditRow.payload.source).toBe("direct");
    expect(auditRow.payload.chunk_count).toBeGreaterThanOrEqual(1);
  });

  it("agent source: kind:'agent_ingest' + prompt_hash from lib/prompts (caller cannot override)", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    await createEntry({
      db: mock.db,
      embedder,
      input: baseInput(),
      source: { kind: "agent" },
    });

    const auditRow = mock.inserts.find((c) => c.table === "audit_log")!.rows[0] as {
      kind: string;
      prompt_hash: string | null;
      payload: { source: string };
    };
    // Negative-assertion: if the agent branch read the hash from caller-
    // supplied input (the rejected discriminated-union shape), this
    // exact-equality against the imported constant would fail when a
    // caller passed a different hex. The function takes no hash arg —
    // there is no API surface through which to inject a wrong value.
    expect(auditRow.kind).toBe("agent_ingest");
    expect(auditRow.prompt_hash).toBe(INGESTION_AGENT_PROMPT_HASH);
    expect(auditRow.payload.source).toBe("agent");
  });

  it("writes version_no=1 in entries_versions", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    const result = await createEntry({
      db: mock.db,
      embedder,
      input: baseInput(),
      source: { kind: "direct" },
    });
    const versionCall = mock.inserts.find((c) => c.table === "entries_versions")!;
    expect((versionCall.rows[0] as { version_no: number }).version_no).toBe(1);
    expect(result.version_no).toBe(1);
  });
});

describe("createEntry — edge cases", () => {
  it("rejects body that is empty after scrub", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    // Body is entirely an email → scrubs to "[email]", which is non-empty;
    // construct a body that scrubs to empty by using only patterns that
    // become tokens AND wrapping with no non-PII text. Simpler: pass an
    // empty string directly — chunk() and embedder would otherwise be
    // called with empty input which is the bug we want to prevent.
    await expect(
      createEntry({
        db: mock.db,
        embedder,
        input: baseInput({ body: "" }),
        source: { kind: "direct" },
      }),
    ).rejects.toBeInstanceOf(EmptyBodyAfterScrubError);
  });

  it("propagates embedder failure (transaction never opens)", async () => {
    const mock = makeMockDb();
    const failing = createStubEmbedder();
    vi.spyOn(failing, "embedBatch").mockRejectedValueOnce(new Error("voyage 503"));
    await expect(
      createEntry({
        db: mock.db,
        embedder: failing,
        input: baseInput(),
        source: { kind: "direct" },
      }),
    ).rejects.toThrow("voyage 503");
    // Negative-assertion: if the embedder call happened AFTER opening the
    // transaction (wrong order), txOpened would be 1. Asserting 0
    // distinguishes "embedder runs before tx" from a buggier ordering.
    expect(mock.txOpened).toBe(0);
  });

  it("rejects embedder that returns mismatched vector count (length-guard)", async () => {
    const mock = makeMockDb();
    const wrongCount = createStubEmbedder();
    const realBatch = wrongCount.embedBatch.bind(wrongCount);
    vi.spyOn(wrongCount, "embedBatch").mockImplementationOnce(async (texts) => {
      const real = await realBatch(texts);
      return { ...real, vectors: real.vectors.slice(0, -1) };
    });
    // Use a body that produces ≥ 2 chunks so slice(0,-1) leaves a real mismatch.
    const longBody = "Priority workflow step. ".repeat(400).trim();
    await expect(
      createEntry({
        db: mock.db,
        embedder: wrongCount,
        input: baseInput({ body: longBody }),
        source: { kind: "direct" },
      }),
    ).rejects.toThrow(/vectors for/);
    // Same negative-assertion as above: guard runs pre-transaction.
    expect(mock.txOpened).toBe(0);
  });

  it("accepts tags: [] (empty array) and surfaces it onto entries.tags", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    await createEntry({
      db: mock.db,
      embedder,
      input: baseInput({ tags: [] }),
      source: { kind: "direct" },
    });
    const entryCall = mock.inserts.find((c) => c.table === "entries")!;
    expect((entryCall.rows[0] as { tags: string[] }).tags).toEqual([]);
  });
});

describe("updateEntry — pre-tx empty-after-scrub guard", () => {
  it("throws EmptyBodyAfterScrubError BEFORE opening the transaction", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    await expect(
      updateEntry({
        db: mock.db,
        embedder,
        id: "existing-entry-id",
        input: baseInput({ body: "" }),
        source: { kind: "direct" },
      }),
    ).rejects.toBeInstanceOf(EmptyBodyAfterScrubError);
    // Negative-assertion: if the guard ran inside the tx, txOpened would
    // be 1 and the SELECT FOR UPDATE op would have been recorded.
    expect(mock.txOpened).toBe(0);
    expect(mock.ops).toHaveLength(0);
  });
});

describe("updateEntry — 404 when entry not found", () => {
  it("throws EntryNotFoundError if SELECT FOR UPDATE returns 0 rows", async () => {
    const mock = makeMockDb({ entriesLookup: [] });
    const embedder = createStubEmbedder();
    await expect(
      updateEntry({
        db: mock.db,
        embedder,
        id: "missing-id",
        input: baseInput(),
        source: { kind: "direct" },
      }),
    ).rejects.toBeInstanceOf(EntryNotFoundError);
    // Negative-assertion: if the lookup-empty check were missing, the
    // orchestration would proceed to INSERT entries_versions. Asserting
    // no inserts happened distinguishes "404 short-circuits" from
    // "404 fires but writes still landed".
    expect(mock.inserts).toHaveLength(0);
  });
});

describe("updateEntry — happy path: ordering + version increment + audit", () => {
  it("opens SELECT FOR UPDATE first, then writes version_no = MAX+1", async () => {
    const mock = makeMockDb({ maxVersionNo: 4 });
    const embedder = createStubEmbedder();
    const result = await updateEntry({
      db: mock.db,
      embedder,
      id: "existing-entry-id",
      input: baseInput(),
      source: { kind: "direct" },
    });
    expect(result.version_no).toBe(5);
    // Negative-assertion: if updateEntry hardcoded version_no=2, this
    // would fail for maxVersionNo=4. Asserting on the dynamic value
    // distinguishes the MAX+1 computation from a hardcoded literal.
    const versionInsert = mock.inserts.find((o) => o.table === "entries_versions")!;
    expect((versionInsert.rows[0] as { version_no: number }).version_no).toBe(5);
  });

  it("deletes old chunks BEFORE updating entries (cascade-avoidance order)", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    await updateEntry({
      db: mock.db,
      embedder,
      id: "existing-entry-id",
      input: baseInput(),
      source: { kind: "direct" },
    });
    const deleteIdx = mock.ops.findIndex((o) => o.kind === "delete" && o.table === "chunks");
    const updateIdx = mock.ops.findIndex((o) => o.kind === "update" && o.table === "entries");
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    // Negative-assertion: if the wrong order were committed (UPDATE
    // entries first, DELETE chunks second), the composite FK CASCADE
    // would do wasted work on the chunks rows we're about to delete.
    // Asserting delete < update distinguishes intended order from the
    // wasteful inverse.
    expect(deleteIdx).toBeLessThan(updateIdx);
  });

  it("writes audit_log row with kind:'ingest_update' and the new version_no", async () => {
    const mock = makeMockDb({ maxVersionNo: 2 });
    const embedder = createStubEmbedder();
    await updateEntry({
      db: mock.db,
      embedder,
      id: "existing-entry-id",
      input: baseInput(),
      source: { kind: "direct" },
    });
    const auditInsert = mock.inserts.find((o) => o.table === "audit_log")!;
    const row = auditInsert.rows[0] as {
      kind: string;
      prompt_hash: string | null;
      payload: { version_no: number; source: string };
    };
    expect(row.kind).toBe("ingest_update");
    expect(row.prompt_hash).toBeNull();
    expect(row.payload.source).toBe("direct");
    expect(row.payload.version_no).toBe(3);
  });

  it("ADR-0021 §D3: audit_extra.worker_id threads into audit_log.payload", async () => {
    const mock = makeMockDb({ maxVersionNo: 2 });
    const embedder = createStubEmbedder();
    await updateEntry({
      db: mock.db,
      embedder,
      id: "existing-entry-id",
      input: baseInput(),
      source: { kind: "direct" },
      audit_extra: { worker_id: "worker-host-42-abcd" },
    });
    const row = mock.inserts.find((o) => o.table === "audit_log")!.rows[0] as {
      payload: Record<string, unknown>;
    };
    expect(row.payload.worker_id).toBe("worker-host-42-abcd");
    // Negative-assertion: dropping the conditional-include would leak a
    // `job_id: undefined` key into the audit row, which dashboards
    // grouping by `payload->>'job_id'` would mis-bucket. Pin the key-set.
    expect("job_id" in row.payload).toBe(false);
  });

  it("ADR-0021 §D3: audit_extra with both worker_id + job_id lands in payload", async () => {
    const mock = makeMockDb({ maxVersionNo: 2 });
    const embedder = createStubEmbedder();
    await updateEntry({
      db: mock.db,
      embedder,
      id: "existing-entry-id",
      input: baseInput(),
      source: { kind: "direct" },
      audit_extra: {
        worker_id: "worker-host-42-abcd",
        job_id: "00000000-1111-2222-3333-444444444444",
      },
    });
    const row = mock.inserts.find((o) => o.table === "audit_log")!.rows[0] as {
      payload: Record<string, unknown>;
    };
    expect(row.payload.worker_id).toBe("worker-host-42-abcd");
    expect(row.payload.job_id).toBe("00000000-1111-2222-3333-444444444444");
  });

  it("ADR-0021 §D3: human-admin PUT (no audit_extra) writes the unchanged payload shape", async () => {
    const mock = makeMockDb({ maxVersionNo: 2 });
    const embedder = createStubEmbedder();
    await updateEntry({
      db: mock.db,
      embedder,
      id: "existing-entry-id",
      input: baseInput(),
      source: { kind: "direct" },
      // audit_extra intentionally omitted
    });
    const row = mock.inserts.find((o) => o.table === "audit_log")!.rows[0] as {
      payload: Record<string, unknown>;
    };
    // Pre-ADR-0021 shape: no worker_id / no job_id keys at all.
    expect("worker_id" in row.payload).toBe(false);
    expect("job_id" in row.payload).toBe(false);
  });

  it("agent source: kind:'agent_ingest_update' + prompt_hash from lib/prompts", async () => {
    const mock = makeMockDb({ maxVersionNo: 2 });
    const embedder = createStubEmbedder();
    await updateEntry({
      db: mock.db,
      embedder,
      id: "existing-entry-id",
      input: baseInput(),
      source: { kind: "agent" },
    });
    const row = mock.inserts.find((o) => o.table === "audit_log")!.rows[0] as {
      kind: string;
      prompt_hash: string | null;
      payload: { source: string; version_no: number };
    };
    expect(row.kind).toBe("agent_ingest_update");
    expect(row.prompt_hash).toBe(INGESTION_AGENT_PROMPT_HASH);
    expect(row.payload.source).toBe("agent");
    expect(row.payload.version_no).toBe(3);
  });

  it("calls SELECT FOR UPDATE on entries (concurrency lock)", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    await updateEntry({
      db: mock.db,
      embedder,
      id: "existing-entry-id",
      input: baseInput(),
      source: { kind: "direct" },
    });
    const forUpdateOps = mock.ops.filter((o) => o.kind === "select" && o.forUpdate);
    expect(forUpdateOps).toHaveLength(1);
    expect((forUpdateOps[0] as { table: string }).table).toBe("entries");
  });

  it("propagates NEW sensitivity onto re-derived chunks (composite-FK precondition)", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    await updateEntry({
      db: mock.db,
      embedder,
      id: "existing-entry-id",
      input: baseInput({ sensitivity: "restricted" }),
      source: { kind: "direct" },
    });
    const chunksInsert = mock.inserts.find((o) => o.table === "chunks");
    if (chunksInsert) {
      for (const row of chunksInsert.rows as Array<{ sensitivity: string }>) {
        expect(row.sensitivity).toBe("restricted");
      }
    }
  });
});

describe("submitEntryFromAgent / updateEntryFromAgent — wrapper layer", () => {
  // The agent-path audit-row shape is already proven for createEntry at
  // line 313 ("agent source: kind:'agent_ingest' …") and for updateEntry
  // at line 530 ("agent source: kind:'agent_ingest_update' …"). These
  // tests prove that the wrapper functions exist, accept the
  // source-less argument shape, and forward the agent discriminator —
  // the type system (Omit<…, "source">) is the real mechanical floor
  // against caller-supplied source, but a runtime smoke confirms the
  // wrapper isn't a silent no-op or a misrouted call.

  it("submitEntryFromAgent forwards through createEntry with source pinned to {kind:'agent'}", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    const result = await submitEntryFromAgent({
      db: mock.db,
      embedder,
      input: baseInput(),
    });
    const audit = mock.inserts.find((o) => o.table === "audit_log")!.rows[0] as {
      kind: string;
      prompt_hash: string | null;
      payload: { source: string };
    };
    expect(audit.kind).toBe("agent_ingest");
    expect(audit.prompt_hash).toBe(INGESTION_AGENT_PROMPT_HASH);
    expect(audit.payload.source).toBe("agent");
    expect(result.version_no).toBe(1);
  });

  it("updateEntryFromAgent forwards through updateEntry with source pinned to {kind:'agent'} and lands kind:'agent_ingest_update'", async () => {
    const mock = makeMockDb({ maxVersionNo: 7 });
    const embedder = createStubEmbedder();
    const result = await updateEntryFromAgent("existing-entry-id", {
      db: mock.db,
      embedder,
      input: baseInput(),
    });
    const audit = mock.inserts.find((o) => o.table === "audit_log")!.rows[0] as {
      kind: string;
      prompt_hash: string | null;
      payload: { source: string; version_no: number };
    };
    expect(audit.kind).toBe("agent_ingest_update");
    expect(audit.prompt_hash).toBe(INGESTION_AGENT_PROMPT_HASH);
    expect(audit.payload.source).toBe("agent");
    expect(audit.payload.version_no).toBe(8);
    expect(result.version_no).toBe(8);
  });

  it("caller cannot supply a `source` arg — compile-time guard via Omit<…, 'source'>", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    // The wrapper's job is to pin source to {kind:"agent"}; allowing a
    // caller-supplied source would defeat iron rule #10's mechanical
    // floor. `npm run check` runs `tsc --noEmit` so @ts-expect-error
    // is enforced — the directive must sit on the LINE before the
    // error-producing line (the `source` property), not before the
    // outer statement.
    await submitEntryFromAgent({
      db: mock.db,
      embedder,
      input: baseInput(),
      // @ts-expect-error — Omit<…, "source"> forbids this property
      source: { kind: "direct" },
    });
    await updateEntryFromAgent("existing-entry-id", {
      db: mock.db,
      embedder,
      input: baseInput(),
      // @ts-expect-error — Omit<…, "source"> forbids this property
      source: { kind: "direct" },
    });
  });
});
