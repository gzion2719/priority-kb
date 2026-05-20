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
 * - `"voyage"` → throws `RangeError` (M3 item 3 route slice will wire the adapter).
 * - any other value → throws `RangeError` (fail-loud, no silent fallback).
 *
 * Cached on `globalThis.__reranker`. Use `resetRerankerForTests()` between
 * tests that need a fresh resolution. Mirrors `getEmbedder()`.
 */
export function getReranker(): Reranker {
  if (!globalThis.__reranker) {
    const provider = process.env.RERANK_PROVIDER ?? "stub";
    if (provider === "stub") {
      globalThis.__reranker = createStubReranker();
    } else if (provider === "voyage") {
      throw new RangeError(
        `RERANK_PROVIDER=voyage is not wired yet; the Voyage rerank-2 adapter lands with the M3 item 3 route slice`,
      );
    } else {
      throw new RangeError(
        `unknown RERANK_PROVIDER=${provider}; expected "stub" or (post-M3-item-3) "voyage"`,
      );
    }
  }
  return globalThis.__reranker;
}

/** Synth twin of `getReranker`. Reads `process.env.SYNTH_PROVIDER`. */
export function getSynthesizer(): Synthesizer {
  if (!globalThis.__synthesizer) {
    const provider = process.env.SYNTH_PROVIDER ?? "stub";
    if (provider === "stub") {
      globalThis.__synthesizer = createStubSynthesizer();
    } else if (provider === "anthropic") {
      throw new RangeError(
        `SYNTH_PROVIDER=anthropic is not wired yet; the Anthropic Sonnet adapter lands with the M3 item 3 route slice`,
      );
    } else {
      throw new RangeError(
        `unknown SYNTH_PROVIDER=${provider}; expected "stub" or (post-M3-item-3) "anthropic"`,
      );
    }
  }
  return globalThis.__synthesizer;
}

/** Clears the reranker singleton cache. Test-only. */
export function resetRerankerForTests(): void {
  globalThis.__reranker = undefined;
}

/** Clears the synthesizer singleton cache. Test-only. */
export function resetSynthesizerForTests(): void {
  globalThis.__synthesizer = undefined;
}
