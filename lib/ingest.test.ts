import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildEmbedInput, chunk } from "@/lib/chunk";
import { createStubEmbedder } from "@/lib/embedding";
import { createEntry, EmptyBodyAfterScrubError, type IngestInput } from "@/lib/ingest";
import { resetLogSink, setLogSink } from "@/lib/log";
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

type InsertCall = { table: string; rows: unknown[] };

function makeMockDb() {
  const calls: InsertCall[] = [];
  let txOpened = 0;
  let entryIdCounter = 0;

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
          calls.push({ table: name, rows });
          const synthIds = rows.map(() => ({ id: `entry-${++entryIdCounter}` }));
          // Returning-aware: when called with .returning(), resolve to
          // synthetic ids; otherwise resolve to void. Drizzle's value-shape
          // is "thenable" so it's awaitable either way.
          const promise = Promise.resolve(synthIds);
          return Object.assign(promise, {
            returning: (_cols?: unknown) => Promise.resolve(synthIds),
          });
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
    calls,
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
    const { db, calls } = makeMockDb();
    const embedder = createStubEmbedder();
    const dirtyBody = "Contact gal@example.com about ticket — really.";
    await createEntry({
      db,
      embedder,
      input: baseInput({ body: dirtyBody }),
    });

    const entryCall = calls.find((c) => c.table === "entries")!;
    const storedBody = (entryCall.rows[0] as { body: string }).body;
    // Negative-assertion: if the scrub were skipped, storedBody would
    // contain the literal email. Asserting NOT-equal-to-dirty AND
    // equal-to-scrubbed distinguishes "scrub ran" from "stored verbatim".
    expect(storedBody).not.toContain("gal@example.com");
    expect(storedBody).toBe(scrubPii(dirtyBody).normalize("NFC"));
  });

  it("stores entries.body in NFC form so chunk offsets index correctly", async () => {
    const { db, calls } = makeMockDb();
    const embedder = createStubEmbedder();
    // NFD form of "é" is "é" — two code units. Stored body must be
    // NFC ("é", one code unit) to match what `chunk()` walks internally.
    const nfdBody = "café".normalize("NFD") + " details here";
    await createEntry({
      db,
      embedder,
      input: baseInput({ body: nfdBody }),
    });

    const entryCall = calls.find((c) => c.table === "entries")!;
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
    const { db } = makeMockDb();
    const stub = createStubEmbedder();
    const spy = vi.spyOn(stub, "embedBatch");
    await createEntry({ db, embedder: stub, input: baseInput() });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("propagates embedder.model + version onto every chunk row (#9)", async () => {
    const { db, calls } = makeMockDb();
    const embedder = createStubEmbedder();
    await createEntry({ db, embedder, input: baseInput() });

    const chunkCall = calls.find((c) => c.table === "chunks");
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
    const { db, calls } = makeMockDb();
    const embedder = createStubEmbedder();
    // Use a body long enough to produce ≥ 2 chunks for a meaningful test.
    const longBody = "Priority workflow step. ".repeat(400).trim();
    const input = baseInput({ body: longBody });
    const canonicalBody = scrubPii(input.body).normalize("NFC");
    const expectedSlices = chunk(canonicalBody);
    expect(expectedSlices.length).toBeGreaterThan(1);

    await createEntry({ db, embedder, input });

    const chunkCall = calls.find((c) => c.table === "chunks")!;
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
    const { db, calls } = makeMockDb();
    const embedder = createStubEmbedder();
    await createEntry({
      db,
      embedder,
      input: baseInput({ sensitivity: "restricted" }),
    });

    const chunkCall = calls.find((c) => c.table === "chunks");
    if (chunkCall) {
      for (const row of chunkCall.rows as Array<{ sensitivity: string }>) {
        expect(row.sensitivity).toBe("restricted");
      }
    }
    const versionCall = calls.find((c) => c.table === "entries_versions")!;
    expect((versionCall.rows[0] as { sensitivity: string }).sensitivity).toBe("restricted");
  });
});

describe("createEntry — transaction + audit row", () => {
  it("opens exactly one transaction", async () => {
    const mock = makeMockDb();
    const embedder = createStubEmbedder();
    await createEntry({ db: mock.db, embedder, input: baseInput() });
    expect(mock.txOpened).toBe(1);
  });

  it("writes one audit_log row with kind:'ingest' and a non-null entry_id", async () => {
    const { db, calls } = makeMockDb();
    const embedder = createStubEmbedder();
    await createEntry({ db, embedder, input: baseInput() });

    const auditCalls = calls.filter((c) => c.table === "audit_log");
    expect(auditCalls.length).toBe(1);
    const auditRow = auditCalls[0].rows[0] as {
      kind: string;
      entry_id: string;
      payload: Record<string, unknown>;
    };
    expect(auditRow.kind).toBe("ingest");
    expect(auditRow.entry_id).toBeTruthy();
    expect(auditRow.payload.chunk_count).toBeGreaterThanOrEqual(1);
  });

  it("writes version_no=1 in entries_versions", async () => {
    const { db, calls } = makeMockDb();
    const embedder = createStubEmbedder();
    const result = await createEntry({ db, embedder, input: baseInput() });
    const versionCall = calls.find((c) => c.table === "entries_versions")!;
    expect((versionCall.rows[0] as { version_no: number }).version_no).toBe(1);
    expect(result.version_no).toBe(1);
  });
});

describe("createEntry — edge cases", () => {
  it("rejects body that is empty after scrub", async () => {
    const { db } = makeMockDb();
    const embedder = createStubEmbedder();
    // Body is entirely an email → scrubs to "[email]", which is non-empty;
    // construct a body that scrubs to empty by using only patterns that
    // become tokens AND wrapping with no non-PII text. Simpler: pass an
    // empty string directly — chunk() and embedder would otherwise be
    // called with empty input which is the bug we want to prevent.
    await expect(
      createEntry({ db, embedder, input: baseInput({ body: "" }) }),
    ).rejects.toBeInstanceOf(EmptyBodyAfterScrubError);
  });

  it("propagates embedder failure (transaction never opens)", async () => {
    const mock = makeMockDb();
    const failing = createStubEmbedder();
    vi.spyOn(failing, "embedBatch").mockRejectedValueOnce(new Error("voyage 503"));
    await expect(
      createEntry({ db: mock.db, embedder: failing, input: baseInput() }),
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
      createEntry({ db: mock.db, embedder: wrongCount, input: baseInput({ body: longBody }) }),
    ).rejects.toThrow(/vectors for/);
    // Same negative-assertion as above: guard runs pre-transaction.
    expect(mock.txOpened).toBe(0);
  });

  it("accepts tags: [] (empty array) and surfaces it onto entries.tags", async () => {
    const { db, calls } = makeMockDb();
    const embedder = createStubEmbedder();
    await createEntry({ db, embedder, input: baseInput({ tags: [] }) });
    const entryCall = calls.find((c) => c.table === "entries")!;
    expect((entryCall.rows[0] as { tags: string[] }).tags).toEqual([]);
  });
});
