// tests/retrieval-pipeline.integration.test.ts — ADR-0013 §3 8-row degraded
// matrix + zero-keyword-under-embed-outage special case, driven end-to-end
// against REAL Postgres. Iron rule #8: SDK boundaries (embedder, reranker,
// synthesizer) are stubbed — only the DB lanes (`annCandidates`,
// `keywordCandidates`) and DB hydration (`fetchEntriesFn`,
// `fetchChunkSlicesFn` defaults via `getDb()`) are real.
//
// What the all-stub unit suite at lib/retrieval-pipeline.test.ts CANNOT prove
// and this suite CAN:
// - `WHERE chunks.embedding_model = $3 AND chunks.embedding_version = $4`
//   compiles correctly under real pgvector cosine ranking.
// - `entries.tsv @@ websearch_to_tsquery('simple', unaccent(regexp_replace(...)))`
//   returns rows under the orchestrator's parameter passing — including the
//   `embed-fail → keyword-only` lane that the unit tests can only simulate.
// - RRF fusion of two REAL rank lists (ANN cosine + keyword ts_rank_cd) lands
//   in `outcome.fused_ids` with the order an independent RRF computation
//   predicts.
// - The `Promise.all([annFn, keywordFn])` parallel execution (line 381 of the
//   orchestrator) does not interfere with the ANN lane's `BEGIN; SET LOCAL
//   hnsw.ef_search = 100; ...; COMMIT;` transaction wrapper.
//
// Deferred to shape β / γ (next session): sensitivity-flip SQL WHERE
// end-to-end, citation-retry path with real DB, RRF k env-knob sweep,
// embedding-version mismatch end-to-end.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import type { Role } from "@/lib/auth";
import {
  EmbeddingUnavailableError,
  STUB_DIMENSIONS,
  type EmbedOptions,
  type Embedder,
  type EmbeddingBatchResult,
  type EmbeddingResult,
} from "@/lib/embedding";
import {
  RerankUnavailableError,
  SynthUnavailableError,
  type Reranker,
  type Synthesizer,
} from "@/lib/retrieval";
import { annCandidates } from "@/lib/retrieval-ann";
import { keywordCandidates } from "@/lib/retrieval-keyword";
import {
  drainPipeline,
  retrievePipeline,
  RETRIEVAL_RRF_K,
  TOP_K_ANN,
  TOP_N_SYNTH,
  type PipelineDeps,
} from "@/lib/retrieval-pipeline";

// ── DB gating (mirror tests/retrieval-ann.integration.test.ts) ─────────────

const databaseUrl = process.env.DATABASE_URL;
const isCi = process.env.CI === "true";

if (isCi && !databaseUrl) {
  throw new Error(
    "DATABASE_URL must be set in CI; retrieval-pipeline integration test cannot silently skip",
  );
}

const describeIfDb = databaseUrl ? describe : describe.skip;

// ── Fixture UUIDs (v4-valid) ───────────────────────────────────────────────

const E1 = "11111111-1111-4111-8111-111111111111";
const E2 = "22222222-2222-4222-8222-222222222222";
const E3 = "33333333-3333-4333-8333-333333333333";
const E4 = "44444444-4444-4444-8444-444444444444";
const ALL_ENTRY_IDS = [E1, E2, E3, E4] as const;

// ── Stub model/version (shared by embedder stub + chunk inserts so the
// ANN SQL `WHERE chunks.embedding_model = $3 AND ... = $4` matches). ────────

const STUB_MODEL = "stub-sha256";
const STUB_VERSION = "v1";

// Single-token query — the production keyword recipe is
// `websearch_to_tsquery('simple', unaccent(regexp_replace($1,'[֑-ׇ]','','g')))`;
// for the ASCII single-token "priority" the regex/unaccent are no-ops and the
// tsquery becomes a single lexeme that matches any body containing "priority"
// as a standalone token. Multi-token queries get ANDed (Postgres websearch
// dialect), so a single token sidesteps the seed-body permutation problem.
const QUERY = "priority";
// A token that produces a non-empty tsquery but is absent from every seeded
// body. Used by the row-9 zero-keyword special case.
const QUERY_ABSENT = "xyzzyqwerty";

// ── Vector helpers (mirror tests/retrieval-ann.integration.test.ts) ────────

function vec(firstSlot: number): number[] {
  const v = new Array<number>(STUB_DIMENSIONS).fill(0.01);
  v[0] = firstSlot;
  return v;
}
function vecLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

// ── Seed helpers ───────────────────────────────────────────────────────────
//
// Composite FK (drizzle/schema.ts:113-118) requires `chunks.sensitivity ===
// entries.sensitivity` on insert. `insertChunk` reads the parent entry's
// sensitivity from the typed argument so the constraint is satisfied by
// construction (mirrors tests/retrieval-ann.integration.test.ts:67).

type SeedEntry = {
  id: string;
  title: string;
  body: string;
  sensitivity: "public" | "internal" | "restricted";
};

async function insertEntry(pool: Pool, e: SeedEntry): Promise<void> {
  await pool.query(
    `INSERT INTO entries (id, title, category, tags, body, source_pointer, last_verified_at, sensitivity)
     VALUES ($1, $2, 'test', ARRAY[]::text[], $3, 'src://test', now(), $4)`,
    [e.id, e.title, e.body, e.sensitivity],
  );
}

async function insertChunk(
  pool: Pool,
  args: {
    entry_id: string;
    sensitivity: "public" | "internal" | "restricted";
    embedding: number[];
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO chunks
       (entry_id, sensitivity, chunk_index, chunk_total, content_start, content_end,
        token_count, chunking_policy_version, embedding, embedding_model, embedding_version)
     VALUES ($1, $2, 0, 1, 0, 5, 1, 'v1-2026-05-17', $3::vector, $4, $5)`,
    [args.entry_id, args.sensitivity, vecLiteral(args.embedding), STUB_MODEL, STUB_VERSION],
  );
}

/**
 * Seed four PUBLIC entries whose bodies all contain "priority" as a
 * standalone token (so the keyword lane matches every entry), with
 * monotonically increasing ANN distance from the query vector vec(0.5).
 * Different body shapes drive divergent `ts_rank_cd` scores so the keyword
 * lane's order is NOT identical to the ANN lane's order — the test depends
 * on that divergence to make the RRF assertion non-trivial.
 */
async function seedFourEntries(pool: Pool): Promise<void> {
  // E1 short body — high cover density on a short cover length.
  await insertEntry(pool, {
    id: E1,
    title: "Priority overview",
    body: "priority workflow",
    sensitivity: "public",
  });
  // E2 medium body, single term occurrence — lower cover density than E1.
  await insertEntry(pool, {
    id: E2,
    title: "Invoice",
    body: "creating an invoice in the priority erp involves several steps",
    sensitivity: "public",
  });
  // E3 long body, multiple term occurrences — repetition lifts ts_rank_cd.
  await insertEntry(pool, {
    id: E3,
    title: "Docs",
    body: "priority priority documentation references the priority manual",
    sensitivity: "public",
  });
  // E4 long body, single term occurrence near the end.
  await insertEntry(pool, {
    id: E4,
    title: "Misc",
    body: "see the section about the priority module at the end of the appendix",
    sensitivity: "public",
  });

  // ANN distance from query vector vec(0.5) is monotone in |first-slot - 0.5|
  // because all 1023 trailing slots match the query vector exactly. E1 has
  // first-slot 0.5 (rank 1 nearest), E4 has 0.65 (rank 4 farthest).
  await insertChunk(pool, { entry_id: E1, sensitivity: "public", embedding: vec(0.5) });
  await insertChunk(pool, { entry_id: E2, sensitivity: "public", embedding: vec(0.55) });
  await insertChunk(pool, { entry_id: E3, sensitivity: "public", embedding: vec(0.6) });
  await insertChunk(pool, { entry_id: E4, sensitivity: "public", embedding: vec(0.65) });
}

// ── Stub provider builders ─────────────────────────────────────────────────

function buildEmbedder(opts?: { fail?: boolean }): Embedder {
  return {
    dimensions: STUB_DIMENSIONS,
    model: STUB_MODEL,
    version: STUB_VERSION,
    async embed(_text: string, _options?: EmbedOptions): Promise<EmbeddingResult> {
      if (opts?.fail) throw new EmbeddingUnavailableError("embed down");
      // Returns the query vector vec(0.5) so seeded chunks at vec(0.5..0.65)
      // produce strictly increasing cosine distance — and so the ANN order
      // is deterministic across runs.
      return { vector: vec(0.5), model: STUB_MODEL, version: STUB_VERSION, tokens_used: 7 };
    },
    async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
      return {
        vectors: texts.map(() => vec(0.5)),
        model: STUB_MODEL,
        version: STUB_VERSION,
        tokens_used: texts.length * 7,
      };
    },
  };
}

function buildReranker(opts?: { fail?: boolean }): Reranker {
  return {
    model: "stub-rerank",
    version: "v1",
    async rerank(_query, docs, options) {
      if (opts?.fail) throw new RerankUnavailableError("rerank down");
      const n = options?.top_n ?? docs.length;
      // Preserve input order — the orchestrator passes synth chunks to
      // rerank in fused-order, and a no-op rerank keeps reranked_ids equal
      // to the fused prefix. That makes the citation-validation contract
      // (reranked_ids ⊇ cited_ids) easy to satisfy with a single stub.
      return {
        ranking: docs.slice(0, n).map((_d, index) => ({ index, score: 1 - index * 0.01 })),
        tokens_used: docs.length * 10,
      };
    },
  };
}

/**
 * Reranker stub that REVERSES input order — used by row 1 only so the test
 * can distinguish "rerank ran" from "rerank-skip fallback ran". A `top_n=N`
 * call on `docs.length=L` returns the LAST N entries in reverse order
 * (`index` field points at the originals). Asserting
 * `outcome.reranked_ids === fused_ids.slice(0, N).reverse()` then catches a
 * refactor that silently bypasses the reranker on the healthy path.
 */
function buildReverseReranker(): Reranker {
  return {
    model: "stub-rerank-reverse",
    version: "v1",
    async rerank(_query, docs, options) {
      const n = Math.min(options?.top_n ?? docs.length, docs.length);
      const ranking: { index: number; score: number }[] = [];
      for (let i = 0; i < n; i++) {
        const originalIndex = docs.length - 1 - i;
        ranking.push({ index: originalIndex, score: 1 - i * 0.01 });
      }
      return { ranking, tokens_used: docs.length * 10 };
    },
  };
}

function buildSynth(opts: { fail?: boolean; cite: readonly string[] }): Synthesizer {
  return {
    model: "stub-synth",
    version: "v1",
    async synthesize(_prompt: string, _context: string[]) {
      if (opts.fail) throw new SynthUnavailableError("synth down");
      const ids = opts.cite;
      const inline = ids.map((id) => `claim [${id}].`).join(" ");
      const answer = `${inline}\n\nSources: [${ids.join(", ")}]`;
      return { answer, tokens_in: 100, tokens_out: 200 };
    },
  };
}

// ── Real-DB deps factory ───────────────────────────────────────────────────

/**
 * Hydrate entry rows from the test pool with raw SQL — avoids the default
 * `defaultFetchEntries` path that lazy-instantiates a SECOND Drizzle pool
 * via `getDb()`. The hidden pool wouldn't break this file in isolation but
 * leaks across vitest workers under `--pool=threads`.
 */
async function fetchEntriesFromTestPool(
  pool: Pool,
  ids: string[],
): Promise<
  Array<{
    id: string;
    title: string;
    body: string;
    category: string;
    tags: string[];
    source_pointer: string;
    sensitivity: "public" | "internal" | "restricted";
    last_verified_at: Date;
  }>
> {
  if (ids.length === 0) return [];
  const res = await pool.query<{
    id: string;
    title: string;
    body: string;
    category: string;
    tags: string[];
    source_pointer: string;
    sensitivity: "public" | "internal" | "restricted";
    last_verified_at: Date;
  }>(
    `SELECT id, title, body, category, tags, source_pointer, sensitivity, last_verified_at
       FROM entries WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return res.rows;
}

async function fetchChunkSlicesFromTestPool(
  pool: Pool,
  chunkIds: string[],
): Promise<Array<{ id: string; entry_id: string; content_start: number; content_end: number }>> {
  if (chunkIds.length === 0) return [];
  const res = await pool.query<{
    id: string;
    entry_id: string;
    content_start: number;
    content_end: number;
  }>(
    `SELECT id, entry_id, content_start, content_end
       FROM chunks WHERE id = ANY($1::uuid[])`,
    [chunkIds],
  );
  return res.rows;
}

function buildRealDbDeps(
  pool: Pool,
  opts: { embedder?: Embedder; reranker?: Reranker; synth?: Synthesizer | null },
): PipelineDeps {
  const embedder = opts.embedder ?? buildEmbedder();
  const reranker = opts.reranker ?? buildReranker();
  const deps: PipelineDeps = {
    embedder,
    reranker,
    ...(opts.synth === null ? {} : { synth: opts.synth ?? buildSynth({ cite: ALL_ENTRY_IDS }) }),
    // Wire the REAL DB lanes — this is the point of the integration suite.
    annFn: annCandidates,
    keywordFn: keywordCandidates,
    // Pin the orchestrator's pool to the test's pool — single-pool lifecycle.
    getPool: () => pool,
    // Inject entry/chunk hydration so the orchestrator never touches the
    // `getDb()` singleton's hidden pool (would leak across workers).
    fetchEntriesFn: (ids) => fetchEntriesFromTestPool(pool, ids),
    fetchChunkSlicesFn: (chunkIds) => fetchChunkSlicesFromTestPool(pool, chunkIds),
  };
  return deps;
}

// ── Independent RRF helper (negative-assertion-safe; does NOT call rrfFuse) ─

function expectedRrf(
  annOrder: readonly string[],
  keywordOrder: readonly string[],
  k: number,
  limit: number,
): string[] {
  const scores = new Map<string, number>();
  const indexedScore = (rank: number) => 1 / (k + rank);
  annOrder.forEach((id, idx) => {
    scores.set(id, (scores.get(id) ?? 0) + indexedScore(idx + 1));
  });
  keywordOrder.forEach((id, idx) => {
    scores.set(id, (scores.get(id) ?? 0) + indexedScore(idx + 1));
  });
  // Tie-break: rrfFuse breaks ties by first-seen order. Build a first-seen
  // map combining both lanes (ANN first, then keyword for ids not already
  // present) for the comparator.
  const firstSeen = new Map<string, number>();
  let i = 0;
  for (const id of annOrder) {
    if (!firstSeen.has(id)) firstSeen.set(id, i++);
  }
  for (const id of keywordOrder) {
    if (!firstSeen.has(id)) firstSeen.set(id, i++);
  }
  return [...scores.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0);
    })
    .slice(0, limit)
    .map(([id]) => id);
}

// ── Suite ──────────────────────────────────────────────────────────────────

describeIfDb("retrievePipeline — ADR-0013 §3 matrix integration", () => {
  let pool: Pool;

  beforeAll(async () => {
    // Default pool max is 10 — enough headroom for the orchestrator's
    // parallel `Promise.all([annFn, keywordFn])` plus the test's own seed
    // INSERTs. Explicit for forensic clarity.
    pool = new Pool({ connectionString: databaseUrl, max: 10 });
    // Smoke test: insert one row and confirm migration 0002's `entries.tsv`
    // trigger fires (non-null tsvector). Catches a test DB that hasn't been
    // migrated past the keyword-lane prerequisites.
    const smokeId = "00000000-0000-4000-8000-000000000099";
    // Idempotent INSERT — if a previous suite crashed mid-run and left the
    // smoke row behind, ON CONFLICT keeps beforeAll from failing on PK.
    await pool.query(
      `INSERT INTO entries (id, title, category, tags, body, source_pointer, last_verified_at, sensitivity)
       VALUES ($1, 'smoke', 'test', ARRAY[]::text[], 'smoke body priority', 'src://smoke', now(), 'public')
       ON CONFLICT (id) DO NOTHING`,
      [smokeId],
    );
    const smoke = await pool.query<{ tsv: string }>(
      `SELECT tsv::text AS tsv FROM entries WHERE id=$1`,
      [smokeId],
    );
    expect(smoke.rows[0]?.tsv).toBeTruthy();
    expect(smoke.rows[0]?.tsv).not.toBe("");
    await pool.query(`DELETE FROM entries WHERE id=$1`, [smokeId]);
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    await pool.query("TRUNCATE audit_log, chunks, entries_versions, entries CASCADE");
  });

  // ── Row 1: embed ok + rerank ok + synth ok ────────────────────────────────
  it("row 1 (ok/ok/ok) — full pipeline; ANN + keyword + RRF + reverse-rerank + synth + cited", async () => {
    await seedFourEntries(pool);
    // Reverse-order reranker so the row-1 reranked_ids assertion is
    // distinguishable from the no-op rerank-skip fallback used by row 3 et al.
    // — i.e., a refactor that silently bypasses the reranker on the healthy
    // path fails here.
    const deps = buildRealDbDeps(pool, { reranker: buildReverseReranker() });

    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: QUERY, role: "admin" }),
    );

    expect(events.map((e) => e.kind)).toEqual(["candidates", "answer_delta", "done"]);
    expect(outcome.degraded).toBe(false);
    expect(outcome.degraded_reason).toBeUndefined();
    expect(outcome.status).toBe("ok");
    expect(outcome.keyword_only).toBe(false);

    // Real-DB lane execution — both lanes returned all 4 seeded entries.
    expect(outcome.ann_candidate_ids).toHaveLength(4);
    expect(outcome.keyword_candidate_ids).toHaveLength(4);
    expect(new Set(outcome.ann_candidate_ids)).toEqual(new Set(ALL_ENTRY_IDS));
    expect(new Set(outcome.keyword_candidate_ids)).toEqual(new Set(ALL_ENTRY_IDS));

    // ANN order is deterministic: E1 nearest (vec(0.5) ≡ query), monotonic
    // distance through E4 farthest.
    expect(outcome.ann_candidate_ids).toEqual([E1, E2, E3, E4]);

    // Keyword order depends on real `ts_rank_cd` against the seeded bodies +
    // the SQL's `entries.id ASC` tie-break. Do not predict the order; capture
    // the observed orders and recompute RRF independently.
    const expected = expectedRrf(
      outcome.ann_candidate_ids,
      outcome.keyword_candidate_ids,
      RETRIEVAL_RRF_K,
      TOP_K_ANN,
    );
    expect(outcome.fused_ids).toEqual(expected);
    expect(outcome.rrf_k).toBe(60); // ADR-0013 §2.4 default; pin against env drift.

    // Reverse-rerank load-bearing assertion: the orchestrator passes the
    // first TOP_N_SYNTH fused entries to the reranker; the reverse stub
    // returns them in inverted order; reranked_ids therefore equals the
    // first TOP_N_SYNTH fused entries REVERSED.
    const expectedReranked = outcome.fused_ids.slice(0, TOP_N_SYNTH).slice().reverse();
    expect(outcome.reranked_ids).toEqual(expectedReranked);
    expect(outcome.citation_ids).toEqual([...ALL_ENTRY_IDS]);
    expect(outcome.citation_validation_outcome).toBe("ok");
    expect(outcome.retry_attempted).toBe(false);
    expect(outcome.retry_prefix_hash).toBeNull();
    expect(outcome.tokens.embed).toBe(7);
    expect(outcome.tokens.synth_input).toBe(100);
    expect(outcome.tokens.synth_output).toBe(200);
  });

  // ── Row 2: embed ok + rerank ok + synth FAIL ──────────────────────────────
  it("row 2 (ok/ok/FAIL) — chunks_only with synth_unavailable; reranked populated, citations empty", async () => {
    await seedFourEntries(pool);
    const deps = buildRealDbDeps(pool, { synth: buildSynth({ fail: true, cite: [] }) });

    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: QUERY, role: "admin" }),
    );

    expect(events.map((e) => e.kind)).toEqual(["candidates", "chunks_only"]);
    const chunksEv = events[1] as { kind: "chunks_only"; degraded_reason?: string };
    expect(chunksEv.degraded_reason).toBe("synth_unavailable");

    expect(outcome.degraded).toBe(true);
    expect(outcome.degraded_reason).toBe("synth_unavailable");
    expect(outcome.status).toBe("error");
    expect(outcome.keyword_only).toBe(false);
    // Discriminates row 2 from row 7 (keyword_only=true there).
    expect(outcome.ann_candidate_ids.length).toBeGreaterThan(0);
    expect(outcome.keyword_candidate_ids.length).toBeGreaterThan(0);
    expect(outcome.reranked_ids.length).toBeGreaterThan(0);
    expect(outcome.citation_ids).toEqual([]);
    expect(outcome.tokens.synth_output).toBe(0);
  });

  // ── Row 3: embed ok + rerank FAIL + synth ok ──────────────────────────────
  it("row 3 (ok/FAIL/ok) — rerank skipped; fused-order passed to synth; degraded with rerank_unavailable", async () => {
    await seedFourEntries(pool);
    const deps = buildRealDbDeps(pool, { reranker: buildReranker({ fail: true }) });

    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: QUERY, role: "admin" }),
    );

    expect(events.map((e) => e.kind)).toEqual(["candidates", "answer_delta", "done"]);
    const done = events[2] as {
      kind: "done";
      degraded?: boolean;
      degraded_reason?: string;
      citation_ids: string[];
    };
    expect(done.degraded).toBe(true);
    expect(done.degraded_reason).toBe("rerank_unavailable");

    expect(outcome.degraded).toBe(true);
    expect(outcome.degraded_reason).toBe("rerank_unavailable");
    expect(outcome.status).toBe("ok");
    expect(outcome.keyword_only).toBe(false);
    expect(outcome.ann_candidate_ids.length).toBeGreaterThan(0);
    expect(outcome.keyword_candidate_ids.length).toBeGreaterThan(0);
    // Rerank-skip path: reranked_ids = fused-order top-N.
    expect(outcome.reranked_ids).toEqual(outcome.fused_ids.slice(0, TOP_N_SYNTH));
    expect(outcome.citation_ids).toEqual([...ALL_ENTRY_IDS]);
    expect(outcome.citation_validation_outcome).toBe("ok");
  });

  // ── Row 4: embed ok + rerank FAIL + synth FAIL ────────────────────────────
  it("row 4 (ok/FAIL/FAIL) — chunks_only with rerank_and_synth_unavailable; ANN ids populated", async () => {
    await seedFourEntries(pool);
    const deps = buildRealDbDeps(pool, {
      reranker: buildReranker({ fail: true }),
      synth: buildSynth({ fail: true, cite: [] }),
    });

    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: QUERY, role: "admin" }),
    );

    expect(events.map((e) => e.kind)).toEqual(["candidates", "chunks_only"]);
    const chunksEv = events[1] as { kind: "chunks_only"; degraded_reason?: string };
    expect(chunksEv.degraded_reason).toBe("rerank_and_synth_unavailable");

    expect(outcome.degraded).toBe(true);
    expect(outcome.degraded_reason).toBe("rerank_and_synth_unavailable");
    expect(outcome.status).toBe("error");
    expect(outcome.keyword_only).toBe(false);
    // ANN populated → discriminates row 4 from row 8 (both emit chunks_only).
    expect(outcome.ann_candidate_ids.length).toBeGreaterThan(0);
    expect(outcome.keyword_candidate_ids.length).toBeGreaterThan(0);
    expect(outcome.reranked_ids.length).toBeGreaterThan(0);
    expect(outcome.citation_ids).toEqual([]);
  });

  // ── Row 5: embed FAIL + rerank ok + synth ok ──────────────────────────────
  it("row 5 (FAIL/ok/ok) — keyword-only fallback; ANN empty; keyword carries; embed_unavailable_keyword_fallback", async () => {
    await seedFourEntries(pool);
    const embedder = buildEmbedder({ fail: true });
    const deps = buildRealDbDeps(pool, { embedder });

    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: QUERY, role: "admin" }),
    );

    expect(events.map((e) => e.kind)).toEqual(["candidates", "answer_delta", "done"]);
    const done = events[2] as { kind: "done"; degraded?: boolean; degraded_reason?: string };
    expect(done.degraded).toBe(true);
    expect(done.degraded_reason).toBe("embed_unavailable_keyword_fallback");

    expect(outcome.degraded).toBe(true);
    expect(outcome.degraded_reason).toBe("embed_unavailable_keyword_fallback");
    expect(outcome.status).toBe("ok");
    // Stage-A-threw signature (per Step-7b plan-CR M3): ANN empty + keyword
    // populated + keyword_only true + zero embed tokens.
    expect(outcome.keyword_only).toBe(true);
    expect(outcome.ann_candidate_ids).toEqual([]);
    expect(outcome.keyword_candidate_ids.length).toBeGreaterThan(0);
    expect(outcome.tokens.embed).toBe(0);
    // fused_ids in embed-fail path is keyword_candidate_ids[:TOP_K_ANN].
    expect(outcome.fused_ids).toEqual(outcome.keyword_candidate_ids.slice(0, TOP_K_ANN));
    expect(outcome.reranked_ids).toEqual(outcome.fused_ids.slice(0, TOP_N_SYNTH));
    expect(outcome.citation_ids).toEqual([...ALL_ENTRY_IDS]);
  });

  // ── Row 6: embed FAIL + rerank FAIL + synth ok ────────────────────────────
  it("row 6 (FAIL/FAIL/ok) — keyword-only + rerank skipped + synth; embed_and_rerank_unavailable_keyword_fallback", async () => {
    await seedFourEntries(pool);
    const deps = buildRealDbDeps(pool, {
      embedder: buildEmbedder({ fail: true }),
      reranker: buildReranker({ fail: true }),
    });

    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: QUERY, role: "admin" }),
    );

    expect(events.map((e) => e.kind)).toEqual(["candidates", "answer_delta", "done"]);
    const done = events[2] as { kind: "done"; degraded?: boolean; degraded_reason?: string };
    expect(done.degraded).toBe(true);
    expect(done.degraded_reason).toBe("embed_and_rerank_unavailable_keyword_fallback");

    expect(outcome.degraded).toBe(true);
    expect(outcome.degraded_reason).toBe("embed_and_rerank_unavailable_keyword_fallback");
    expect(outcome.status).toBe("ok");
    expect(outcome.keyword_only).toBe(true);
    expect(outcome.ann_candidate_ids).toEqual([]);
    expect(outcome.keyword_candidate_ids.length).toBeGreaterThan(0);
    expect(outcome.tokens.embed).toBe(0);
    expect(outcome.reranked_ids).toEqual(outcome.fused_ids.slice(0, TOP_N_SYNTH));
    expect(outcome.citation_ids).toEqual([...ALL_ENTRY_IDS]);
  });

  // ── Row 7: embed FAIL + rerank ok + synth FAIL ────────────────────────────
  it("row 7 (FAIL/ok/FAIL) — keyword-only + rerank + chunks_only; embed_and_synth_unavailable_keyword_bare", async () => {
    await seedFourEntries(pool);
    const deps = buildRealDbDeps(pool, {
      embedder: buildEmbedder({ fail: true }),
      synth: buildSynth({ fail: true, cite: [] }),
    });

    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: QUERY, role: "admin" }),
    );

    expect(events.map((e) => e.kind)).toEqual(["candidates", "chunks_only"]);
    const chunksEv = events[1] as { kind: "chunks_only"; degraded_reason?: string };
    expect(chunksEv.degraded_reason).toBe("embed_and_synth_unavailable_keyword_bare");

    expect(outcome.degraded).toBe(true);
    expect(outcome.degraded_reason).toBe("embed_and_synth_unavailable_keyword_bare");
    expect(outcome.status).toBe("error");
    expect(outcome.keyword_only).toBe(true);
    expect(outcome.ann_candidate_ids).toEqual([]);
    expect(outcome.keyword_candidate_ids.length).toBeGreaterThan(0);
    expect(outcome.tokens.embed).toBe(0);
    expect(outcome.reranked_ids.length).toBeGreaterThan(0);
    expect(outcome.citation_ids).toEqual([]);
  });

  // ── Row 8: embed FAIL + rerank FAIL + synth FAIL ──────────────────────────
  it("row 8 (FAIL/FAIL/FAIL) — keyword-only + skip rerank + chunks_only; embed_rerank_synth_unavailable_keyword_bare", async () => {
    await seedFourEntries(pool);
    const deps = buildRealDbDeps(pool, {
      embedder: buildEmbedder({ fail: true }),
      reranker: buildReranker({ fail: true }),
      synth: buildSynth({ fail: true, cite: [] }),
    });

    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: QUERY, role: "admin" }),
    );

    expect(events.map((e) => e.kind)).toEqual(["candidates", "chunks_only"]);
    const chunksEv = events[1] as { kind: "chunks_only"; degraded_reason?: string };
    expect(chunksEv.degraded_reason).toBe("embed_rerank_synth_unavailable_keyword_bare");

    expect(outcome.degraded).toBe(true);
    expect(outcome.degraded_reason).toBe("embed_rerank_synth_unavailable_keyword_bare");
    expect(outcome.status).toBe("error");
    expect(outcome.keyword_only).toBe(true);
    // ANN empty → discriminates row 8 from row 4.
    expect(outcome.ann_candidate_ids).toEqual([]);
    expect(outcome.keyword_candidate_ids.length).toBeGreaterThan(0);
    expect(outcome.tokens.embed).toBe(0);
    expect(outcome.citation_ids).toEqual([]);
  });

  // ── Special case 9: embed FAIL + keyword returns zero rows ────────────────
  it("special — embed FAIL + keyword empty → no_content + no_keyword_match_under_embed_outage", async () => {
    await seedFourEntries(pool);
    const deps = buildRealDbDeps(pool, { embedder: buildEmbedder({ fail: true }) });

    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: QUERY_ABSENT, role: "admin" }),
    );

    expect(events.map((e) => e.kind)).toEqual(["no_content"]);

    expect(outcome.degraded).toBe(true);
    expect(outcome.degraded_reason).toBe("no_keyword_match_under_embed_outage");
    expect(outcome.status).toBe("ok");
    expect(outcome.keyword_only).toBe(true);
    expect(outcome.ann_candidate_ids).toEqual([]);
    expect(outcome.keyword_candidate_ids).toEqual([]);
    expect(outcome.fused_ids).toEqual([]);
    expect(outcome.reranked_ids).toEqual([]);
    expect(outcome.citation_ids).toEqual([]);
    expect(outcome.tokens.embed).toBe(0);
  });

  // ── Role-derived sensitivity propagation. Pins the EXPECTED array values
  // hardcoded (not via `sensitivityAllowedForRole(role)` — that would make
  // the assertion circular against the orchestrator's own resolution path)
  // so a bug in the role→array mapping that returned `["public"]` for both
  // roles, or `[...all three]` for both, is caught here. The full
  // restricted/internal SQL WHERE flip end-to-end is shape β (next session).
  it("sensitivity_allowed array reflects the requested role on the outcome", async () => {
    await seedFourEntries(pool);
    const deps = buildRealDbDeps(pool, {});

    const adminRun = await drainPipeline(
      retrievePipeline(deps, { query: QUERY, role: "admin" satisfies Role }),
    );
    expect(adminRun.outcome.sensitivity_allowed).toEqual(["public", "internal", "restricted"]);
    expect(adminRun.outcome.status).toBe("ok");

    const userRun = await drainPipeline(
      retrievePipeline(deps, { query: QUERY, role: "user" satisfies Role }),
    );
    // NOTE: lib/auth.ts:189 currently maps user→["public"] only, which
    // departs from ADR-0012 §6 ("user → [public, internal]") + CLAUDE.md
    // non-negotiable #6. This test pins the IMPLEMENTATION, not the spec.
    // Doc-vs-code drift surfaced in this session — BACKLOG follow-up.
    expect(userRun.outcome.sensitivity_allowed).toEqual(["public"]);
    expect(userRun.outcome.status).toBe("ok");
    // user still gets the public entries (all 4 seeded are public).
    expect(userRun.outcome.ann_candidate_ids.length).toBeGreaterThan(0);
    expect(userRun.outcome.keyword_candidate_ids.length).toBeGreaterThan(0);
  });
});
