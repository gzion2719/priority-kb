// lib/retrieval-pipeline.ts — M3 stage E sub-slice 2c-ii orchestrator.
//
// Async-generator owning the ADR-0013 §3 8-row degraded matrix end-to-end.
// Consumed by `app/api/retrieve/route.ts` (SSE wire transport) and by
// `lib/retrieval-eval.ts` (offline eval — synth omitted). The same code path
// runs both surfaces; eval is "everything-but-stage-D" rather than a parallel
// pipeline that could drift from production semantics.
//
// Yields {@link QueryEvent}s; returns an {@link AuditOutcome} via the
// generator's terminal `{done:true}` frame. Callers drive the iterator
// MANUALLY (`gen.next()` in a loop) — a plain `for await ... of gen` discards
// `value` on the final frame, so the audit row would be written with
// `undefined`. The route's drain pattern lives at the bottom of this file
// for reference.
//
// Transport invariants:
// - The wire vocabulary is `lib/query-chat-state.ts` `QueryEvent`. Drift
//   between this file's `yield` shapes and the reducer compiles fine but
//   fails at runtime — keep them in lockstep.
// - SSE encoding (`data: <json>\n\n`) is the ROUTE LAYER's job. This module
//   yields the typed event; the route encodes.
// - Generator-finalize-on-cancel is the route's job too: `try { for await }
//   finally { gen.return?.() }` — when the SSE consumer disconnects, the
//   generator must be advanced past its terminal so DB transactions in
//   `annFn`/`keywordFn` aren't left orphaned.
//
// Iron-rule coverage:
// - #3 (citations): {@link validateCitations} on every synth output; retry
//   once with {@link STRICTER_PROMPT_PREFIX}; post-retry failure on synth-ok
//   rows degrades to `chunks_only` per ADR-0012 §3 (NOT an error — the slice
//   2c-i `kind:"error" code:"citation_validation_failed"` shape was a
//   row-8-by-construction simplification, superseded here).
// - #6 (sensitivity): `sensitivityAllowedForRole(role)` compiled into both
//   `annFn` and `keywordFn`'s SQL `WHERE`. Never post-hoc filtered.
// - #8 (no live APIs): the deps interface receives provider singletons;
//   tests inject stubs via {@link PipelineDeps}.
// - #9 (embedder model+version): captured BEFORE stage A so an embed-fail
//   path still records iron-rule-#9 attribution.
// - #10 (prompt hash): unchanged — the route pins
//   `prompt_hash: RETRIEVAL_AGENT_PROMPT_HASH` on the audit row.
//   {@link STRICTER_PROMPT_PREFIX}'s SHA-256 is recorded separately as
//   `retry_prefix_hash` when retry fired.
// - #12 (degraded mode): the full ADR-0013 §3 matrix lives in
//   {@link mapDegradedReason}.
//
// What this module does NOT do:
// - Write the audit row. The route's `writeAuditRow(outcome)` runs after
//   the iterator drains, and the route also handles pre-stream config
//   errors (`embedder_config`, `synth_config`) on their own paths.
// - Resolve the wire-emit `prompt_hash`. The route knows the prompt hash;
//   the orchestrator is hash-agnostic.
// - Open the SSE response. The route encodes events; the orchestrator
//   yields them.
//
// Bundle-size note: this module imports DB/pool helpers (`getDb`, `getPool`)
// and Drizzle schema. Do NOT import it from UI-side modules — consume
// {@link AuditOutcome} (a plain shape) and {@link DegradedReasonCode} from
// `lib/retrieval-degraded.ts` directly instead. The deps interface receives
// `Reranker` / `Synthesizer` as injected so a future eval-CLI consumer can
// skip the SDK adapter transitive load by passing stubs.

import { inArray } from "drizzle-orm";
import type { Pool } from "pg";

import * as schema from "@/drizzle/schema";
import { sensitivityAllowedForRole, type Role } from "@/lib/auth";
import { getDb as defaultGetDb, getPool as defaultGetPool } from "@/lib/db";
import { EmbeddingUnavailableError, type Embedder } from "@/lib/embedding";
import { RETRIEVAL_AGENT_PROMPT } from "@/lib/prompts";
import { annCandidates as defaultAnnFn, type AnnCandidate } from "@/lib/retrieval-ann";
import { validateCitations, type CitationValidationResult } from "@/lib/retrieval-citations";
import { type DegradedReasonCode } from "@/lib/retrieval-degraded";
import {
  keywordCandidates as defaultKeywordFn,
  type KeywordCandidate,
} from "@/lib/retrieval-keyword";
import {
  joinRerankedToSynthInput,
  synthesizeKeywordOnlyRepresentative,
  type RerankBoundaryEntry,
} from "@/lib/retrieval-rerank-input";
import { RETRIEVAL_RETRY_PREFIX_HASH, STRICTER_PROMPT_PREFIX } from "@/lib/retrieval-retry-prefix";
import {
  RerankUnavailableError,
  SynthUnavailableError,
  rrfFuse,
  type CitationValidationDetail,
  type CitationValidationOutcome,
  type Reranker,
  type RetrievalAuditPayload,
  type Synthesizer,
} from "@/lib/retrieval";
import {
  buildSynthContext,
  type Sensitivity,
  type SynthInputChunk,
} from "@/lib/retrieval-synth-input";
import type { QueryCandidate, QueryChunkSnippet, QueryEvent } from "@/lib/query-chat-state";

// ── Constants ──────────────────────────────────────────────────────────────

/** ANN top-K post-collapse (ADR-0013 §2.3). */
export const TOP_K_ANN = 20;
/** ANN inner LIMIT pre-collapse (ADR-0013 §2.3 K=20→50 over-fetch). */
export const TOP_K_ANN_INNER = 50;
/** Keyword lane LIMIT (ADR-0013 §2.3). */
export const TOP_K_KEYWORD = 20;
/** Top-N reranked → synth (ADR-0012 §C ~3.5K token budget). */
export const TOP_N_SYNTH = 5;

/**
 * RRF `k` parsed at module load (fail-loud `RangeError` on bad env, matching
 * `RETRIEVAL_RERANK_MIN_COSINE` precedent). Default 60 per ADR-0013 §2.4
 * (Cormack 2009 original); range [1, 1000] matches `rrfFuse`'s own guard.
 */
function parseRrfK(): number {
  const raw = process.env.RETRIEVAL_RRF_K;
  if (raw === undefined || raw === "") return 60;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 1000 || String(n) !== raw.trim()) {
    throw new RangeError(`RETRIEVAL_RRF_K=${JSON.stringify(raw)} must be an integer in [1, 1000]`);
  }
  return n;
}
export const RETRIEVAL_RRF_K = parseRrfK();

// ── Public types ───────────────────────────────────────────────────────────

/** Thin alias so the deps interface doesn't leak Drizzle types to callers. */
export type Db = ReturnType<typeof defaultGetDb>;

/** Row shape returned by {@link FetchEntriesFn}. */
export type HydratedEntryRow = {
  id: string;
  title: string;
  body: string;
  category: string;
  tags: string[];
  source_pointer: string;
  sensitivity: Sensitivity;
  last_verified_at: Date;
};

/** Row shape returned by {@link FetchChunkSlicesFn}. */
export type HydratedChunkSlice = {
  id: string;
  entry_id: string;
  content_start: number;
  content_end: number;
};

/** Fetch entry rows by IDs. Default implementation uses Drizzle's `getDb`. */
export type FetchEntriesFn = (ids: string[]) => Promise<HydratedEntryRow[]>;
/** Fetch chunk slice offsets by chunk IDs. Default implementation uses Drizzle's `getDb`. */
export type FetchChunkSlicesFn = (chunkIds: string[]) => Promise<HydratedChunkSlice[]>;

/**
 * Dependency-injection bundle for {@link retrievePipeline}.
 *
 * Production callers (the route) pass real provider singletons +
 * default-resolved DB helpers. Unit tests inject stubs across the board so
 * the orchestrator's per-row matrix behavior can be exercised without
 * touching Postgres or the Drizzle query builder.
 *
 * `synth` is OPTIONAL: when omitted, the orchestrator runs stages A → B/B' →
 * fuse → rerank and then RETURNS without invoking stage D, citation
 * validation, or emitting `answer_delta`/`done`/`chunks_only` (terminal
 * `no_content` still fires on empty fused). This is the single code path
 * `evalRetrieve` uses to compute recall@5 / citation-precision against the
 * golden set without paying Claude tokens (ADR-0012 §7).
 */
export type PipelineDeps = {
  embedder: Embedder;
  reranker: Reranker;
  /** Omit to run in eval mode — stages A→C only, no events past `candidates`. */
  synth?: Synthesizer;
  /** Defaults to `@/lib/retrieval-ann` `annCandidates`. */
  annFn?: typeof defaultAnnFn;
  /** Defaults to `@/lib/retrieval-keyword` `keywordCandidates`. */
  keywordFn?: typeof defaultKeywordFn;
  /** Defaults to `@/lib/db` `getPool`. */
  getPool?: () => Pool;
  /** Defaults to a Drizzle `SELECT FROM entries WHERE id = ANY($1)` over `getDb`. */
  fetchEntriesFn?: FetchEntriesFn;
  /** Defaults to a Drizzle `SELECT FROM chunks WHERE id = ANY($1)` over `getDb`. */
  fetchChunkSlicesFn?: FetchChunkSlicesFn;
};

/** Default entry-row hydration via `getDb()` + Drizzle. */
async function defaultFetchEntries(ids: string[]): Promise<HydratedEntryRow[]> {
  if (ids.length === 0) return [];
  const db = defaultGetDb();
  const rows = await db
    .select({
      id: schema.entries.id,
      title: schema.entries.title,
      body: schema.entries.body,
      category: schema.entries.category,
      tags: schema.entries.tags,
      source_pointer: schema.entries.source_pointer,
      sensitivity: schema.entries.sensitivity,
      last_verified_at: schema.entries.last_verified_at,
    })
    .from(schema.entries)
    .where(inArray(schema.entries.id, ids));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    category: r.category,
    tags: r.tags,
    source_pointer: r.source_pointer,
    sensitivity: r.sensitivity,
    last_verified_at: r.last_verified_at,
  }));
}

/** Default chunk-slice hydration via `getDb()` + Drizzle. */
async function defaultFetchChunkSlices(chunkIds: string[]): Promise<HydratedChunkSlice[]> {
  if (chunkIds.length === 0) return [];
  const db = defaultGetDb();
  return db
    .select({
      id: schema.chunks.id,
      entry_id: schema.chunks.entry_id,
      content_start: schema.chunks.content_start,
      content_end: schema.chunks.content_end,
    })
    .from(schema.chunks)
    .where(inArray(schema.chunks.id, chunkIds));
}

/** Caller-supplied request shape. */
export type PipelineInput = { query: string; role: Role };

/**
 * Terminal return value from {@link retrievePipeline}. Shaped as
 * {@link RetrievalAuditPayload} so the route can hand it straight to
 * `writeAuditRow` without projection (M3/M4 plan-CR alignment).
 */
export type AuditOutcome = RetrievalAuditPayload;

// ── Degraded-reason matrix mapper (ADR-0013 §3) ────────────────────────────

/**
 * Map the (embedOk × rerankOk × synthOk × fused-non-empty) state vector to
 * the one {@link DegradedReasonCode} that names this outcome row.
 *
 * Returns `null` on the all-healthy row (`degraded:false`). The keyword-only
 * fail-empty special case (`!embedOk && !fusedNonEmpty`) returns
 * `no_keyword_match_under_embed_outage` regardless of rerank/synth state —
 * the rerank/synth states never observed because the pipeline short-circuits
 * before reaching them.
 *
 * `citation_validation_failed` is NOT in this mapper's range — it's a
 * post-validation outcome computed inside {@link retrievePipeline} after
 * stage D and overrides whatever this mapper would have returned.
 */
export function mapDegradedReason(args: {
  embedOk: boolean;
  rerankOk: boolean;
  synthOk: boolean;
  fusedNonEmpty: boolean;
}): DegradedReasonCode | null {
  const { embedOk, rerankOk, synthOk, fusedNonEmpty } = args;
  // Empty-keyword under embed-outage takes precedence over the row-tuple.
  if (!embedOk && !fusedNonEmpty) return "no_keyword_match_under_embed_outage";
  if (embedOk && rerankOk && synthOk) return null;
  if (embedOk && rerankOk && !synthOk) return "synth_unavailable";
  if (embedOk && !rerankOk && synthOk) return "rerank_unavailable";
  if (embedOk && !rerankOk && !synthOk) return "rerank_and_synth_unavailable";
  if (!embedOk && rerankOk && synthOk) return "embed_unavailable_keyword_fallback";
  if (!embedOk && !rerankOk && synthOk) return "embed_and_rerank_unavailable_keyword_fallback";
  if (!embedOk && rerankOk && !synthOk) return "embed_and_synth_unavailable_keyword_bare";
  return "embed_rerank_synth_unavailable_keyword_bare";
}

// ── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Run the full retrieval pipeline against `input` with the providers in
 * `deps`. Yields wire-shape {@link QueryEvent}s for transport, returns the
 * terminal {@link AuditOutcome} via the generator's `{done:true}` frame.
 *
 * Caller drains the iterator manually:
 *
 * ```ts
 * const gen = retrievePipeline(deps, input);
 * let outcome: AuditOutcome;
 * try {
 *   for (;;) {
 *     const r = await gen.next();
 *     if (r.done) { outcome = r.value; break; }
 *     send(r.value);
 *   }
 * } finally {
 *   await gen.return?.(undefined as never);
 * }
 * ```
 *
 * `for await ... of gen` is INSUFFICIENT — it discards the terminal `value`
 * and the audit row would be written with `undefined`.
 *
 * Invariants:
 * - The caller has already validated `input.query` is non-empty / has at
 *   least one searchable character (route layer's Zod superRefine + ADR-0013
 *   §4 §M5). The keyword lane's `RangeError` floor is a defense, not a
 *   user-facing 400 path.
 * - Pre-stream config errors (`getSynthesizer()` RangeError on missing
 *   `ANTHROPIC_API_KEY`, etc.) are resolved BEFORE the orchestrator runs;
 *   `deps.synth` here is either a working synthesizer or omitted.
 */
export async function* retrievePipeline(
  deps: PipelineDeps,
  input: PipelineInput,
): AsyncGenerator<QueryEvent, AuditOutcome, void> {
  const { embedder, reranker } = deps;
  const synth = deps.synth;
  const annFn = deps.annFn ?? defaultAnnFn;
  const keywordFn = deps.keywordFn ?? defaultKeywordFn;
  const getPool = deps.getPool ?? defaultGetPool;
  const fetchEntriesFn = deps.fetchEntriesFn ?? defaultFetchEntries;
  const fetchChunkSlicesFn = deps.fetchChunkSlicesFn ?? defaultFetchChunkSlices;

  const { query, role } = input;
  const sensitivityAllowed = sensitivityAllowedForRole(role);

  // Iron rule #9: capture embedder attribution BEFORE stage A so an embed
  // throw still records "the embedder that would have run" on the audit row
  // (ADR-0013 §3 "Iron-rule-#9 attribution when stage A never runs").
  const embedding_model = embedder.model;
  const embedding_version = embedder.version;

  // Eval-mode (no synth) initializes synthesizer_* to null; production mode
  // captures the configured synth's model/version up-front so a SynthUnavailable
  // throw at stage D still records WHO was supposed to run.
  const synthesizer_model = synth?.model ?? null;
  const synthesizer_version = synth?.version ?? null;

  // ── State ────────────────────────────────────────────────────────────────
  let embedOk = true;
  let rerankOk = true;
  let synthOk = synth !== undefined; // eval-mode treats synth as "n/a", not "down"
  let embedTokens = 0;
  let synthTokensIn = 0;
  let synthTokensOut = 0;
  const latencies_ms: Record<string, number> = {};

  // ── Stage A: embed ───────────────────────────────────────────────────────
  let queryVector: number[] | null = null;
  const tEmbedStart = Date.now();
  try {
    const r = await embedder.embed(query, { input_type: "query" });
    queryVector = r.vector;
    embedTokens = r.tokens_used;
  } catch (err) {
    if (err instanceof EmbeddingUnavailableError) {
      embedOk = false;
    } else {
      // Config errors (RangeError on bad env) and other unknown throws bubble
      // up to the route, which writes its own pre-stream-error audit row.
      throw err;
    }
  }
  latencies_ms.embed = Date.now() - tEmbedStart;

  // ── Stages B + B': ANN ⊕ keyword ─────────────────────────────────────────
  const pool = getPool();
  let annResults: AnnCandidate[] = [];
  let keywordResults: KeywordCandidate[] = [];

  const tLanesStart = Date.now();
  if (embedOk && queryVector) {
    // Both lanes in parallel on the healthy embed path. Lane DB-errors
    // (Postgres failures, NOT degraded-mode signals) propagate via Promise.all
    // — first rejection wins and the second lane's pending promise is left
    // unhandled by-design (we have no use for two error reports). If
    // Promise.allSettled is reintroduced, the second rejection must also be
    // observed (`await Promise.allSettled(...).then(r => r.forEach(...))`) to
    // avoid an unhandled-promise-rejection at runtime.
    [annResults, keywordResults] = await Promise.all([
      annFn(
        pool,
        queryVector,
        sensitivityAllowed,
        embedding_model,
        embedding_version,
        TOP_K_ANN,
        TOP_K_ANN_INNER,
      ),
      keywordFn(pool, query, sensitivityAllowed, TOP_K_KEYWORD),
    ]);
  } else {
    // Embed-fail: keyword lane only (ADR-0013 §3 rows 5/6/7/8).
    keywordResults = await keywordFn(pool, query, sensitivityAllowed, TOP_K_KEYWORD);
  }
  latencies_ms.lanes = Date.now() - tLanesStart;

  const ann_candidate_ids = annResults.map((r) => r.entry_id);
  const keyword_candidate_ids = keywordResults.map((r) => r.entry_id);

  // ── Fuse ────────────────────────────────────────────────────────────────
  let fused_ids: string[];
  if (embedOk) {
    const fused = rrfFuse(
      [
        { name: "ann", rankedEntryIds: ann_candidate_ids },
        { name: "keyword", rankedEntryIds: keyword_candidate_ids },
      ],
      RETRIEVAL_RRF_K,
      TOP_K_ANN,
    );
    fused_ids = fused.map((f) => f.entry_id);
  } else {
    // Embed-fail: keyword rank order direct, capped at TOP_K_ANN.
    fused_ids = keyword_candidate_ids.slice(0, TOP_K_ANN);
  }

  const keyword_only = !embedOk;
  const fusedNonEmpty = fused_ids.length > 0;

  // Outcome scaffolding factory — invariant fields filled in; mutable fields
  // (reranked_ids, citation_*, retry_*, tokens, degraded, status, error)
  // overlaid per-row at terminal points.
  const buildBase = (): AuditOutcome => ({
    query,
    role,
    sensitivity_allowed: sensitivityAllowed,
    embedding_model,
    embedding_version,
    ann_candidate_ids,
    keyword_candidate_ids,
    fused_ids,
    rrf_k: RETRIEVAL_RRF_K,
    reranked_ids: [],
    citation_ids: [],
    keyword_only,
    tokens: {
      embed: embedTokens,
      keyword: 0,
      rerank_input: 0,
      synth_input: synthTokensIn,
      synth_output: synthTokensOut,
    },
    latencies_ms: { ...latencies_ms },
    degraded: false,
    status: "ok",
    synthesizer_model,
    synthesizer_version,
    citation_validation_outcome: null,
    citation_validation_detail: null,
    retry_attempted: false,
    retry_prefix_hash: null,
  });

  // ── No candidates terminal ──────────────────────────────────────────────
  if (!fusedNonEmpty) {
    // ADR-0013 §3 special row: embed lane failed AND keyword lane returned
    // zero → wire-surface `no_keyword_match_under_embed_outage` so the UI
    // banner can render reason-specific copy from lib/degraded-copy.ts.
    // Wire shape mirrors chunks_only (reason-only; reducer synthesizes
    // degraded:true). The structural-no-content case (embed-OK, both lanes
    // empty) yields bare — content gap, not an outage.
    if (!embedOk) {
      yield { kind: "no_content", degraded_reason: "no_keyword_match_under_embed_outage" };
      const out = buildBase();
      out.degraded = true;
      out.degraded_reason = "no_keyword_match_under_embed_outage";
      return out;
    }
    yield { kind: "no_content" };
    return buildBase();
  }

  // ── Hydrate entry rows ──────────────────────────────────────────────────
  const topNCandidateIds = fused_ids.slice(0, TOP_N_SYNTH);
  const entryRows = await fetchEntriesFn(topNCandidateIds);
  const byId = new Map(entryRows.map((r) => [r.id, r]));
  const orderedRows = topNCandidateIds
    .map((id) => byId.get(id))
    .filter((r): r is NonNullable<typeof r> => r !== undefined);

  // Fetch best-ANN-chunk body slices for ANN-lane entries (Q3: on embedFail,
  // ALL entries are keyword-only by construction, so skip the chunk fetch).
  const annBestChunkBodyByEntry = new Map<string, string>();
  if (embedOk && annResults.length > 0 && orderedRows.length > 0) {
    const orderedIds = new Set(orderedRows.map((r) => r.id));
    const relevantAnn = annResults.filter((r) => orderedIds.has(r.entry_id));
    if (relevantAnn.length > 0) {
      const chunkRows = await fetchChunkSlicesFn(relevantAnn.map((r) => r.best_chunk_id));
      for (const ch of chunkRows) {
        const entry = byId.get(ch.entry_id);
        if (entry) {
          // ADR-0009 stores char-offsets, so plain String.slice is correct.
          annBestChunkBodyByEntry.set(
            ch.entry_id,
            entry.body.slice(ch.content_start, ch.content_end),
          );
        }
      }
    }
  }

  // Boundary entries for the reranker — body is the EXACT text the model
  // will see for this entry (ADR-0013 §2.3 step 4 keyword-only synth-rep).
  const boundaries: RerankBoundaryEntry[] = orderedRows.map((r) => {
    const annBody = annBestChunkBodyByEntry.get(r.id);
    const body =
      annBody !== undefined ? annBody : synthesizeKeywordOnlyRepresentative(r.title, r.body);
    return {
      entry_id: r.id,
      title: r.title,
      body,
      category: r.category,
      tags: r.tags,
      source_pointer: r.source_pointer,
      last_verified_at: r.last_verified_at.toISOString(),
      sensitivity: r.sensitivity,
    };
  });

  // Emit candidates event (always before any synth-side emission).
  const candidateEvents: QueryCandidate[] = orderedRows.map((r) => ({
    entry_id: r.id,
    title: r.title,
    category: r.category,
    sensitivity: r.sensitivity,
    last_verified_at: r.last_verified_at.toISOString(),
  }));
  yield { kind: "candidates", entries: candidateEvents };

  // ── Stage C: rerank ─────────────────────────────────────────────────────
  let synthInputs: SynthInputChunk[];
  let reranked_ids: string[];
  const tRerankStart = Date.now();
  try {
    const rerankResult = await reranker.rerank(
      query,
      boundaries.map((b) => b.body),
      { top_n: TOP_N_SYNTH },
    );
    synthInputs = joinRerankedToSynthInput(rerankResult.ranking, boundaries, TOP_N_SYNTH);
    reranked_ids = synthInputs.map((s) => s.entry_id);
  } catch (err) {
    if (err instanceof RerankUnavailableError) {
      rerankOk = false;
      // Skip rerank: pass fused order through, top-N.
      synthInputs = boundaries.slice(0, TOP_N_SYNTH).map((b) => ({
        entry_id: b.entry_id,
        title: b.title,
        body: b.body,
        category: b.category,
        tags: b.tags,
        source_pointer: b.source_pointer,
        last_verified_at: b.last_verified_at,
        sensitivity: b.sensitivity,
        // No real rerank score; render 0 (synth-input renderer accepts 0).
        score: 0,
      }));
      reranked_ids = synthInputs.map((s) => s.entry_id);
    } else {
      throw err;
    }
  }
  latencies_ms.rerank = Date.now() - tRerankStart;

  // Chunk snippets reusable for any `chunks_only` emit (rows 2/4/7 + the
  // citation-validation-failed degrade). `snippet` IS the body the reranker
  // saw — for ANN-path entries that's the best-chunk slice, for keyword-only
  // survivors that's the synth-representative. Uniform rule per the M5
  // plan-CR resolution.
  const chunkSnippets: QueryChunkSnippet[] = synthInputs.map((s) => ({
    entry_id: s.entry_id,
    title: s.title,
    category: s.category,
    sensitivity: s.sensitivity,
    last_verified_at: s.last_verified_at,
    snippet: s.body,
  }));

  // ── Eval-mode exit (no synth) ───────────────────────────────────────────
  if (!synth) {
    const out = buildBase();
    out.reranked_ids = reranked_ids;
    out.tokens.rerank_input = synthInputs.reduce((acc, s) => acc + s.body.length, 0);
    out.latencies_ms = { ...latencies_ms };
    out.degraded = !embedOk || !rerankOk;
    // synthOk passed `true` to the mapper because eval mode treats synth as
    // not-attempted (n/a), not as failed. This produces the same matrix code
    // the production caller would see if synth happened to be healthy at
    // this state — the right semantics for offline recall@5 measurement.
    const reason = mapDegradedReason({
      embedOk,
      rerankOk,
      synthOk: true,
      fusedNonEmpty,
    });
    if (reason) out.degraded_reason = reason;
    return out;
  }

  // ── Stage D: synth + validate ───────────────────────────────────────────
  const tSynthStart = Date.now();
  let answer = "";
  let citation_ids: string[] = [];
  let citation_validation_outcome: CitationValidationOutcome | null = null;
  let citation_validation_detail: CitationValidationDetail = null;
  let retry_attempted = false;
  let retry_prefix_hash: string | null = null;

  try {
    const context = buildSynthContext(synthInputs);
    const firstAttempt = await synth.synthesize(RETRIEVAL_AGENT_PROMPT, context);
    synthTokensIn += firstAttempt.tokens_in;
    synthTokensOut += firstAttempt.tokens_out;
    // validateCitations returns a discriminated union and never throws (see
    // lib/retrieval-citations.ts JSDoc). A defensive try/catch would corrupt
    // forensic data by synthesizing a fake failure variant, so we trust the
    // contract here — if it ever starts throwing, the orchestrator's outer
    // catch will surface the unknown error rather than silently masking it
    // as a citation failure.
    let validation: CitationValidationResult = validateCitations(firstAttempt.answer, reranked_ids);

    if (!validation.ok) {
      retry_attempted = true;
      retry_prefix_hash = RETRIEVAL_RETRY_PREFIX_HASH;
      const retryAttempt = await synth.synthesize(
        STRICTER_PROMPT_PREFIX + "\n\n" + RETRIEVAL_AGENT_PROMPT,
        context,
      );
      synthTokensIn += retryAttempt.tokens_in;
      synthTokensOut += retryAttempt.tokens_out;
      validation = validateCitations(retryAttempt.answer, reranked_ids);
    }

    if (validation.ok) {
      answer = validation.body;
      citation_ids = validation.ids;
      citation_validation_outcome = "ok";
    } else {
      // B3 plan-CR resolution: post-retry validation failure on synth-ok
      // rows degrades to chunks_only with degraded_reason=
      // citation_validation_failed, per ADR-0012 §3. The slice-2c-i
      // `kind:"error" code:"citation_validation_failed"` shape was a row-8-
      // by-construction simplification, superseded here.
      citation_validation_outcome = validation.reason;
      citation_validation_detail = detailFromValidation(validation);
      latencies_ms.synth = Date.now() - tSynthStart;
      yield {
        kind: "chunks_only",
        entries: chunkSnippets,
        degraded_reason: "citation_validation_failed",
      };
      const out = buildBase();
      out.reranked_ids = reranked_ids;
      out.tokens.synth_input = synthTokensIn;
      out.tokens.synth_output = synthTokensOut;
      out.latencies_ms = { ...latencies_ms };
      out.citation_validation_outcome = citation_validation_outcome;
      out.citation_validation_detail = citation_validation_detail;
      out.retry_attempted = retry_attempted;
      out.retry_prefix_hash = retry_prefix_hash;
      out.degraded = true;
      out.degraded_reason = "citation_validation_failed";
      // Per the RetrievalAuditPayload.status JSDoc: post-retry validation
      // failure is an error outcome (audit-row consumers filter on status
      // alongside degraded_reason for forensic replay).
      out.status = "error";
      out.error = `citation_validation_failed: ${validation.reason}`;
      return out;
    }
  } catch (err) {
    if (err instanceof SynthUnavailableError) {
      synthOk = false;
      latencies_ms.synth = Date.now() - tSynthStart;
      const reason = mapDegradedReason({ embedOk, rerankOk, synthOk, fusedNonEmpty });
      yield {
        kind: "chunks_only",
        entries: chunkSnippets,
        ...(reason ? { degraded_reason: reason } : {}),
      };
      const out = buildBase();
      out.reranked_ids = reranked_ids;
      // Q2 plan-CR: preserve retry state on the synth-throws-on-retry path
      // so the audit row records that a retry was attempted even when the
      // second synth call surfaced as SynthUnavailableError mid-retry.
      out.retry_attempted = retry_attempted;
      out.retry_prefix_hash = retry_prefix_hash;
      out.tokens.synth_input = synthTokensIn;
      out.tokens.synth_output = 0;
      out.latencies_ms = { ...latencies_ms };
      out.degraded = true;
      if (reason) out.degraded_reason = reason;
      out.status = "error";
      out.error = err.message;
      return out;
    }
    throw err;
  }
  latencies_ms.synth = Date.now() - tSynthStart;

  // ── Happy + degraded-but-synth-ok terminal ──────────────────────────────
  yield { kind: "answer_delta", text: answer };
  const reason = mapDegradedReason({ embedOk, rerankOk, synthOk: true, fusedNonEmpty });
  yield {
    kind: "done",
    citation_ids,
    ...(reason !== null ? { degraded: true, degraded_reason: reason } : {}),
  };

  const out = buildBase();
  out.reranked_ids = reranked_ids;
  out.citation_ids = citation_ids;
  out.tokens.synth_input = synthTokensIn;
  out.tokens.synth_output = synthTokensOut;
  out.latencies_ms = { ...latencies_ms };
  out.citation_validation_outcome = citation_validation_outcome;
  out.citation_validation_detail = citation_validation_detail;
  out.retry_attempted = retry_attempted;
  out.retry_prefix_hash = retry_prefix_hash;
  if (reason !== null) {
    out.degraded = true;
    out.degraded_reason = reason;
  }
  return out;
}

/**
 * Project a validator failure variant onto the audit-row
 * {@link CitationValidationDetail} payload.
 */
function detailFromValidation(v: CitationValidationResult): CitationValidationDetail {
  if (v.ok) return null;
  switch (v.reason) {
    case "invalid_uuid":
    case "duplicate_id":
    case "hallucinated_id":
      return { offending_ids: v.offending_ids };
    case "inline_sources_mismatch":
      return { inline_only: v.inline_only, sources_only: v.sources_only };
    case "multiple_sources_blocks":
      return { count: v.count };
    case "trailing_prose_after_sources":
      return { trailing: v.trailing };
    case "sources_block_missing":
    case "sources_block_empty":
      return null;
  }
}

/**
 * Buffer-drain helper. Returns `{events, outcome}` after the generator
 * terminates. Used by tests that want to assert the full wire transcript
 * against the audit outcome from the same execution.
 *
 * NOT suitable for production streaming — events buffer until completion,
 * defeating SSE. Use {@link drainPipelineEvents} from a `ReadableStream`
 * `start` instead.
 */
export async function drainPipeline(
  gen: AsyncGenerator<QueryEvent, AuditOutcome, void>,
): Promise<{ events: QueryEvent[]; outcome: AuditOutcome }> {
  const events: QueryEvent[] = [];
  try {
    for (;;) {
      const r = await gen.next();
      if (r.done) {
        return { events, outcome: r.value };
      }
      events.push(r.value);
    }
  } finally {
    await gen.return?.(undefined as never);
  }
}

/**
 * Streaming-drain helper. Invokes `onEvent` for each yielded
 * {@link QueryEvent} as it arrives and returns the terminal
 * {@link AuditOutcome} when the generator completes.
 *
 * Caller is responsible for `gen.return?.()` finalize on cancel — wrap this
 * call in `try { ... } finally { await gen.return?.() }` from the route's
 * `ReadableStream` `start` to release lane DB transactions on consumer
 * disconnect. The route layer also handles `controller.close()`.
 */
export async function drainPipelineEvents(
  gen: AsyncGenerator<QueryEvent, AuditOutcome, void>,
  onEvent: (ev: QueryEvent) => void,
): Promise<AuditOutcome> {
  try {
    for (;;) {
      const r = await gen.next();
      if (r.done) return r.value;
      onEvent(r.value);
    }
  } catch (err) {
    // Finalize the generator if onEvent throws — releases lane DB work that
    // the orchestrator's next-iteration would otherwise leave pending.
    try {
      await gen.return?.(undefined as never);
    } catch {
      // ignore
    }
    throw err;
  }
}
