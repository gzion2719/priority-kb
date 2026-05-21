// lib/retrieval-voyage-rerank.ts — Voyage rerank-2 adapter (M3 item 3 stage C).
//
// Implements the `Reranker` interface from `./retrieval` against Voyage's
// `/v1/rerank` endpoint via direct `fetch`. The factory in `./retrieval`
// statically imports this module on the `RERANK_PROVIDER=voyage` branch;
// `./retrieval` itself imports no SDK and contains no `voyageai` literal
// (mechanical floor at lib/retrieval.test.ts:289-302). This file owns the
// Voyage URL and naming.
//
// Why direct fetch, not the `voyageai` npm SDK:
// - Single endpoint (rerank is one-shot, not streaming) — SDK abstraction
//   buys ~zero.
// - Avoids a second package-version pin to maintain alongside
//   `@anthropic-ai/sdk` and the existing drift-floor test pattern.
// - Iron-rule-#8 test surface is smaller — adapter takes an injected
//   `fetchImpl?: typeof fetch`; tests pass a stub. No spy-on-global cleanup
//   leaks, no SDK to mock.
//
// Voyage rerank-2 API reference: https://docs.voyageai.com/docs/reranker
//   POST /v1/rerank  body: {query, documents, model, top_k?, return_documents?}
//   200 response: {object, data: [{index, relevance_score}], model, usage:{total_tokens}}
//   Auth: `Authorization: Bearer ${apiKey}`.
//
// Error mapping (mirrors lib/agents-anthropic.ts:237-252 sibling shape):
// - 5xx Response   → RerankUnavailableError  (transient; pipeline catches
//                    via instanceof to drive ADR-0012 §3 rerank-down row).
// - 429 Response   → RerankUnavailableError  (rate-limited; transient).
// - 408 Response   → RerankUnavailableError  (edge-proxy idle timeout —
//                    4xx but transient; Cloudflare/etc. commonly emit it).
// - Network error  → RerankUnavailableError  (fetch throws TypeError).
// - JSON-parse fail on a 5xx-categorized response → RerankUnavailableError
//                    (the proxy returned HTML instead of JSON; treat
//                    consistent with the status bucket).
// - Other 4xx (400/401/403/404/422) → loud rethrow with status + body
//                    excerpt — iron rule #1 forbids silent degradation of
//                    config errors.
// - Malformed 200 body (missing .data or .usage.total_tokens, or rows
//                    missing .index / .relevance_score) → loud Error.
//
// AbortSignal: the `Reranker.rerank` interface at lib/retrieval.ts:50 does
// NOT take a signal. Breaker-driven cancellation mid-flight is BACKLOG'd
// for the orchestrator slice that wires the circuit breaker.

import { RerankUnavailableError, type RerankResult, type Reranker } from "./retrieval";

/** Voyage rerank model id pinned per ADR-0012 §C. */
export const VOYAGE_RERANK_MODEL = "rerank-2";

/**
 * Voyage REST API version (path segment `/v1/`). Used as the `version` field
 * on the returned `Reranker` and propagated to the audit row by the route
 * slice (cf. `app/api/retrieve/route.ts:375` reading `synth.version`).
 *
 * Note on choice: Voyage doesn't publish rerank model snapshot ids the way
 * they do for embeddings (e.g. `voyage-3-large-2024-...`). The API-contract
 * version is the runtime-stable identifier that survives across model
 * silent-updates by Voyage — the most honest "version" we can record for
 * forensic re-run reasoning. If/when Voyage publishes snapshot ids, revisit.
 */
export const VOYAGE_RERANK_API_VERSION = "v1";

/** Voyage rerank endpoint. The `/v1/` segment is the API version. */
const VOYAGE_RERANK_URL = "https://api.voyageai.com/v1/rerank";

/** Max bytes of upstream response body echoed into error messages. Keeps
 *  error logs grep-friendly while bounding accidental large-HTML payloads. */
const ERROR_BODY_EXCERPT_LIMIT = 200;

/** Status codes that are technically 4xx but represent transient outage at
 *  the edge (Cloudflare idle timeout, rate-limit). Mapped to the
 *  RerankUnavailableError bucket; everything else 4xx is loud config-error. */
const TRANSIENT_4XX_STATUSES = new Set<number>([408, 429]);

export type CreateVoyageRerankerOptions = {
  apiKey: string;
  /** Inject a fetch implementation for tests. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
};

/** Per-row shape returned by Voyage's /v1/rerank `data` array. */
type VoyageRerankRow = {
  index: number;
  relevance_score: number;
};

/** Full response body shape for the happy path. */
type VoyageRerankResponse = {
  data: VoyageRerankRow[];
  model: string;
  usage: { total_tokens: number };
};

/**
 * Build a Voyage `rerank-2` adapter. Caller injects the API key explicitly —
 * the factory boundary at `lib/retrieval.ts` is the single source of env
 * truth, mirroring the lib/agents.ts → lib/agents-anthropic.ts split. The
 * adapter itself never reads the env namespace directly (asserted by the
 * source-file scan in the companion test — searches for the literal
 * `proc` + `ess.env` sequence).
 */
export function createVoyageReranker(options: CreateVoyageRerankerOptions): Reranker {
  const apiKey = options.apiKey;
  // Iron-rule-#1 mirror: factory at lib/retrieval.ts already throws on
  // missing key, but a direct adapter caller could bypass that path —
  // guard here too so the "ghost adapter with empty Bearer header"
  // failure mode surfaces at construction, not as a runtime Voyage 401.
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new RangeError("createVoyageReranker: apiKey must be a non-empty string");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  return {
    model: VOYAGE_RERANK_MODEL,
    version: VOYAGE_RERANK_API_VERSION,
    async rerank(
      query: string,
      docs: string[],
      options?: { top_n?: number },
    ): Promise<RerankResult> {
      // Empty docs: short-circuit. Mirrors createStubReranker's behavior at
      // lib/retrieval.ts:128-134. No HTTP call, no token spend.
      if (docs.length === 0) {
        return { ranking: [], tokens_used: 0 };
      }

      // Exact-keys body. `return_documents: false` is load-bearing — Voyage
      // defaults to echoing docs back, which doubles response bandwidth on
      // the 20-candidate path (ADR-0012 §C). We use `.index` to map results
      // back; no need for the echo.
      //
      // Voyage rerank field reference: https://docs.voyageai.com/reference/reranker-api
      // Body keys pinned: query, documents, model, return_documents, top_k.
      // `top_n=0` is forwarded verbatim as `top_k=0` — Voyage's documented
      // semantics is "return 0 rows" (legal). We don't second-guess.
      const requestBody: {
        query: string;
        documents: string[];
        model: string;
        return_documents: false;
        top_k?: number;
      } = {
        query,
        documents: docs,
        model: VOYAGE_RERANK_MODEL,
        return_documents: false,
      };
      if (typeof options?.top_n === "number") {
        requestBody.top_k = options.top_n;
      }

      let response: Response;
      try {
        response = await fetchImpl(VOYAGE_RERANK_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });
      } catch (err) {
        // Network error (DNS, connect refused, TLS, etc.) — fetch rejects
        // with TypeError. Map to transient unavailable per iron rule #12.
        // Fetch TypeError messages contain URL + cause only — never request
        // headers or body — so no apiKey leak via err.message.
        throw new RerankUnavailableError(
          `voyage rerank network error: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      // STATUS-BRANCH FIRST, parse SECOND. If a 502 edge proxy returns
      // text/html, response.json() throws SyntaxError — we want that to
      // inherit the status bucket (5xx → unavailable), not leak as a loud
      // config error.
      // BACKLOG: surface X-Ratelimit-Remaining/Reset via LogEvent when the
      // retrieval_pipeline log discriminant lands. Today no consumer reads
      // them, so we don't pay the marshalling cost.
      if (TRANSIENT_4XX_STATUSES.has(response.status) || response.status >= 500) {
        // Read body best-effort for diagnostics; ignore parse failures.
        // Voyage error bodies do not echo request headers or body, so no
        // apiKey leak through the excerpt.
        let bodyExcerpt = "";
        try {
          bodyExcerpt = (await response.text()).slice(0, ERROR_BODY_EXCERPT_LIMIT);
        } catch {
          // Body unreadable — message still carries status.
        }
        throw new RerankUnavailableError(`voyage rerank ${response.status}: ${bodyExcerpt}`);
      }

      if (!response.ok) {
        // 4xx other than the TRANSIENT_4XX_STATUSES set — auth / permissions
        // / bad-request / etc. Iron rule #1 forbids silent degradation.
        // Surface status + body so the operator can diagnose from logs alone.
        let bodyExcerpt = "";
        try {
          bodyExcerpt = (await response.text()).slice(0, ERROR_BODY_EXCERPT_LIMIT);
        } catch {
          // ignore
        }
        const err = new Error(`voyage rerank ${response.status}: ${bodyExcerpt}`) as Error & {
          status?: number;
        };
        err.status = response.status;
        throw err;
      }

      let parsed: VoyageRerankResponse;
      try {
        parsed = (await response.json()) as VoyageRerankResponse;
      } catch (err) {
        throw new Error(
          `voyage rerank malformed response: JSON parse failed (${err instanceof Error ? err.message : String(err)})`,
        );
      }

      // Validate shape. Voyage's contract changes would surface here as a
      // loud error rather than silently returning a degenerate ranking.
      if (!parsed || !Array.isArray(parsed.data)) {
        throw new Error("voyage rerank malformed response: missing .data array");
      }
      if (!parsed.usage || typeof parsed.usage.total_tokens !== "number") {
        throw new Error("voyage rerank malformed response: missing .usage.total_tokens");
      }
      // Voyage MUST NOT return more rows than we sent — that would silently
      // widen the candidate set past the configured top-N. Loud throw if it
      // does (caching/pagination/contract drift).
      if (parsed.data.length > docs.length) {
        throw new Error(
          `voyage rerank malformed response: data.length=${parsed.data.length} > docs.length=${docs.length}`,
        );
      }
      const ranking = parsed.data.map((row, i) => {
        if (typeof row?.index !== "number" || typeof row?.relevance_score !== "number") {
          throw new Error(
            `voyage rerank malformed response: data[${i}] missing index/relevance_score`,
          );
        }
        // index must point into the docs[] we sent. Out-of-range silently
        // passed through would crash the downstream `docs[index]` lookup
        // far from the source; throw loud here instead.
        if (row.index < 0 || row.index >= docs.length) {
          throw new Error(
            `voyage rerank malformed response: data[${i}].index=${row.index} out of range [0, ${docs.length})`,
          );
        }
        return { index: row.index, score: row.relevance_score };
      });

      return {
        ranking,
        // Propagate Voyage's `usage.total_tokens` VERBATIM. Per ADR-0012 §C
        // this is the billing-authoritative figure (input tokens of the
        // candidate documents). Downstream LogEvent consumers MUST NOT
        // recompute from input strings — Voyage's count is the truth.
        tokens_used: parsed.usage.total_tokens,
      };
    },
  };
}
