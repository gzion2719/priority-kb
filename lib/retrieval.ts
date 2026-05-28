// lib/retrieval.ts — Reranker + Synthesizer interfaces (M3 item 3 foundation).
//
// Implements the type skeletons pinned in docs/adr/0012-retrieval-pipeline.md
// §"Type skeletons". No live SDK calls in this slice — only the deterministic
// stub providers + env-driven singleton factories, mirroring lib/embedding.ts.
// Voyage rerank-2 + Anthropic Sonnet adapters land in fresh-chat follow-up
// slices alongside the /api/retrieve route.
//
// Design notes:
// - Result types omit `model` / `version` — per ADR-0012 §"Type skeletons",
//   provenance lives on the interface instance (`Reranker.model`/`.version`),
//   not on each call's result. Audit-row attribution at the call site reads
//   from the singleton.
// - `tokens_used` / `tokens_in` / `tokens_out` on stub results return 0. Production
//   telemetry MUST filter on `model.startsWith("stub-")` to discriminate stub
//   runs from real-zero edge cases; do NOT treat 0 as a stub sentinel.
// - Stub scoring: uint32 from first 4 SHA-256 bytes / 2^32 gives 2^32 distinct
//   scores; explicit `(a.index - b.index)` tiebreaker keeps ranking byte-stable
//   across Node minor versions and CI runners (iron rule #8 spirit).
// - Stub synthesizer emits a syntactically-valid sentinel `Sources:` block
//   (zero-UUID v4). Citation regex validation at §5 passes; candidate-set
//   membership check fails downstream where appropriate, not in the format
//   validator. Tests that need the unhappy citation-validation path construct
//   their own stub, not the singleton.
// - Empty-docs / empty-context inputs return cleanly (`ranking: []`, valid
//   answer + Sources block), no throw — mirrors `Embedder.embedBatch([])`
//   behaviour at lib/embedding.test.ts.
// - Circuit-breaker knobs (RETRIEVAL_BREAKER_*) + RETRIEVAL_RERANK_MIN_COSINE
//   are deferred to the route-slice PR; they are consumed at the call site,
//   not at the interface boundary. Per ADR-0012 §"Type skeletons".

import { createHash } from "node:crypto";

import { createVoyageReranker } from "./retrieval-voyage-rerank";
import { createAnthropicSynthesizer } from "./retrieval-anthropic-synth";

/** Output of a single rerank call. Provenance via the `Reranker` instance, not here. */
export type RerankResult = {
  ranking: { index: number; score: number }[];
  tokens_used: number;
};

/** Output of a single synthesize call. Provenance via the `Synthesizer` instance, not here. */
export type SynthResult = {
  answer: string;
  tokens_in: number;
  tokens_out: number;
};

export interface Reranker {
  readonly model: string;
  readonly version: string;
  rerank(query: string, docs: string[], options?: { top_n?: number }): Promise<RerankResult>;
}

export interface Synthesizer {
  readonly model: string;
  readonly version: string;
  synthesize(prompt: string, context: string[]): Promise<SynthResult>;
}

/**
 * Thrown when a reranker is unreachable for transient reasons (Voyage 5xx,
 * timeout, etc.). Retrieval-pipeline code catches via `instanceof` to drive
 * the §3 degraded-mode matrix (rerank-down → ANN-only top-N to synth, per
 * ADR-0012). Config errors (unknown provider, missing env) throw plain
 * `RangeError` so they cannot be silently degraded.
 */
export class RerankUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RerankUnavailableError";
  }
}

/** Synth twin of RerankUnavailableError. Drives §3 synth-down degraded mode. */
export class SynthUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SynthUnavailableError";
  }
}

export const STUB_RERANK_MODEL = "stub-sha256-rerank";
export const STUB_RERANK_VERSION = "v1";

export const STUB_SYNTH_MODEL = "stub-sha256-synth";
export const STUB_SYNTH_VERSION = "v1";

/** Zero-UUID v4 — emitted by the stub Synthesizer to satisfy §5 format check. */
export const STUB_SYNTH_SENTINEL_UUID = "00000000-0000-4000-8000-000000000000";

/**
 * Deterministic stub reranker for tests + dev. Score derived from the first
 * four bytes of SHA-256(`query + doc_index + doc_text`) as a uint32 / 2^32,
 * giving a uniform [0, 1) score with 2^32 distinct values. Stable across
 * Node minor versions; explicit index tiebreaker keeps ordering deterministic
 * when scores collide (1-in-4-billion per pair, but the iron-rule-#8 spirit
 * is byte-stability, so the tiebreak is load-bearing).
 *
 * Honors `options.top_n` by truncating the sorted ranking; default returns all docs.
 * `tokens_used = 0` by contract — see file header re: telemetry discriminator.
 */
export function createStubReranker(): Reranker {
  const model = STUB_RERANK_MODEL;
  const version = STUB_RERANK_VERSION;

  function scoreFor(query: string, index: number, doc: string): number {
    const h = createHash("sha256");
    h.update(query);
    h.update(String(index));
    h.update(doc);
    const digest = h.digest();
    const u32 =
      ((digest[0] << 24) >>> 0) +
      ((digest[1] << 16) >>> 0) +
      ((digest[2] << 8) >>> 0) +
      (digest[3] >>> 0);
    return u32 / 0x1_0000_0000;
  }

  return {
    model,
    version,
    async rerank(
      query: string,
      docs: string[],
      options?: { top_n?: number },
    ): Promise<RerankResult> {
      const scored = docs.map((doc, index) => ({
        index,
        score: scoreFor(query, index, doc),
      }));
      scored.sort((a, b) => b.score - a.score || a.index - b.index);
      const top_n = options?.top_n;
      const ranking = typeof top_n === "number" && top_n >= 0 ? scored.slice(0, top_n) : scored;
      return { ranking, tokens_used: 0 };
    },
  };
}

/**
 * Deterministic stub synthesizer for tests + dev. Answer derived from
 * SHA-256(`prompt + context.join("|")`); the first 8 hex chars of the digest
 * are appended as a verification handle.
 *
 * Emits a syntactically-valid trailing `Sources:` block containing the
 * zero-UUID v4 sentinel. The §5 format regex passes; downstream candidate-set
 * membership check fails — the right layer to surface a citation-set issue.
 * Tests that need to drive the format-fail path construct their own stub
 * (not the singleton).
 *
 * `tokens_in = tokens_out = 0` by contract.
 */
export function createStubSynthesizer(): Synthesizer {
  const model = STUB_SYNTH_MODEL;
  const version = STUB_SYNTH_VERSION;

  return {
    model,
    version,
    async synthesize(prompt: string, context: string[]): Promise<SynthResult> {
      const h = createHash("sha256");
      h.update(prompt);
      h.update(context.join("|"));
      const handle = h.digest("hex").slice(0, 8);
      const answer = `stub-answer: ${handle}\n\nSources: [${STUB_SYNTH_SENTINEL_UUID}]`;
      return { answer, tokens_in: 0, tokens_out: 0 };
    },
  };
}

declare global {
  var __reranker: Reranker | undefined;
  var __synthesizer: Synthesizer | undefined;
}

/**
 * Env-driven reranker factory. Reads `process.env.RERANK_PROVIDER`:
 * - unset or `"stub"` → deterministic stub.
 * - `"voyage"` → reads `process.env.VOYAGE_API_KEY`. Missing key throws
 *   `RangeError` (iron rule #1 floor: misconfig surfaces loud at the
 *   factory boundary, never as transient `RerankUnavailableError` that
 *   would mask it as a degraded-mode outage). VOYAGE_API_KEY is the
 *   SAME key Voyage uses for embeddings — when the embedder voyage
 *   branch wires (M2a follow-up), both factories read it. A future
 *   rename would need to update both sites.
 * - any other value → throws `RangeError` (fail-loud, no silent fallback).
 *
 * Cached on `globalThis.__reranker`. Use `resetRerankerForTests()` between
 * tests that need a fresh resolution. Mirrors `getEmbedder()`.
 *
 * The bare-package-name string for the Voyage SDK is forbidden in THIS
 * file by the source-file scan at lib/retrieval.test.ts:298 (iron rule #8
 * floor). The adapter file `./retrieval-voyage-rerank` owns the Voyage URL
 * and the SDK-namespace literals.
 */
export function getReranker(): Reranker {
  if (!globalThis.__reranker) {
    const provider = process.env.RERANK_PROVIDER ?? "stub";
    if (provider === "stub") {
      globalThis.__reranker = createStubReranker();
    } else if (provider === "voyage") {
      if (!process.env.VOYAGE_API_KEY) {
        throw new RangeError(
          `missing VOYAGE_API_KEY — required when RERANK_PROVIDER=voyage (iron rule #1)`,
        );
      }
      globalThis.__reranker = createVoyageReranker({ apiKey: process.env.VOYAGE_API_KEY });
    } else {
      throw new RangeError(`unknown RERANK_PROVIDER=${provider}; expected "stub" or "voyage"`);
    }
  }
  return globalThis.__reranker;
}

/**
 * Synth twin of `getReranker`. Reads `process.env.SYNTH_PROVIDER`:
 * - unset or `"stub"` → deterministic stub.
 * - `"anthropic"` → reads `process.env.ANTHROPIC_API_KEY`. Missing key
 *   throws `RangeError` (iron rule #1 floor: misconfig surfaces loud at the
 *   factory boundary, never as transient `SynthUnavailableError` that
 *   would mask it as a degraded-mode outage). The empty-key constructor
 *   guard inside `createAnthropicSynthesizer` provides a second floor for
 *   direct callers that bypass this factory.
 * - any other value → throws `RangeError` (fail-loud, no silent fallback).
 *
 * Cached on `globalThis.__synthesizer`. Use `resetSynthesizerForTests()`
 * between tests that need a fresh resolution.
 *
 * The Anthropic SDK bare-package-name string is forbidden in THIS file by
 * the source-file scan at lib/retrieval.test.ts:317 (iron rule #8 floor).
 * The adapter file `./retrieval-anthropic-synth` owns the SDK-namespace
 * literals; this file imports the factory function only.
 */
export function getSynthesizer(): Synthesizer {
  if (!globalThis.__synthesizer) {
    const provider = process.env.SYNTH_PROVIDER ?? "stub";
    if (provider === "stub") {
      globalThis.__synthesizer = createStubSynthesizer();
    } else if (provider === "anthropic") {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new RangeError(
          `missing ANTHROPIC_API_KEY — required when SYNTH_PROVIDER=anthropic (iron rule #1)`,
        );
      }
      globalThis.__synthesizer = createAnthropicSynthesizer({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    } else {
      throw new RangeError(`unknown SYNTH_PROVIDER=${provider}; expected "stub" or "anthropic"`);
    }
  }
  return globalThis.__synthesizer;
}

/** Clears the reranker singleton cache. Test-only. */
export function resetRerankerForTests(): void {
  globalThis.__reranker = undefined;
}

/**
 * Inject a fully-constructed `Reranker` into the singleton slot for the
 * duration of a test. Test-only. Symmetric with {@link setSynthesizerForTests};
 * see that JSDoc for the contract-boundary rationale. Use instead of reaching
 * directly into `globalThis.__reranker`.
 *
 * Pair with `resetRerankerForTests()` in `afterEach`. Pure setter — does
 * not touch process env.
 */
export function setRerankerForTests(reranker: Reranker): void {
  globalThis.__reranker = reranker;
}

/** Clears the synthesizer singleton cache. Test-only. */
export function resetSynthesizerForTests(): void {
  globalThis.__synthesizer = undefined;
}

/**
 * Inject a fully-constructed `Synthesizer` into the singleton slot for the
 * duration of a test. Test-only. Use instead of reaching directly into
 * `globalThis.__synthesizer` — this preserves the contract boundary, so a
 * future refactor that swaps the lazy-cache pattern for an env-re-resolution
 * scheme breaks here (in one place) rather than silently in every test file.
 *
 * Pair with `resetSynthesizerForTests()` in `afterEach`. Pure setter — does
 * not touch process env.
 */
export function setSynthesizerForTests(synth: Synthesizer): void {
  globalThis.__synthesizer = synth;
}

// ─── ADR-0013: hybrid keyword lane + RRF + degraded-matrix types ───────────────

// Degraded-reason enum + type live in lib/retrieval-degraded.ts (leaf
// module) so the UI-side reducer can consume them without dragging this
// file's DB/pool/auth-adjacent imports into the client bundle. Re-imported
// + re-exported here for backward-compat with callers that still import
// from `@/lib/retrieval` (and so the in-file `RetrievalAuditPayload` below
// can reference the type).
import { DEGRADED_REASON_CODES, type DegradedReasonCode } from "./retrieval-degraded";
export { DEGRADED_REASON_CODES, type DegradedReasonCode };

import type { CitationValidationResult } from "./retrieval-citations";

/**
 * Discriminator for the audit row's `citation_validation_outcome` field.
 * "ok" on first-or-second-attempt pass; one of the validator's failure-reason
 * values when both attempts failed. Null when validation never ran (synth was
 * absent, or the pipeline aborted before stage D).
 */
export type CitationValidationOutcome =
  | "ok"
  | Extract<CitationValidationResult, { ok: false }>["reason"];

/**
 * Per-reason payload carried on the audit row alongside the outcome
 * discriminant. The validator's discriminated-union failure variants carry
 * `offending_ids` (3 reasons), `inline_only`/`sources_only` (1 reason), a
 * `count` (1 reason), or a `trailing` excerpt (1 reason). Preserves the
 * validator's content for forensic replay + per-reason retry-prefix tuning.
 *
 * `null` when validation passed (no detail to record), when validation never
 * ran, or when the failure variant carries no auxiliary payload (e.g.
 * `sources_block_missing`).
 */
export type CitationValidationDetail =
  | null
  | { offending_ids: string[] }
  | { inline_only: string[]; sources_only: string[] }
  | { count: number }
  | { trailing: string };

/**
 * Audit-row payload shape after ADR-0013. Extends ADR-0012 §E with lane-id
 * arrays, the RRF k constant used at request time, and the keyword-only
 * derived flag.
 *
 * Iron rule #9 note: `embedding_model` + `embedding_version` are recorded
 * even on requests where the embedder call failed and stage A never produced
 * a vector. Semantics: "the embedder configured at request time" — preserves
 * shape stability so analytics SUM-by-embedder-version queries don't need
 * null-handling for the keyword-fallback path.
 */
export type RetrievalAuditPayload = {
  query: string;
  role: string;
  sensitivity_allowed: string[];
  /** Configured embedder model — recorded even if the call failed. Iron rule #9. */
  embedding_model: string;
  /** Configured embedder version — recorded even if the call failed. */
  embedding_version: string;
  /** Post-collapse entry_ids from ANN lane (replaces ADR-0012's flat candidate_ids). */
  ann_candidate_ids: string[];
  /** Entry_ids from stage B′ keyword lane. */
  keyword_candidate_ids: string[];
  /** Post-RRF entry_ids; up to 20 per ADR-0013 §2.4. */
  fused_ids: string[];
  /** RETRIEVAL_RRF_K env-knob value at request time, for retrospective tuning. */
  rrf_k: number;
  /** Post stage-C rerank, top-N=5. Subset of fused_ids on the healthy path. */
  reranked_ids: string[];
  /** Entry_ids cited by synth; subset of reranked_ids. */
  citation_ids: string[];
  /** True when stage A failed and B′ carried the request. */
  keyword_only: boolean;
  tokens: {
    embed: number;
    /** Always 0 — Postgres is local. Field exists for shape symmetry. */
    keyword: number;
    rerank_input: number;
    synth_input: number;
    synth_output: number;
  };
  latencies_ms?: Record<string, number>;
  degraded: boolean;
  degraded_reason?: DegradedReasonCode;
  // ── Sub-slice 2c-ii additions (orchestrator audit-outcome) ────────────────
  //
  // Pinned into the canonical audit-payload type so the orchestrator's
  // {@link AuditOutcome} return value IS this type (no projection / no drift).
  // Slice 2c-i wrote these fields onto a locally-scoped `AuditPayload` in
  // `app/api/retrieve/route.ts`; folding them in here is the M3/M4 alignment
  // called out in the 2c-ii plan-CR. ADR-0013 §5 audit-row pin authorizes
  // the audit-row shape; this type is the TS source of truth for it.
  /** Request outcome status. "error" on synth-down, citation-validation-failed (post-retry), and pre-stream config errors. */
  status: "ok" | "error";
  /** Optional human-readable error message; redacted before persistence (see route layer). */
  error?: string;
  /** Resolved synthesizer model — null when the orchestrator ran in eval mode (synth absent). */
  synthesizer_model: string | null;
  /** Resolved synthesizer version — null when the orchestrator ran in eval mode (synth absent). */
  synthesizer_version: string | null;
  /** Validator outcome discriminant; null when validation never ran. */
  citation_validation_outcome: CitationValidationOutcome | null;
  /** Per-reason payload from the final (post-retry) validation attempt. */
  citation_validation_detail: CitationValidationDetail;
  /** True iff the orchestrator invoked synth a second time with the stricter prefix. */
  retry_attempted: boolean;
  /** SHA-256 hex of {@link STRICTER_PROMPT_PREFIX} when retry fired; null otherwise. */
  retry_prefix_hash: string | null;
};

/** Internal-only retrieval result for the evals runner (ADR-0012 §7, ADR-0013 §2.5). */
export type EvalRetrieveResult = {
  ann_candidate_ids: string[];
  keyword_candidate_ids: string[];
  fused_candidate_ids: string[];
  reranked_ids: string[];
};

/**
 * Superset of {@link EvalRetrieveResult} for the citation_precision leg
 * (ADR-0012 §7 Amendment 2026-05-28). Adds `citation_ids` — the entry_ids
 * synth cited, validated by the orchestrator as a subset of `reranked_ids`.
 * Empty on any degraded / validation-failed / synth-down terminal (the
 * validator hard-fails the whole response; there is no partial-subset path),
 * which the eval runner reports as `skipped` for citation_precision.
 */
export type EvalRetrieveWithSynthResult = EvalRetrieveResult & {
  citation_ids: string[];
};

/** Input to `rrfFuse` — one entry per fusion lane, in caller-defined order. */
export type RrfLane = {
  /** Human-readable lane name for tie-break determinism + audit traceability. */
  name: string;
  /** Entry IDs in rank order, 1-indexed by position in the array. */
  rankedEntryIds: string[];
};

/** Per-entry fusion output. */
export type RrfFusedEntry = {
  entry_id: string;
  /** Sum of `1 / (k + rank_lane)` across all lanes the entry appeared in. */
  score: number;
};

/**
 * Reciprocal Rank Fusion (Cormack, Clarke, Buettcher 2009; tuned for top-K=20
 * lanes per Bruch et al. 2023 — see ADR-0013 §2.4). Score:
 *
 *   RRF(d) = Σ_lane  1 / (k + rank_lane(d))
 *
 * with rank_lane(d) the 1-indexed position of d in lane.rankedEntryIds, or
 * the term omitted if d is absent from the lane.
 *
 * Tie-break: equal-score entries are ordered by (1) first lane the entry
 * appears in (in the input `lanes` array order), then (2) the entry's rank
 * within that lane. This makes ordering deterministic and dependency-free
 * (no UUID sort, no `Math.random`).
 *
 * Throws RangeError on `k` outside [1, 1000] (matches the env-knob bound
 * declared in ADR-0013 §2.4) or `limit` outside [1, 1000]. Empty input lanes
 * are allowed; a missing entry from a lane contributes 0 to its score.
 */
export function rrfFuse(lanes: RrfLane[], k: number, limit = 20): RrfFusedEntry[] {
  if (!Number.isInteger(k) || k < 1 || k > 1000) {
    throw new RangeError(`rrfFuse: k must be an integer in [1, 1000]; got ${k}`);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError(`rrfFuse: limit must be an integer in [1, 1000]; got ${limit}`);
  }

  type Acc = { score: number; firstLaneIdx: number; firstLaneRank: number };
  const acc = new Map<string, Acc>();

  for (let laneIdx = 0; laneIdx < lanes.length; laneIdx++) {
    const ids = lanes[laneIdx]!.rankedEntryIds;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const rank = i + 1;
      const contribution = 1 / (k + rank);
      const prev = acc.get(id);
      if (prev) {
        prev.score += contribution;
      } else {
        acc.set(id, { score: contribution, firstLaneIdx: laneIdx, firstLaneRank: rank });
      }
    }
  }

  const fused = Array.from(acc.entries()).map(([entry_id, v]) => ({
    entry_id,
    score: v.score,
    _firstLaneIdx: v.firstLaneIdx,
    _firstLaneRank: v.firstLaneRank,
  }));

  fused.sort(
    (a, b) =>
      b.score - a.score || a._firstLaneIdx - b._firstLaneIdx || a._firstLaneRank - b._firstLaneRank,
  );

  return fused.slice(0, limit).map((e) => ({ entry_id: e.entry_id, score: e.score }));
}
