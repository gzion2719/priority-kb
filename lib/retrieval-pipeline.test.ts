// lib/retrieval-pipeline.test.ts — 8-row ADR-0013 §3 matrix + edges.
//
// Pure unit tests against the orchestrator with all DB / SDK boundaries
// injected as PipelineDeps stubs — no Postgres, no Voyage, no Anthropic.
// Real-DB integration sits in a follow-up session per the 2c-ii plan.

import { describe, expect, it, vi } from "vitest";

import type { Pool } from "pg";

import {
  EmbeddingUnavailableError,
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
import type { QueryCandidate } from "@/lib/query-chat-state";
import type { AnnCandidate } from "@/lib/retrieval-ann";
import type { KeywordCandidate } from "@/lib/retrieval-keyword";
import {
  drainPipeline,
  mapDegradedReason,
  retrievePipeline,
  TOP_K_ANN,
  TOP_N_SYNTH,
  type FetchChunkSlicesFn,
  type FetchEntriesFn,
  type HydratedEntryRow,
  type PipelineDeps,
} from "@/lib/retrieval-pipeline";

// ── Fixture UUIDs (v4-valid) ───────────────────────────────────────────────
const E1 = "11111111-1111-4111-8111-111111111111";
const E2 = "22222222-2222-4222-8222-222222222222";
const E3 = "33333333-3333-4333-8333-333333333333";
const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const C2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";

const STUB_DIMENSIONS = 1024;
function vec(filler = 0.5): number[] {
  return new Array(STUB_DIMENSIONS).fill(filler);
}

// ── Helper builders ────────────────────────────────────────────────────────

function entryRow(id: string, body = "body text"): HydratedEntryRow {
  return {
    id,
    title: `title-${id.slice(0, 4)}`,
    body,
    category: "general",
    tags: ["tag1"],
    source_pointer: `src-${id.slice(0, 4)}`,
    sensitivity: "public",
    last_verified_at: new Date("2026-01-01T00:00:00Z"),
  };
}

function buildEmbedder(opts?: { fail?: boolean; model?: string; version?: string }): Embedder {
  const model = opts?.model ?? "stub-model";
  const version = opts?.version ?? "v1";
  return {
    dimensions: STUB_DIMENSIONS,
    model,
    version,
    async embed(_text: string, _options?: EmbedOptions): Promise<EmbeddingResult> {
      if (opts?.fail) throw new EmbeddingUnavailableError("embed down");
      return { vector: vec(), model, version, tokens_used: 7 };
    },
    async embedBatch(texts: string[]): Promise<EmbeddingBatchResult> {
      return {
        vectors: texts.map(() => vec()),
        model,
        version,
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
      // Preserve input order — assertions don't depend on rerank score order
      // so a stable mapping suffices.
      return {
        ranking: docs.slice(0, n).map((_d, index) => ({ index, score: 1 - index * 0.01 })),
        tokens_used: docs.length * 10,
      };
    },
  };
}

function buildSynth(opts: {
  fail?: boolean;
  answer?: string;
  // When `answer` not provided, generate `Sources: [<rerankedIds joined>]`
  // by intercepting the prompt's reranked-id context. Simpler: tests pass
  // `cite: string[]` and we emit answer with those IDs.
  cite?: string[];
  // Toggleable per-call answer for citation-retry tests.
  answers?: string[];
}): Synthesizer {
  let call = 0;
  return {
    model: "stub-synth",
    version: "v1",
    async synthesize(_prompt: string, _context: string[]) {
      if (opts.fail) throw new SynthUnavailableError("synth down");
      let answer: string;
      if (opts.answers) {
        answer = opts.answers[call] ?? opts.answers[opts.answers.length - 1]!;
        call += 1;
      } else if (opts.answer) {
        answer = opts.answer;
      } else if (opts.cite) {
        const ids = opts.cite;
        const inline = ids.map((id) => `claim [${id}].`).join(" ");
        answer = `${inline}\n\nSources: [${ids.join(", ")}]`;
      } else {
        answer = `body\n\nSources: []`;
      }
      return { answer, tokens_in: 100, tokens_out: 200 };
    },
  };
}

function buildDeps(opts: {
  embedder?: Embedder;
  reranker?: Reranker;
  synth?: Synthesizer | null; // null → omit (eval mode)
  ann?: AnnCandidate[];
  keyword?: KeywordCandidate[];
  entries?: HydratedEntryRow[];
  // returned chunk slice rows; defaults to empty (so keyword-only synth-rep fires).
  chunks?: Array<{ id: string; entry_id: string; content_start: number; content_end: number }>;
}): PipelineDeps {
  const embedder = opts.embedder ?? buildEmbedder();
  const reranker = opts.reranker ?? buildReranker();
  const annResults = opts.ann ?? [];
  const keywordResults = opts.keyword ?? [];
  const entries = opts.entries ?? [];
  const chunks = opts.chunks ?? [];

  const annFn = vi.fn(async () => annResults);
  const keywordFn = vi.fn(async () => keywordResults);
  const fetchEntriesFn: FetchEntriesFn = vi.fn(async (ids) =>
    entries.filter((e) => ids.includes(e.id)),
  );
  const fetchChunkSlicesFn: FetchChunkSlicesFn = vi.fn(async (chunkIds) =>
    chunks.filter((c) => chunkIds.includes(c.id)),
  );

  const deps: PipelineDeps = {
    embedder,
    reranker,
    ...(opts.synth === null ? {} : { synth: opts.synth ?? buildSynth({ cite: [E1] }) }),
    annFn: annFn as unknown as PipelineDeps["annFn"],
    keywordFn: keywordFn as unknown as PipelineDeps["keywordFn"],
    getPool: () => ({}) as unknown as Pool,
    fetchEntriesFn,
    fetchChunkSlicesFn,
  };
  return deps;
}

// ── mapDegradedReason ──────────────────────────────────────────────────────

describe("mapDegradedReason", () => {
  it("returns null on the all-healthy row", () => {
    expect(
      mapDegradedReason({ embedOk: true, rerankOk: true, synthOk: true, fusedNonEmpty: true }),
    ).toBeNull();
  });

  it("maps every (embed, rerank, synth) tuple to a distinct enum value", () => {
    const tuples = [
      [true, true, false, "synth_unavailable"],
      [true, false, true, "rerank_unavailable"],
      [true, false, false, "rerank_and_synth_unavailable"],
      [false, true, true, "embed_unavailable_keyword_fallback"],
      [false, false, true, "embed_and_rerank_unavailable_keyword_fallback"],
      [false, true, false, "embed_and_synth_unavailable_keyword_bare"],
      [false, false, false, "embed_rerank_synth_unavailable_keyword_bare"],
    ] as const;
    for (const [e, r, s, expected] of tuples) {
      expect(mapDegradedReason({ embedOk: e, rerankOk: r, synthOk: s, fusedNonEmpty: true })).toBe(
        expected,
      );
    }
  });

  it("returns no_keyword_match_under_embed_outage when embed-fail and fused empty", () => {
    expect(
      mapDegradedReason({ embedOk: false, rerankOk: true, synthOk: true, fusedNonEmpty: false }),
    ).toBe("no_keyword_match_under_embed_outage");
  });

  it("flip-positive: the empty-fused embed-OK case does not trigger the embed-outage code", () => {
    // Distinguishes the matrix mapper from one that conflates the two
    // empty-result paths.
    expect(
      mapDegradedReason({ embedOk: true, rerankOk: true, synthOk: true, fusedNonEmpty: false }),
    ).toBeNull();
  });
});

// ── 8-row matrix ───────────────────────────────────────────────────────────

describe("retrievePipeline — ADR-0013 §3 matrix", () => {
  it("row 1 (ok/ok/ok): full pipeline → answer_delta + done(degraded:absent)", async () => {
    const deps = buildDeps({
      ann: [{ entry_id: E1, best_chunk_id: C1, ann_distance: 0.1, rank: 1 }],
      keyword: [{ entry_id: E1, keyword_score: 0.8, rank: 1, raw_query: "q" }],
      entries: [entryRow(E1, "first body")],
      chunks: [{ id: C1, entry_id: E1, content_start: 0, content_end: 5 }],
      synth: buildSynth({ cite: [E1] }),
    });
    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: "q", role: "user" }),
    );
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["candidates", "answer_delta", "done"]);
    const done = events.find((e) => e.kind === "done")!;
    expect(done).toMatchObject({ kind: "done", citation_ids: [E1] });
    expect((done as { degraded?: boolean }).degraded).toBeUndefined();
    expect(outcome.degraded).toBe(false);
    expect(outcome.degraded_reason).toBeUndefined();
    expect(outcome.reranked_ids).toEqual([E1]);
    expect(outcome.citation_ids).toEqual([E1]);
    expect(outcome.citation_validation_outcome).toBe("ok");
    expect(outcome.retry_attempted).toBe(false);
    expect(outcome.retry_prefix_hash).toBeNull();
    expect(outcome.keyword_only).toBe(false);
    expect(outcome.status).toBe("ok");
  });

  it("row 2 (ok/ok/fail): chunks_only + degraded_reason=synth_unavailable", async () => {
    const deps = buildDeps({
      ann: [{ entry_id: E1, best_chunk_id: C1, ann_distance: 0.1, rank: 1 }],
      keyword: [],
      entries: [entryRow(E1)],
      chunks: [{ id: C1, entry_id: E1, content_start: 0, content_end: 4 }],
      synth: buildSynth({ fail: true }),
    });
    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: "q", role: "user" }),
    );
    const terminal = events[events.length - 1]!;
    expect(terminal.kind).toBe("chunks_only");
    expect((terminal as { degraded_reason?: string }).degraded_reason).toBe("synth_unavailable");
    expect(outcome.degraded).toBe(true);
    expect(outcome.degraded_reason).toBe("synth_unavailable");
    expect(outcome.status).toBe("error");
    expect(outcome.error).toMatch(/synth down/);
  });

  it("row 3 (ok/fail/ok): done with degraded_reason=rerank_unavailable", async () => {
    const deps = buildDeps({
      ann: [{ entry_id: E1, best_chunk_id: C1, ann_distance: 0.1, rank: 1 }],
      keyword: [],
      entries: [entryRow(E1)],
      chunks: [{ id: C1, entry_id: E1, content_start: 0, content_end: 4 }],
      reranker: buildReranker({ fail: true }),
      synth: buildSynth({ cite: [E1] }),
    });
    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: "q", role: "user" }),
    );
    expect(events.map((e) => e.kind)).toContain("done");
    const done = events.find((e) => e.kind === "done")! as {
      degraded?: boolean;
      degraded_reason?: string;
    };
    expect(done.degraded).toBe(true);
    expect(done.degraded_reason).toBe("rerank_unavailable");
    expect(outcome.degraded_reason).toBe("rerank_unavailable");
  });

  it("row 4 (ok/fail/fail): chunks_only + rerank_and_synth_unavailable", async () => {
    const deps = buildDeps({
      ann: [{ entry_id: E1, best_chunk_id: C1, ann_distance: 0.1, rank: 1 }],
      entries: [entryRow(E1)],
      chunks: [{ id: C1, entry_id: E1, content_start: 0, content_end: 4 }],
      reranker: buildReranker({ fail: true }),
      synth: buildSynth({ fail: true }),
    });
    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: "q", role: "user" }),
    );
    expect(events[events.length - 1]!.kind).toBe("chunks_only");
    expect(outcome.degraded_reason).toBe("rerank_and_synth_unavailable");
  });

  it("row 5 (fail/ok/ok): keyword-only fallback → done + embed_unavailable_keyword_fallback", async () => {
    const deps = buildDeps({
      embedder: buildEmbedder({ fail: true }),
      keyword: [{ entry_id: E2, keyword_score: 0.7, rank: 1, raw_query: "q" }],
      entries: [entryRow(E2, "second body")],
      synth: buildSynth({ cite: [E2] }),
    });
    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: "q", role: "user" }),
    );
    expect(outcome.keyword_only).toBe(true);
    expect(outcome.ann_candidate_ids).toEqual([]);
    expect(outcome.degraded_reason).toBe("embed_unavailable_keyword_fallback");
    const done = events.find((e) => e.kind === "done")! as {
      degraded?: boolean;
      degraded_reason?: string;
    };
    expect(done.degraded_reason).toBe("embed_unavailable_keyword_fallback");
  });

  it("row 6 (fail/fail/ok): keyword-only + rerank-skipped + synth ok", async () => {
    const deps = buildDeps({
      embedder: buildEmbedder({ fail: true }),
      reranker: buildReranker({ fail: true }),
      keyword: [{ entry_id: E2, keyword_score: 0.7, rank: 1, raw_query: "q" }],
      entries: [entryRow(E2)],
      synth: buildSynth({ cite: [E2] }),
    });
    const { outcome } = await drainPipeline(retrievePipeline(deps, { query: "q", role: "user" }));
    expect(outcome.degraded_reason).toBe("embed_and_rerank_unavailable_keyword_fallback");
  });

  it("row 7 (fail/ok/fail): chunks_only embed_and_synth_unavailable_keyword_bare", async () => {
    const deps = buildDeps({
      embedder: buildEmbedder({ fail: true }),
      keyword: [{ entry_id: E2, keyword_score: 0.7, rank: 1, raw_query: "q" }],
      entries: [entryRow(E2)],
      synth: buildSynth({ fail: true }),
    });
    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: "q", role: "user" }),
    );
    expect(events[events.length - 1]!.kind).toBe("chunks_only");
    expect(outcome.degraded_reason).toBe("embed_and_synth_unavailable_keyword_bare");
  });

  it("row 8 (fail/fail/fail): chunks_only embed_rerank_synth_unavailable_keyword_bare", async () => {
    const deps = buildDeps({
      embedder: buildEmbedder({ fail: true }),
      reranker: buildReranker({ fail: true }),
      keyword: [{ entry_id: E2, keyword_score: 0.7, rank: 1, raw_query: "q" }],
      entries: [entryRow(E2)],
      synth: buildSynth({ fail: true }),
    });
    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: "q", role: "user" }),
    );
    expect(events[events.length - 1]!.kind).toBe("chunks_only");
    expect(outcome.degraded_reason).toBe("embed_rerank_synth_unavailable_keyword_bare");
  });
});

// ── Edges ──────────────────────────────────────────────────────────────────

describe("retrievePipeline — edges", () => {
  it("citation retry passes on second attempt", async () => {
    const deps = buildDeps({
      ann: [{ entry_id: E1, best_chunk_id: C1, ann_distance: 0.1, rank: 1 }],
      entries: [entryRow(E1)],
      chunks: [{ id: C1, entry_id: E1, content_start: 0, content_end: 4 }],
      synth: buildSynth({
        answers: [
          // First attempt: missing Sources block → validation fail
          "claim without sources",
          // Second attempt: well-formed
          `claim [${E1}].\n\nSources: [${E1}]`,
        ],
      }),
    });
    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: "q", role: "user" }),
    );
    expect(outcome.retry_attempted).toBe(true);
    expect(outcome.retry_prefix_hash).not.toBeNull();
    expect(outcome.citation_validation_outcome).toBe("ok");
    expect(events.map((e) => e.kind)).toEqual(["candidates", "answer_delta", "done"]);
  });

  it("citation retry fails twice → chunks_only + degraded_reason=citation_validation_failed", async () => {
    const deps = buildDeps({
      ann: [{ entry_id: E1, best_chunk_id: C1, ann_distance: 0.1, rank: 1 }],
      entries: [entryRow(E1)],
      chunks: [{ id: C1, entry_id: E1, content_start: 0, content_end: 4 }],
      synth: buildSynth({
        answers: ["no sources block", "also no sources block"],
      }),
    });
    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: "q", role: "user" }),
    );
    const terminal = events[events.length - 1]!;
    expect(terminal.kind).toBe("chunks_only");
    expect((terminal as { degraded_reason?: string }).degraded_reason).toBe(
      "citation_validation_failed",
    );
    expect(outcome.degraded_reason).toBe("citation_validation_failed");
    expect(outcome.retry_attempted).toBe(true);
    expect(outcome.citation_validation_outcome).toBe("sources_block_missing");
    // Distinguish from "validation never ran" — flip-positive that the
    // discriminant carries the failure reason, not null.
    expect(outcome.citation_validation_outcome).not.toBeNull();
    // Plan-CR B1: post-retry validation failure tags the audit row as an
    // error outcome per the RetrievalAuditPayload.status JSDoc contract.
    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("citation_validation_failed");
  });

  it("embed-fail + empty keyword → no_content event carries degraded_reason", async () => {
    const deps = buildDeps({
      embedder: buildEmbedder({ fail: true }),
      keyword: [],
    });
    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: "q", role: "user" }),
    );
    // Strict event-object equality — proves the wire surface carries the
    // reason. The all-healthy-empty test below is the flip-positive: same
    // event kind, NO degraded_reason field. Dropping the `if (!embedOk)`
    // branch in retrieval-pipeline.ts would make this test fail (yielded
    // event would be bare).
    expect(events).toEqual([
      { kind: "no_content", degraded_reason: "no_keyword_match_under_embed_outage" },
    ]);
    expect(outcome.degraded).toBe(true);
    expect(outcome.degraded_reason).toBe("no_keyword_match_under_embed_outage");
    // Audit row + wire event MUST agree on the reason — replay
    // reconstructability + UI/audit symmetry. A regression that hardcoded
    // a different reason on one surface but not the other would slip past
    // either assertion alone.
    const noContentEvent = events[0];
    if (noContentEvent.kind !== "no_content") throw new Error("expected no_content");
    expect(noContentEvent.degraded_reason).toBe(outcome.degraded_reason);
  });

  it("embed-ok + both lanes empty → bare no_content (NOT no_keyword_match_under_embed_outage)", async () => {
    // Flip-positive against the previous test: same event kind, but the
    // wire shape MUST be bare — a regression that always set the reason
    // would break this and the previous test would not catch it (the
    // previous test asserts presence, not exclusivity).
    const deps = buildDeps({ ann: [], keyword: [] });
    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: "q", role: "user" }),
    );
    expect(events).toEqual([{ kind: "no_content" }]);
    expect(outcome.degraded).toBe(false);
    expect(outcome.degraded_reason).toBeUndefined();
  });

  it("eval mode (synth omitted): no done/answer_delta/chunks_only emitted; outcome.reranked_ids populated", async () => {
    const deps = buildDeps({
      synth: null,
      ann: [{ entry_id: E1, best_chunk_id: C1, ann_distance: 0.1, rank: 1 }],
      entries: [entryRow(E1)],
      chunks: [{ id: C1, entry_id: E1, content_start: 0, content_end: 4 }],
    });
    const { events, outcome } = await drainPipeline(
      retrievePipeline(deps, { query: "q", role: "user" }),
    );
    // Only `candidates` may reach the wire in eval mode; `done`/`answer_delta`/`chunks_only` MUST NOT.
    const kinds = events.map((e) => e.kind);
    expect(kinds).not.toContain("done");
    expect(kinds).not.toContain("answer_delta");
    expect(kinds).not.toContain("chunks_only");
    expect(outcome.reranked_ids).toEqual([E1]);
    expect(outcome.citation_ids).toEqual([]);
    expect(outcome.synthesizer_model).toBeNull();
    expect(outcome.synthesizer_version).toBeNull();
    expect(outcome.retry_attempted).toBe(false);
    expect(outcome.citation_validation_outcome).toBeNull();
  });

  it("iron rule #9: embed-fail still records configured embedder model+version", async () => {
    const deps = buildDeps({
      embedder: buildEmbedder({ fail: true, model: "voyage-3-large", version: "2024-09" }),
      keyword: [{ entry_id: E2, keyword_score: 0.7, rank: 1, raw_query: "q" }],
      entries: [entryRow(E2)],
      synth: buildSynth({ cite: [E2] }),
    });
    const { outcome } = await drainPipeline(retrievePipeline(deps, { query: "q", role: "user" }));
    expect(outcome.embedding_model).toBe("voyage-3-large");
    expect(outcome.embedding_version).toBe("2024-09");
  });

  it("iron rule #6: sensitivity_allowed compiled per role and passed to keyword/ann fns", async () => {
    // Derive expected from the authoritative source (lib/auth.ts) — a
    // hardcoded literal would silently drift if the role→tier mapping ever
    // extends. Plan-CR M4 fix.
    const { sensitivityAllowedForRole } = await import("@/lib/auth");
    const expectedUser = sensitivityAllowedForRole("user");
    const annSpy = vi.fn(async () => []);
    const keywordSpy = vi.fn(async () => []);
    const deps: PipelineDeps = {
      ...buildDeps({}),
      annFn: annSpy as unknown as PipelineDeps["annFn"],
      keywordFn: keywordSpy as unknown as PipelineDeps["keywordFn"],
    };
    await drainPipeline(retrievePipeline(deps, { query: "q", role: "user" }));
    expect(annSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expectedUser,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(keywordSpy).toHaveBeenCalledWith(
      expect.anything(),
      "q",
      expectedUser,
      expect.anything(),
    );
  });

  it("admin role sees all three sensitivity tiers", async () => {
    const { sensitivityAllowedForRole } = await import("@/lib/auth");
    const expectedAdmin = sensitivityAllowedForRole("admin");
    const annSpy = vi.fn(async () => []);
    const keywordSpy = vi.fn(async () => []);
    const deps: PipelineDeps = {
      ...buildDeps({}),
      annFn: annSpy as unknown as PipelineDeps["annFn"],
      keywordFn: keywordSpy as unknown as PipelineDeps["keywordFn"],
    };
    await drainPipeline(retrievePipeline(deps, { query: "q", role: "admin" }));
    expect(annSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expectedAdmin,
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(keywordSpy).toHaveBeenCalledWith(
      expect.anything(),
      "q",
      expectedAdmin,
      expect.anything(),
    );
    // Flip-positive: admin's list contains "restricted"; user's does not.
    // Locks in the role distinction so a future regression that returned
    // the same list for both roles would still fail this test.
    expect(expectedAdmin).toContain("restricted");
  });

  it("rerank-down on keyword-only path produces keyword-rank synthInputs (deterministic order)", async () => {
    // Row 6: embed-fail + rerank-fail; synth-input order should follow
    // keyword rank, NOT some arbitrary boundary order.
    const deps = buildDeps({
      embedder: buildEmbedder({ fail: true }),
      reranker: buildReranker({ fail: true }),
      keyword: [
        { entry_id: E1, keyword_score: 0.9, rank: 1, raw_query: "q" },
        { entry_id: E2, keyword_score: 0.7, rank: 2, raw_query: "q" },
        { entry_id: E3, keyword_score: 0.5, rank: 3, raw_query: "q" },
      ],
      entries: [entryRow(E1), entryRow(E2), entryRow(E3)],
      synth: buildSynth({ cite: [E1, E2, E3] }),
    });
    const { outcome } = await drainPipeline(retrievePipeline(deps, { query: "q", role: "user" }));
    expect(outcome.reranked_ids).toEqual([E1, E2, E3]);
  });

  it("RRF fuses ANN+keyword lanes when embed ok", async () => {
    // ANN ranks: E1 > E2; keyword: E2 > E1.  RRF should surface both with
    // E1 likely first by tiebreak.
    const deps = buildDeps({
      ann: [
        { entry_id: E1, best_chunk_id: C1, ann_distance: 0.1, rank: 1 },
        { entry_id: E2, best_chunk_id: C2, ann_distance: 0.2, rank: 2 },
      ],
      keyword: [
        { entry_id: E2, keyword_score: 0.9, rank: 1, raw_query: "q" },
        { entry_id: E1, keyword_score: 0.8, rank: 2, raw_query: "q" },
      ],
      entries: [entryRow(E1), entryRow(E2)],
      chunks: [
        { id: C1, entry_id: E1, content_start: 0, content_end: 4 },
        { id: C2, entry_id: E2, content_start: 0, content_end: 4 },
      ],
      synth: buildSynth({ cite: [E1, E2] }),
    });
    const { outcome } = await drainPipeline(retrievePipeline(deps, { query: "q", role: "user" }));
    expect(outcome.fused_ids.sort()).toEqual([E1, E2].sort());
    expect(outcome.rrf_k).toBeGreaterThanOrEqual(1);
  });

  it("audit-row tokens.embed reflects stage-A tokens_used (not 0)", async () => {
    const deps = buildDeps({
      ann: [{ entry_id: E1, best_chunk_id: C1, ann_distance: 0.1, rank: 1 }],
      entries: [entryRow(E1)],
      chunks: [{ id: C1, entry_id: E1, content_start: 0, content_end: 4 }],
      synth: buildSynth({ cite: [E1] }),
    });
    const { outcome } = await drainPipeline(retrievePipeline(deps, { query: "q", role: "user" }));
    expect(outcome.tokens.embed).toBe(7);
    expect(outcome.tokens.synth_input).toBe(100);
    expect(outcome.tokens.synth_output).toBe(200);
  });

  it("audit-row tokens.embed=0 when stage A failed", async () => {
    // Flip-positive against the previous test — confirms embed_tokens is
    // ACTUALLY sourced from the stage A call's tokens_used, not a default.
    const deps = buildDeps({
      embedder: buildEmbedder({ fail: true }),
      keyword: [{ entry_id: E2, keyword_score: 0.7, rank: 1, raw_query: "q" }],
      entries: [entryRow(E2)],
      synth: buildSynth({ cite: [E2] }),
    });
    const { outcome } = await drainPipeline(retrievePipeline(deps, { query: "q", role: "user" }));
    expect(outcome.tokens.embed).toBe(0);
  });

  it("generator finalize: gen.return called from finally releases lane work", async () => {
    let keywordFnDone = false;
    const deps: PipelineDeps = {
      ...buildDeps({}),
      keywordFn: (async () => {
        keywordFnDone = true;
        return [];
      }) as unknown as PipelineDeps["keywordFn"],
    };
    const gen = retrievePipeline(deps, { query: "q", role: "user" });
    // Pull one event then abort via gen.return — `finally`-equivalent.
    await gen.next();
    await gen.return?.(undefined as never);
    // keywordFn has already been awaited inside the orchestrator before the
    // first yield, so this is documentation of the contract — the assertion
    // proves that the route's finalize-on-cancel doesn't crash even when the
    // generator has already advanced past lane work.
    expect(keywordFnDone).toBe(true);
  });
});

// ── drainPipelineEvents ────────────────────────────────────────────────────

describe("drainPipelineEvents", () => {
  it("invokes onEvent per yielded event and returns terminal outcome", async () => {
    const { drainPipelineEvents } = await import("@/lib/retrieval-pipeline");
    const deps = buildDeps({
      ann: [{ entry_id: E1, best_chunk_id: C1, ann_distance: 0.1, rank: 1 }],
      entries: [entryRow(E1)],
      chunks: [{ id: C1, entry_id: E1, content_start: 0, content_end: 4 }],
      synth: buildSynth({ cite: [E1] }),
    });
    const seen: string[] = [];
    const outcome = await drainPipelineEvents(
      retrievePipeline(deps, { query: "q", role: "user" }),
      (ev) => seen.push(ev.kind),
    );
    expect(seen).toEqual(["candidates", "answer_delta", "done"]);
    expect(outcome.status).toBe("ok");
    expect(outcome.reranked_ids).toEqual([E1]);
  });
});

// ── Defensive: top-K + TOP_N constants exported for downstream invariants ──

describe("orchestrator constants", () => {
  it("matches ADR-0013 §2.3 K=20 + ADR-0012 §C top-N=5", () => {
    expect(TOP_K_ANN).toBe(20);
    expect(TOP_N_SYNTH).toBe(5);
  });
});

// ── M4 #6 candidates event — body_snippet/tags/source_pointer projection ───
//
// These tests pin the wire-shape extension shipped with the citation-
// hover-preview slice. The candidates event now carries three extra
// fields projected from `boundaries[].body` — the SAME text the reranker
// and synth see for each entry — so the hover popup matches what the
// model scored. See ADR-0012 Amendment 2026-05-26.

describe("retrievePipeline — candidates event hover-preview projection (M4 #6)", () => {
  it("ANN-best-chunk path: body_snippet is sliced from the entry body, no `# title` prefix", async () => {
    const body = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const deps = buildDeps({
      ann: [{ entry_id: E1, best_chunk_id: C1, ann_distance: 0.1, rank: 1 }],
      keyword: [{ entry_id: E1, keyword_score: 0.8, rank: 1, raw_query: "q" }],
      entries: [entryRow(E1, body)],
      // ANN-best-chunk slice covers the first 20 chars of the body. The
      // candidate snippet should reflect THAT slice, not the full body —
      // this is how the user sees what the model scored.
      chunks: [{ id: C1, entry_id: E1, content_start: 0, content_end: 20 }],
    });
    const { events } = await drainPipeline(retrievePipeline(deps, { query: "q", role: "user" }));
    const candidatesEvent = events.find((e) => e.kind === "candidates")!;
    const cand = (candidatesEvent as { entries: QueryCandidate[] }).entries[0]!;
    expect(cand.body_snippet).toBe("alpha beta gamma del"); // 20-char slice
    // Negative-assertion: ANN path must NEVER carry the synth-rep prefix.
    // A regression that always synthesised the keyword-rep would emit
    // "# title-...\n..." here.
    expect(cand.body_snippet.startsWith("# ")).toBe(false);
    expect(cand.tags).toEqual(["tag1"]);
    expect(cand.source_pointer).toBe(`src-${E1.slice(0, 4)}`);
  });

  it("keyword-only path: body_snippet has the `# title\\n` synth-rep prefix STRIPPED", async () => {
    // No ANN result for this entry — keyword-only path. boundaries[i].body
    // becomes synthesizeKeywordOnlyRepresentative output: `# title-...\n` +
    // body slice. The candidate snippet must strip the prefix so the
    // hover popup doesn't double the title (the card already shows it).
    const deps = buildDeps({
      ann: [],
      keyword: [{ entry_id: E1, keyword_score: 0.8, rank: 1, raw_query: "q" }],
      entries: [entryRow(E1, "the actual body text")],
      chunks: [],
    });
    const { events } = await drainPipeline(retrievePipeline(deps, { query: "q", role: "user" }));
    const candidatesEvent = events.find((e) => e.kind === "candidates")!;
    const cand = (candidatesEvent as { entries: QueryCandidate[] }).entries[0]!;
    // Prefix gone:
    expect(cand.body_snippet.startsWith("# ")).toBe(false);
    // Real body content present (the synth-rep wraps the whole body for
    // small inputs):
    expect(cand.body_snippet).toContain("the actual body text");
  });

  it("snippet caps at 240 chars with ellipsis on a long body (no orphan boundary)", async () => {
    const longBody = "x".repeat(300);
    const deps = buildDeps({
      ann: [{ entry_id: E1, best_chunk_id: C1, ann_distance: 0.1, rank: 1 }],
      keyword: [{ entry_id: E1, keyword_score: 0.8, rank: 1, raw_query: "q" }],
      entries: [entryRow(E1, longBody)],
      chunks: [{ id: C1, entry_id: E1, content_start: 0, content_end: 300 }],
    });
    const { events } = await drainPipeline(retrievePipeline(deps, { query: "q", role: "user" }));
    const cand = (events.find((e) => e.kind === "candidates") as { entries: QueryCandidate[] })
      .entries[0]!;
    // 240 chars + 1 ellipsis = 241 chars. A regression that returned the
    // raw 300-char body (or sliced without the ellipsis) fires here.
    expect(cand.body_snippet).toBe("x".repeat(240) + "…");
  });

  it("empty tags pass through as []; missing source has no effect (defensive shape)", async () => {
    const deps = buildDeps({
      ann: [{ entry_id: E1, best_chunk_id: C1, ann_distance: 0.1, rank: 1 }],
      keyword: [{ entry_id: E1, keyword_score: 0.8, rank: 1, raw_query: "q" }],
      entries: [
        {
          ...entryRow(E1, "body"),
          tags: [],
          source_pointer: "",
        },
      ],
      chunks: [{ id: C1, entry_id: E1, content_start: 0, content_end: 4 }],
    });
    const { events } = await drainPipeline(retrievePipeline(deps, { query: "q", role: "user" }));
    const cand = (events.find((e) => e.kind === "candidates") as { entries: QueryCandidate[] })
      .entries[0]!;
    expect(cand.tags).toEqual([]);
    expect(cand.source_pointer).toBe("");
  });
});
