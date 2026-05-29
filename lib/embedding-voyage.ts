// lib/embedding-voyage.ts — Voyage `voyage-3-large` embedding adapter.
//
// Implements the `Embedder` interface from `./embedding` against Voyage's
// `/v1/embeddings` endpoint via direct `fetch`. The factory in `./embedding`
// statically imports this module on the `EMBEDDING_PROVIDER=voyage` branch;
// `./embedding` itself imports no SDK and contains no `voyageai` literal
// (mechanical floor at lib/embedding.test.ts:217-251). This file owns the
// Voyage URL and naming — the iron-rule-#8 source-scan in the companion test
// asserts THIS file reads no environment variables (env-truth lives at the
// factory boundary in ./embedding — the adapter takes the key by argument).
//
// Sibling adapter: lib/retrieval-voyage-rerank.ts (Voyage rerank-2). This file
// mirrors its shape deliberately — same direct-fetch rationale, same injected
// `fetchImpl` test seam, same error-mapping buckets. Keep them in sync.
//
// Why direct fetch, not the `voyageai` npm SDK:
// - Single endpoint (embeddings is one-shot, not streaming) — SDK buys ~zero.
// - Avoids a package-version pin to maintain alongside the existing drift floors.
// - Iron-rule-#8 test surface is smaller — adapter takes an injected
//   `fetchImpl?: typeof fetch`; tests pass a stub. No global-fetch spy leaks.
//
// Voyage embeddings API reference: https://docs.voyageai.com/reference/embeddings-api
//   POST /v1/embeddings  body: {input: string[], model, input_type?, output_dimension?}
//   200 response: {object, data: [{object, embedding: number[], index}], model,
//                  usage: {total_tokens}}
//   Auth: `Authorization: Bearer ${apiKey}`.
//
// Error mapping (mirrors retrieval-voyage-rerank.ts sibling shape):
// - 5xx Response   → EmbeddingUnavailableError  (transient; pipeline catches
//                    via instanceof to drive ADR-0012 §3 embed-down / iron #12).
// - 429 Response   → EmbeddingUnavailableError  (rate-limited; transient).
// - 408 Response   → EmbeddingUnavailableError  (edge-proxy idle timeout).
// - Network error  → EmbeddingUnavailableError  (fetch throws TypeError).
// - JSON-parse fail on a 5xx-categorized response → EmbeddingUnavailableError.
// - Other 4xx (400/401/403/404/422) → loud rethrow with status + body excerpt
//                    (iron rule #1 forbids silent degradation of config errors).
// - Malformed 200 body (missing .data / .usage.total_tokens, row missing
//                    .embedding/.index, data.length != input.length, or a
//                    returned vector whose length != 1024) → loud Error.

import {
  type EmbedOptions,
  type Embedder,
  type EmbeddingBatchResult,
  type EmbeddingResult,
  EmbeddingUnavailableError,
} from "./embedding";

/** Voyage embedding model id pinned per ADR-0009 §2 / ROADMAP M1 line 18. */
export const VOYAGE_EMBED_MODEL = "voyage-3-large";

/**
 * Voyage REST API version (path segment `/v1/`). Recorded as the embedder's
 * `version` and propagated to `chunks.embedding_version` (iron rule #9). Voyage
 * doesn't publish embedding model snapshot ids on a stable contract; the API
 * version is the most honest re-run-stable identifier — mirrors the rerank
 * adapter's VOYAGE_RERANK_API_VERSION reasoning. Revisit if Voyage ships
 * snapshot ids.
 */
export const VOYAGE_EMBED_API_VERSION = "v1";

/** Output dimensions. MUST equal `vector(1024)` in drizzle/schema.ts AND
 *  `STUB_DIMENSIONS` in ./embedding — a mismatch fails the chunk insert.
 *  Pinned in the request body + asserted on every returned row. Held as a
 *  literal (NOT `STUB_DIMENSIONS`) because ./embedding imports THIS module, so
 *  a top-level reference back into it hits the import-cycle TDZ. The companion
 *  test asserts equality with `STUB_DIMENSIONS` to keep the contract pinned. */
export const VOYAGE_EMBED_DIMENSIONS = 1024;

/** Voyage embeddings endpoint. The `/v1/` segment is the API version. */
const VOYAGE_EMBED_URL = "https://api.voyageai.com/v1/embeddings";

/** Max bytes of upstream response body echoed into error messages. */
const ERROR_BODY_EXCERPT_LIMIT = 200;

/** 4xx codes that represent transient edge outage (idle timeout, rate-limit). */
const TRANSIENT_4XX_STATUSES = new Set<number>([408, 429]);

export type CreateVoyageEmbedderOptions = {
  apiKey: string;
  /** Inject a fetch implementation for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
};

/** Per-row shape in Voyage's /v1/embeddings `data` array. */
type VoyageEmbeddingRow = {
  embedding: number[];
  index: number;
};

/** Full response body shape for the happy path. */
type VoyageEmbeddingResponse = {
  data: VoyageEmbeddingRow[];
  model: string;
  usage: { total_tokens: number };
};

/**
 * Build a Voyage `voyage-3-large` embedder. Caller injects the API key —
 * the factory boundary at `lib/embedding.ts` is the single source of env
 * truth, mirroring the lib/retrieval.ts → lib/retrieval-voyage-rerank.ts split.
 * The adapter never reads the env namespace directly (asserted by the source-file
 * scan in the companion test).
 */
export function createVoyageEmbedder(options: CreateVoyageEmbedderOptions): Embedder {
  const apiKey = options.apiKey;
  // Iron-rule-#1 mirror: the factory already throws on missing key, but a
  // direct caller could bypass it — guard at construction so the "ghost
  // adapter with empty Bearer header" surfaces here, not as a Voyage 401.
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new RangeError("createVoyageEmbedder: apiKey must be a non-empty string");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const model = VOYAGE_EMBED_MODEL;
  const version = VOYAGE_EMBED_API_VERSION;
  const dimensions = VOYAGE_EMBED_DIMENSIONS;

  async function embedBatch(
    texts: string[],
    embedOptions?: EmbedOptions,
  ): Promise<EmbeddingBatchResult> {
    // Empty input: short-circuit. Mirrors createStubEmbedder's map-over-empty
    // and the rerank adapter's empty-docs short-circuit. Voyage 400s on empty
    // `input`; no HTTP call, no token spend.
    if (texts.length === 0) {
      return { vectors: [], model, version, tokens_used: 0 };
    }

    // Exact-keys body. `input_type` engages Voyage's asymmetric query/document
    // mode (ADR-0012 §"Stage A": mis-tagging halves recall). Default "document"
    // so M2a ingest call sites (which pass no options) embed as documents.
    // `output_dimension` is pinned to match vector(1024); voyage-3-large also
    // supports 256/512/2048, so an explicit pin is load-bearing.
    const requestBody = {
      input: texts,
      model,
      input_type: embedOptions?.input_type ?? "document",
      output_dimension: dimensions,
    };

    let response: Response;
    try {
      response = await fetchImpl(VOYAGE_EMBED_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      // Network error (DNS, connect refused, TLS) — fetch rejects with
      // TypeError. Map to transient unavailable per iron rule #12. Fetch
      // TypeError messages carry URL + cause only — never headers/body — so
      // no apiKey leak via err.message.
      throw new EmbeddingUnavailableError(
        `voyage embeddings network error: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    // STATUS-BRANCH FIRST, parse SECOND. A 502 edge proxy returning text/html
    // makes response.json() throw — we want that to inherit the status bucket
    // (5xx → unavailable), not leak as a loud config error.
    if (TRANSIENT_4XX_STATUSES.has(response.status) || response.status >= 500) {
      let bodyExcerpt = "";
      try {
        bodyExcerpt = (await response.text()).slice(0, ERROR_BODY_EXCERPT_LIMIT);
      } catch {
        // Body unreadable — message still carries status.
      }
      throw new EmbeddingUnavailableError(`voyage embeddings ${response.status}: ${bodyExcerpt}`);
    }

    if (!response.ok) {
      // 4xx other than TRANSIENT_4XX_STATUSES — auth / permissions / bad
      // request. Iron rule #1 forbids silent degradation of config errors.
      let bodyExcerpt = "";
      try {
        bodyExcerpt = (await response.text()).slice(0, ERROR_BODY_EXCERPT_LIMIT);
      } catch {
        // ignore
      }
      const err = new Error(`voyage embeddings ${response.status}: ${bodyExcerpt}`) as Error & {
        status?: number;
      };
      err.status = response.status;
      throw err;
    }

    let parsed: VoyageEmbeddingResponse;
    try {
      parsed = (await response.json()) as VoyageEmbeddingResponse;
    } catch (err) {
      throw new Error(
        `voyage embeddings malformed response: JSON parse failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    if (!parsed || !Array.isArray(parsed.data)) {
      throw new Error("voyage embeddings malformed response: missing .data array");
    }
    if (!parsed.usage || typeof parsed.usage.total_tokens !== "number") {
      throw new Error("voyage embeddings malformed response: missing .usage.total_tokens");
    }
    // Row count MUST equal input count — a short response would silently
    // misalign vectors[] against the input texts (and the caller's chunk rows).
    if (parsed.data.length !== texts.length) {
      throw new Error(
        `voyage embeddings malformed response: data.length=${parsed.data.length} != input.length=${texts.length}`,
      );
    }

    // Reorder by .index — Voyage documents preserve order, but the contract
    // carries an index so we sort defensively rather than trust positional
    // order. After sort, vectors[i] corresponds to texts[i].
    const vectors = new Array<number[]>(texts.length);
    for (let i = 0; i < parsed.data.length; i++) {
      const row = parsed.data[i];
      if (!row || typeof row.index !== "number" || !Array.isArray(row.embedding)) {
        throw new Error(`voyage embeddings malformed response: data[${i}] missing index/embedding`);
      }
      if (row.index < 0 || row.index >= texts.length) {
        throw new Error(
          `voyage embeddings malformed response: data[${i}].index=${row.index} out of range [0, ${texts.length})`,
        );
      }
      if (row.embedding.length !== dimensions) {
        throw new Error(
          `voyage embeddings malformed response: data[${i}].embedding length=${row.embedding.length} != ${dimensions}`,
        );
      }
      if (vectors[row.index] !== undefined) {
        throw new Error(`voyage embeddings malformed response: duplicate index ${row.index}`);
      }
      vectors[row.index] = row.embedding;
    }

    return {
      vectors,
      model,
      version,
      // Voyage's usage.total_tokens is billing-authoritative (iron rule #9 cost
      // attribution). Downstream LogEvent consumers MUST NOT recompute.
      tokens_used: parsed.usage.total_tokens,
    };
  }

  return {
    dimensions,
    model,
    version,
    async embed(text: string, embedOptions?: EmbedOptions): Promise<EmbeddingResult> {
      // Sugar over embedBatch([text]) — mirrors createStubEmbedder. One row.
      const batch = await embedBatch([text], embedOptions);
      return {
        vector: batch.vectors[0]!,
        model: batch.model,
        version: batch.version,
        tokens_used: batch.tokens_used,
      };
    },
    embedBatch,
  };
}
