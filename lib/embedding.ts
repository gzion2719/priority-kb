// lib/embedding.ts — embedding abstraction (M1 contract; no Voyage call yet).
//
// The interface every embedder must satisfy. The deterministic stub serves
// tests + dev; the real Voyage `voyage-3-large` adapter lives in
// `./embedding-voyage` and is selected via `EMBEDDING_PROVIDER=voyage`
// (M3 — the last acceptance gate). ROADMAP M1 line 18 / M3 acceptance.
//
// Design notes:
// - `embedBatch` is the primary surface — Voyage is batch-shaped and returns
//   a single aggregate `usage.total_tokens` per request (ADR-0009 §2). Each
//   chunk-per-call would inflate cost N×; the single-text `embed` is sugar
//   over `embedBatch([text])`.
// - `tokens_used` is wire-authoritative at the batch level so `lib/log.ts`'s
//   `LogEventVoyage.tokens` consumer can attribute cost per call without
//   inventing a sidecar (iron rule #9).
// - `dimensions` is fixed at 1024 to match `vector(1024)` in `drizzle/schema.ts`.
//   A mismatched stub would fail at insert; pinning at construction makes the
//   contract self-evident.
// - `EmbeddingUnavailableError` is the only typed error the contract surfaces.
//   Retrieval-layer code (M3) uses `instanceof` to decide between transient
//   degraded mode (iron rule #12) and config-error 500.
// - Async signature even for the sync stub: Voyage is HTTP and the contract
//   must match. Do not "simplify" to sync.
// - L2 normalization: Voyage vectors are L2-normalized. The stub's hash-derived
//   vectors are uniform-ish in [-1, 1], NOT norm-1. ANN recall on stub data
//   will not predict real-world recall — by design, since the stub exists for
//   pipeline correctness tests, not retrieval-quality eval (which lives on
//   real Voyage at M3).
// - Edge Runtime: this module is Node-only (singleton on `globalThis`, future
//   Voyage adapter will use `fetch` but pool credentials at startup). Do not
//   import from Edge route handlers.
// - Startup validation: `getEmbedder()` is lazy. A misconfigured prod env
//   first errors on the first ingest. M2a's `/api/ingest` should call
//   `getEmbedder()` once at module load to fail-loud at boot; that wiring
//   lands with the first real call site.
// - Mechanical floor for iron rule #8 (no live APIs in tests): this module
//   imports no Voyage / Anthropic client. The test asserts on the source file
//   so a future "just add the import here" mistake breaks the suite. ADR-0008
//   §9 names the heavier mechanical floor for M2a.

import { createHash } from "node:crypto";

// Static import of the Voyage adapter. SAFE against the iron-rule-#8
// source-scan in lib/embedding.test.ts: those regexes forbid the Voyage SDK
// bare-package-name (and an import specifier starting with it), but a relative
// path like "./embedding-voyage" matches none of them. The adapter file owns
// the Voyage URL + SDK-free fetch; this file adds no SDK-namespace literal.
// Mirrors lib/retrieval.ts → retrieval-voyage-rerank.
import { createVoyageEmbedder } from "./embedding-voyage";

/** Wire-authoritative embedder output. Iron rule #9 columns travel with the vector. */
export type EmbeddingResult = {
  vector: number[];
  model: string;
  version: string;
  tokens_used: number;
};

/** Batch-shaped output. `model`/`version`/`tokens_used` are batch-aggregate. */
export type EmbeddingBatchResult = {
  vectors: number[][];
  model: string;
  version: string;
  tokens_used: number;
};

/**
 * Per-call options. ADR-0012 §"Stage A" mandates `input_type:"query"` for
 * retrieval-side embedding to engage Voyage `voyage-3-large`'s asymmetric
 * query/document mode (mis-tagging halves recall). Optional + default
 * "document" so M2a ingest call sites are unaffected.
 *
 * The stub embedder IGNORES this option — its hash-derived vectors don't
 * model the query/document asymmetry. Stub-mode tests therefore can't
 * detect a future bug where retrieval is wired with `input_type:"document"`;
 * that floor lives on real Voyage at M3 acceptance.
 */
export type EmbedOptions = {
  input_type?: "query" | "document";
};

export interface Embedder {
  readonly dimensions: number;
  readonly model: string;
  readonly version: string;
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult>;
  embedBatch(texts: string[], options?: EmbedOptions): Promise<EmbeddingBatchResult>;
}

/**
 * Thrown when an embedder is unreachable for transient reasons (Voyage 5xx,
 * timeout, etc.). Retrieval (M3) catches this and falls back to keyword-only
 * search per non-negotiable #12. Config errors (unknown provider, missing
 * env) throw plain `RangeError` so they cannot be silently degraded.
 */
export class EmbeddingUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbeddingUnavailableError";
  }
}

export const STUB_DIMENSIONS = 1024;
export const STUB_MODEL = "stub-sha256";
export const STUB_VERSION = "v1";

/**
 * Deterministic stub embedder for tests + dev. Vector is a 1024-float expansion
 * of SHA-256(text). Byte-stable across NFC/NFD and any UTF-8 input. NOT
 * L2-normalized; do NOT compare recall numbers against real Voyage data.
 */
export function createStubEmbedder(): Embedder {
  const model = STUB_MODEL;
  const version = STUB_VERSION;
  const dimensions = STUB_DIMENSIONS;

  function vectorFor(text: string): number[] {
    // SHA-256 → 32 bytes. We need 1024 floats, so we hash the text + an
    // incrementing counter and concatenate, then map each byte to [-1, 1].
    const out = new Array<number>(dimensions);
    let written = 0;
    let counter = 0;
    while (written < dimensions) {
      const h = createHash("sha256");
      h.update(text);
      h.update(String(counter));
      const digest = h.digest();
      for (let i = 0; i < digest.length && written < dimensions; i++) {
        out[written++] = (digest[i] - 127.5) / 127.5;
      }
      counter++;
    }
    return out;
  }

  return {
    dimensions,
    model,
    version,
    // `_options` intentionally unused: the stub's hash-derived vectors don't
    // model Voyage's query/document asymmetry. Accepting the option keeps
    // the interface signature uniform so callers don't branch on the
    // embedder identity. See EmbedOptions JSDoc.
    async embed(text: string, _options?: EmbedOptions): Promise<EmbeddingResult> {
      return {
        vector: vectorFor(text),
        model,
        version,
        tokens_used: 0,
      };
    },
    async embedBatch(texts: string[], _options?: EmbedOptions): Promise<EmbeddingBatchResult> {
      return {
        vectors: texts.map(vectorFor),
        model,
        version,
        tokens_used: 0,
      };
    },
  };
}

declare global {
  var __embedder: Embedder | undefined;
}

/**
 * Env-driven embedder factory. Reads `process.env.EMBEDDING_PROVIDER`:
 * - unset or `"stub"` → deterministic stub.
 * - `"voyage"` → reads `process.env.VOYAGE_API_KEY`. Missing key throws
 *   `RangeError` (iron rule #1 floor: misconfig surfaces loud at the factory
 *   boundary, never as a transient `EmbeddingUnavailableError` that would mask
 *   it as a degraded-mode outage). VOYAGE_API_KEY is the SAME key the reranker
 *   uses — a future rename must update both `getEmbedder` and `getReranker`.
 * - any other value → throws `RangeError` (fail-loud, no silent fallback).
 *
 * Cached on `globalThis.__embedder` after first call. Use
 * `resetEmbedderForTests()` between tests that need a fresh resolution.
 *
 * The bare-package-name string for the Voyage SDK is forbidden in THIS file
 * by the source-file scan at lib/embedding.test.ts:217-251 (iron rule #8
 * floor). The adapter file `./embedding-voyage` owns the Voyage URL + naming.
 */
export function getEmbedder(): Embedder {
  if (!globalThis.__embedder) {
    const provider = process.env.EMBEDDING_PROVIDER ?? "stub";
    if (provider === "stub") {
      globalThis.__embedder = createStubEmbedder();
    } else if (provider === "voyage") {
      if (!process.env.VOYAGE_API_KEY) {
        throw new RangeError(
          `missing VOYAGE_API_KEY — required when EMBEDDING_PROVIDER=voyage (iron rule #1)`,
        );
      }
      globalThis.__embedder = createVoyageEmbedder({ apiKey: process.env.VOYAGE_API_KEY });
    } else {
      throw new RangeError(`unknown EMBEDDING_PROVIDER=${provider}; expected "stub" or "voyage"`);
    }
  }
  return globalThis.__embedder;
}

/** Clears the singleton cache. Test-only. Mirrors lib/db.ts's reset story. */
export function resetEmbedderForTests(): void {
  globalThis.__embedder = undefined;
}

/**
 * Inject a fully-constructed `Embedder` into the singleton slot for the
 * duration of a test. Test-only. Symmetric with the retrieval module's
 * `setRerankerForTests` / `setSynthesizerForTests`; the orchestrator slice
 * (2c-ii) drives the embed-down matrix rows by injecting an embedder whose
 * `embed()` throws `EmbeddingUnavailableError`, without touching env vars.
 *
 * Pair with `resetEmbedderForTests()` in `afterEach`. Pure setter — does
 * not touch process env.
 */
export function setEmbedderForTests(embedder: Embedder): void {
  globalThis.__embedder = embedder;
}
