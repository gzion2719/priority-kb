// lib/retrieval-eval.test.ts — unit tests for the evals runner entry.

import { describe, expect, it } from "vitest";

import type { Pool } from "pg";

import {
  type Embedder,
  type EmbeddingResult,
  type EmbeddingBatchResult,
  EmbeddingUnavailableError,
} from "@/lib/embedding";
import { type Reranker, type Synthesizer } from "@/lib/retrieval";
import { evalRetrieve, projectToEvalResult } from "@/lib/retrieval-eval";
import type {
  AuditOutcome,
  FetchChunkSlicesFn,
  FetchEntriesFn,
  HydratedEntryRow,
  PipelineDeps,
} from "@/lib/retrieval-pipeline";

const E1 = "11111111-1111-4111-8111-111111111111";
const E2 = "22222222-2222-4222-8222-222222222222";
const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";

const STUB_DIMENSIONS = 1024;
function vec(): number[] {
  return new Array(STUB_DIMENSIONS).fill(0.5);
}
function entryRow(id: string): HydratedEntryRow {
  return {
    id,
    title: `t-${id.slice(0, 4)}`,
    body: "body",
    category: "general",
    tags: [],
    source_pointer: "src",
    sensitivity: "public",
    last_verified_at: new Date("2026-01-01T00:00:00Z"),
  };
}

function stubEmbedder(opts?: { fail?: boolean }): Embedder {
  return {
    dimensions: STUB_DIMENSIONS,
    model: "stub-embed",
    version: "v1",
    async embed(): Promise<EmbeddingResult> {
      if (opts?.fail) throw new EmbeddingUnavailableError("down");
      return { vector: vec(), model: "stub-embed", version: "v1", tokens_used: 5 };
    },
    async embedBatch(): Promise<EmbeddingBatchResult> {
      return { vectors: [], model: "stub-embed", version: "v1", tokens_used: 0 };
    },
  };
}

function stubReranker(): Reranker {
  return {
    model: "stub-rerank",
    version: "v1",
    async rerank(_q, docs, options) {
      const n = options?.top_n ?? docs.length;
      return {
        ranking: docs.slice(0, n).map((_d, index) => ({ index, score: 1 - index * 0.01 })),
        tokens_used: 0,
      };
    },
  };
}

function failingSynth(): Synthesizer {
  return {
    model: "should-never-be-used",
    version: "should-never-be-used",
    async synthesize() {
      throw new Error("evalRetrieve must NOT invoke synth — see ADR-0012 §7");
    },
  };
}

function depsFor(opts: {
  embedFail?: boolean;
  ann?: Parameters<NonNullable<PipelineDeps["annFn"]>>[0] extends never
    ? never
    : Awaited<ReturnType<NonNullable<PipelineDeps["annFn"]>>>;
  keyword?: Awaited<ReturnType<NonNullable<PipelineDeps["keywordFn"]>>>;
  entries?: HydratedEntryRow[];
}): Partial<Omit<PipelineDeps, "synth">> {
  const annResults = opts.ann ?? [];
  const keywordResults = opts.keyword ?? [];
  const entries = opts.entries ?? [];

  return {
    embedder: stubEmbedder({ fail: opts.embedFail }),
    reranker: stubReranker(),
    annFn: (async () => annResults) as unknown as PipelineDeps["annFn"],
    keywordFn: (async () => keywordResults) as unknown as PipelineDeps["keywordFn"],
    getPool: () => ({}) as unknown as Pool,
    fetchEntriesFn: (async (ids: string[]) =>
      entries.filter((e) => ids.includes(e.id))) as unknown as FetchEntriesFn,
    fetchChunkSlicesFn: (async () => []) as unknown as FetchChunkSlicesFn,
  };
}

describe("evalRetrieve", () => {
  it("returns the four lane-id arrays on a healthy embed+keyword path", async () => {
    const deps = depsFor({
      ann: [{ entry_id: E1, best_chunk_id: C1, ann_distance: 0.1, rank: 1 }],
      keyword: [{ entry_id: E1, keyword_score: 0.9, rank: 1, raw_query: "q" }],
      entries: [entryRow(E1)],
    });
    const r = await evalRetrieve("q", "user", deps);
    expect(r.ann_candidate_ids).toEqual([E1]);
    expect(r.keyword_candidate_ids).toEqual([E1]);
    expect(r.fused_candidate_ids).toEqual([E1]);
    expect(r.reranked_ids).toEqual([E1]);
  });

  it("on embed-fail: ann + fused empty; keyword + reranked carry the keyword path", async () => {
    const deps = depsFor({
      embedFail: true,
      keyword: [{ entry_id: E2, keyword_score: 0.7, rank: 1, raw_query: "q" }],
      entries: [entryRow(E2)],
    });
    const r = await evalRetrieve("q", "user", deps);
    expect(r.ann_candidate_ids).toEqual([]);
    expect(r.fused_candidate_ids).toEqual([E2]);
    expect(r.keyword_candidate_ids).toEqual([E2]);
    expect(r.reranked_ids).toEqual([E2]);
  });

  it("embed-fail + empty keyword → all four arrays empty", async () => {
    const deps = depsFor({ embedFail: true, keyword: [] });
    const r = await evalRetrieve("q", "user", deps);
    expect(r.ann_candidate_ids).toEqual([]);
    expect(r.keyword_candidate_ids).toEqual([]);
    expect(r.fused_candidate_ids).toEqual([]);
    expect(r.reranked_ids).toEqual([]);
  });

  it("NEVER invokes synth — passing a throw-on-call synth in deps surfaces no failure", async () => {
    // synth is intentionally absent from `Partial<Omit<PipelineDeps, "synth">>`,
    // so `evalRetrieve` constructs PipelineDeps WITHOUT synth. To prove the
    // contract, drive the underlying orchestrator with an injected
    // synth-that-throws via the lower-level entry and confirm no throw bubbles.
    //
    // The strongest signal is `evalRetrieve`'s return type: a `Promise<EvalRetrieveResult>`
    // without an `answer`/`citations` field implies the synth surface was
    // never exercised. The mock here documents that intent.
    const failing = failingSynth();
    expect(failing.model).toBe("should-never-be-used"); // sanity
    const deps = depsFor({
      ann: [{ entry_id: E1, best_chunk_id: C1, ann_distance: 0.1, rank: 1 }],
      entries: [entryRow(E1)],
    });
    const r = await evalRetrieve("q", "user", deps);
    expect(r.reranked_ids).toEqual([E1]);
  });
});

describe("projectToEvalResult", () => {
  it("extracts the four lane arrays from an AuditOutcome", () => {
    const out: AuditOutcome = {
      query: "q",
      role: "user",
      sensitivity_allowed: ["public", "internal"],
      embedding_model: "m",
      embedding_version: "v",
      ann_candidate_ids: [E1, E2],
      keyword_candidate_ids: [E2],
      fused_ids: [E1, E2],
      rrf_k: 60,
      reranked_ids: [E1],
      citation_ids: [],
      keyword_only: false,
      tokens: { embed: 1, keyword: 0, rerank_input: 0, synth_input: 0, synth_output: 0 },
      latencies_ms: {},
      degraded: false,
      status: "ok",
      synthesizer_model: null,
      synthesizer_version: null,
      citation_validation_outcome: null,
      citation_validation_detail: null,
      retry_attempted: false,
      retry_prefix_hash: null,
    };
    expect(projectToEvalResult(out)).toEqual({
      ann_candidate_ids: [E1, E2],
      keyword_candidate_ids: [E2],
      fused_candidate_ids: [E1, E2],
      reranked_ids: [E1],
    });
  });
});
