// app/api/retrieve/route.ts — M3 item 2 thin slice (ROADMAP item 3 partial).
//
// SSE retrieval route exercising ONLY the keyword lane (PR #158's
// keywordCandidates) + the existing stub Synthesizer from lib/retrieval.ts.
// Full pipeline (ANN + Voyage rerank + Anthropic Sonnet synth + 8-row
// ADR-0013 §3 degraded matrix) is deferred to "M3 item 3 full" slice;
// this route corresponds to ADR-0013 §3 row 8 (`embed_rerank_synth_
// unavailable_keyword_bare`) by construction — every request is in
// keyword-only degraded mode. The degraded_reason is constant for happy
// paths; mid-stream failures preserve the row-8 reason and surface their
// variant via payload.status + payload.error (audit-row shape), keeping
// degraded_reason strictly inside DEGRADED_REASON_CODES per ADR-0013 §2.5.
//
// Contract mapping:
//   Iron rule #3 cite        → citation_ids[] on the `done` event, drawn
//                              from the real candidate set (never from
//                              the stub Synthesizer's zero-UUID sentinel).
//   Iron rule #6 sensitivity → withUserOrAdmin + sensitivityAllowedForRole
//                              compile the allow-list into keywordCandidates'
//                              SQL WHERE. No post-hoc filter; the SQL
//                              never sees rows above the role's tier.
//   Iron rule #8 no live APIs→ stub Synthesizer only. The Embedder factory
//                              is consulted ONLY for `model`/`version`
//                              attribution (per ADR-0013 §"Iron-rule-#9
//                              attribution when stage A never runs"); no
//                              `.embed()` call is made.
//   Iron rule #10 prompt hash→ audit row pins RETRIEVAL_AGENT_PROMPT_HASH.
//   Iron rule #12 degraded   → degraded:true + degraded_reason on every
//                              audit row, including the 503 synth-config
//                              early-return path. UI shows a persistent
//                              banner regardless of outcome.
//
// ADR-0012 §5 citation-validation retry-once IS wired in this slice (sub-slice
// 2c-i). The validator at lib/retrieval-citations.ts runs on every synth
// output; on failure, the route re-invokes the synth with a stricter system-
// prompt prefix prepended (single generic prefix in this slice; per-reason
// prefix table queued for 2c-ii). The stricter prefix is NOT part of the
// hashed retrieval-agent prompt — iron rule #10's hash represents "what the
// model was trained on this turn"; the prefix is a route-layer adjuster
// hashed separately as RETRY_PREFIX_HASH and audit-traced. Both attempts
// re-validate; on second-fail, the route emits {kind:"error",
// code:"citation_validation_failed"} and the audit row records the
// failure discriminant in `citation_validation_outcome` plus the offending-
// IDs payload in `citation_validation_detail`.
//
// `degraded_reason` stays ROW_8_REASON in this slice because the route is
// permanently row 8 by construction (keyword-bare; ANN + rerank + synth-up
// rows arrive in 2c-ii). ADR-0012 §3 maps post-retry citation-validation
// failure to `reason_code:"citation_validation_failed"` on the synth-ok
// rows (1/3/5/6). When 2c-ii wires those rows, second-retry failure WILL
// flip `degraded_reason` to `citation_validation_failed` per ADR-0012 §3 —
// the "no flip" discipline in this slice is a row-8 specialization, not a
// general rule. ADR-0013 §3 confirms §5 retry is skipped iff `answer===""`
// AND `degraded===true` (rows 2/4/7/8), which row 8 satisfies after the
// validation fails — but this slice runs the retry anyway because the
// stub synth always returns a non-empty answer; the route's row-8 label
// is a slice-construction fiction (already noted at the file-header
// "ADR-0013 §3 row 8 by construction" line above).
//
// Slice 2c-i intentionally does NOT consume buildSynthContext from
// lib/retrieval-synth-input.ts — that helper's SynthInputChunk.score field
// is contractually the Voyage rerank score, and injecting the keyword
// lane's ts_rank_cd there would lie to the model and to the hashed prompt
// contract. The synth-input wire-up lands in 2c-ii when the rerank lane
// produces real scores.
//
// LogEvent: this slice still does NOT emit a logEvent record. The audit_log
// row carries iron-rule-#9 attribution, forensic state, AND the new
// citation-validation fields. ADR-0012 §8's planned request-level
// kind:"retrieval_pipeline" LogEvent lands in 2c-ii alongside the full
// 8-row matrix wiring (BACKLOG Retrieval §"LogEvent discriminant for
// retrieval pipeline").
//
// CSRF posture: inherited from ADR-0010 Consequences — deferred to M5 with
// Microsoft Entra ID. Stub-auth header is the dev-only gate.

import { createHash } from "node:crypto";

import { type NextRequest } from "next/server";
import { inArray } from "drizzle-orm";
import { z } from "zod";

import * as schema from "@/drizzle/schema";
import { sensitivityAllowedForRole, withUserOrAdmin, type Role } from "@/lib/auth";
import { getDb, getPool } from "@/lib/db";
import { EmbeddingUnavailableError, getEmbedder } from "@/lib/embedding";
import { redactSecrets } from "@/lib/log";
import { RETRIEVAL_AGENT_PROMPT, RETRIEVAL_AGENT_PROMPT_HASH } from "@/lib/prompts";
import { keywordCandidates } from "@/lib/retrieval-keyword";
import { SynthUnavailableError, getSynthesizer } from "@/lib/retrieval";
import { validateCitations, type CitationValidationResult } from "@/lib/retrieval-citations";
import type { QueryEvent } from "@/lib/query-chat-state";
import type { Sensitivity } from "@/drizzle/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hardcoded slice-1 caps. Slice 3 full will lift to env knobs following
// ADR-0012 §K convention (e.g., RETRIEVAL_KEYWORD_TOP_K, RETRIEVAL_SYNTH_TOP_N).
const TOP_K_CANDIDATES = 20;
const TOP_N_SYNTH = 5;
const ROW_8_REASON = "embed_rerank_synth_unavailable_keyword_bare" as const;

// ── Stricter-prompt-prefix retry (ADR-0012 §5) ─────────────────────────────

/**
 * Single generic stricter system-prompt prefix prepended on retry when the
 * first synth attempt fails mechanical citation validation. The prefix is
 * route-layer, NOT part of the hashed retrieval-agent prompt — iron rule
 * #10's `prompt_hash` continues to pin RETRIEVAL_AGENT_PROMPT_HASH on every
 * audit row. The prefix's own SHA-256 is computed at module load below and
 * recorded on the audit row in `retry_prefix_hash` so the exact retry input
 * is reconstructable post-hoc by content-addressing.
 *
 * Per-reason prefix table (e.g. naming the specific offending IDs back at
 * the model) is queued for sub-slice 2c-ii; the v0.2.0 retrieval-agent
 * prompt already documents the §5 contract, so a single generic reminder
 * is sufficient for slice 2c-i.
 */
export const STRICTER_PROMPT_PREFIX =
  "The previous response failed mechanical citation validation per the §5 contract. " +
  "Re-emit the answer respecting these invariants: every factual claim ends with an " +
  "inline citation of the form [entry_id]; the response ends with a single trailing " +
  "Sources: [<uuid>, ...] block on its own last line; the set of inline-cited UUIDs " +
  "equals the set inside the Sources block; every UUID is a valid v4 drawn ONLY from " +
  "the provided entries; no prose follows the Sources block.";

/**
 * SHA-256 (hex) of {@link STRICTER_PROMPT_PREFIX}, sealed at module load.
 * Audit-row `retry_prefix_hash` carries this value when a retry fired and
 * null otherwise. Parallel to {@link RETRIEVAL_AGENT_PROMPT_HASH}.
 *
 * No byte-roundtrip integrity check is paired with this hash (cf. the
 * `_PROMPT_ROUNDTRIP_HASH` assertion at lib/prompts.ts:79-91): the prefix
 * is a TypeScript string literal compiled into the module, not a file-read,
 * so the BOM / non-UTF-8 failure mode that motivated the prompts.ts check
 * is unreachable here. A refactor that swaps in a different encoding for
 * the `Buffer.from(..., "utf8")` call would silently change the hash —
 * captured as a m1 cross-ref in the 2c-i code-CR.
 */
export const RETRIEVAL_RETRY_PREFIX_HASH = createHash("sha256")
  .update(Buffer.from(STRICTER_PROMPT_PREFIX, "utf8"))
  .digest("hex");

/** Discriminator values for the audit row's citation_validation_outcome. */
type CitationValidationOutcome = "ok" | Extract<CitationValidationResult, { ok: false }>["reason"];

/**
 * Per-reason payload carried on the audit row alongside the outcome
 * discriminant. The validator's discriminated-union failure variants carry
 * `offending_ids` (3 reasons), `inline_only`/`sources_only` (1 reason), a
 * `count` (1 reason), or a `trailing` excerpt (1 reason) — losing this
 * payload at the audit boundary would prevent 2c-ii's per-reason prefix
 * table from being tuned against production audit data. ADR-0012 §5 §E.
 *
 * `null` when validation passed (no detail to record) and on pre-stream
 * exits (no validation ran).
 */
type CitationValidationDetail =
  | null
  | { offending_ids: string[] }
  | { inline_only: string[]; sources_only: string[] }
  | { count: number }
  | { trailing: string };

// ── Request validation ─────────────────────────────────────────────────────

/**
 * Zod-validates the body shape AND rejects queries that are empty,
 * whitespace-only, or punctuation-only (no letters/numbers in any
 * Unicode script). Punctuation-only would slip past `z.string().min(1)`
 * and become an empty `websearch_to_tsquery` downstream, surfacing as
 * `no_content` and misleading users into thinking we found nothing.
 * ADR-0013 §4 mandates the 400 at the route layer; this is its impl.
 *
 * Discriminator: each issue carries `params: { reason: "empty" | "no_searchable" }`
 * so the 400-code mapping is stable against Zod issue-ordering or
 * message-text changes.
 */
const RequestBody = z
  .object({
    query: z.string(),
  })
  .superRefine((data, ctx) => {
    if (data.query.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["query"],
        message: "query is empty or whitespace",
        params: { reason: "empty" },
      });
      return;
    }
    // Require at least one Unicode letter or digit — strips punctuation-only
    // queries like "---" or "?!?". Hebrew, Arabic, CJK all fall under \p{L}.
    if (!/[\p{L}\p{N}]/u.test(data.query)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["query"],
        message: "query has no searchable characters",
        params: { reason: "no_searchable" },
      });
    }
  });

// ── SSE event vocabulary ───────────────────────────────────────────────────

// Use QueryEvent from lib/query-chat-state to keep wire shape and reducer
// in lockstep — drift between the two would compile-pass and runtime-fail.

type QueryCandidate = Extract<QueryEvent, { kind: "candidates" }>["entries"][number];

// ── Audit-row helper ───────────────────────────────────────────────────────

type AuditPayload = {
  query: string;
  role: Role;
  sensitivity_allowed: Sensitivity[];
  candidate_count: number;
  embedding_model: string;
  embedding_version: string;
  synthesizer_model: string | null;
  synthesizer_version: string | null;
  keyword_only: true;
  degraded: true;
  degraded_reason: typeof ROW_8_REASON | "synth_unavailable" | "embedder_config";
  status: "ok" | "error";
  error?: string;
  // ── Citation-validation provenance (ADR-0012 §5 + §E) ────────────────────
  /** Final citation set on the `done` event; [] on validation-fail / pre-stream exits. */
  citation_ids: string[];
  /** "ok" on first-or-second-attempt pass; a failure-reason discriminant otherwise. */
  citation_validation_outcome: CitationValidationOutcome | null;
  /**
   * Per-reason payload from the final (post-retry) validation attempt.
   * Carries `offending_ids` / `inline_only,sources_only` / `count` / `trailing`
   * depending on the failure variant — preserves the validator's
   * discriminated-union content for forensic replay + 2c-ii prompt tuning.
   */
  citation_validation_detail: CitationValidationDetail;
  /** True iff the route invoked synth a second time with the stricter prefix. */
  retry_attempted: boolean;
  /** SHA-256 hex of {@link STRICTER_PROMPT_PREFIX} when retry fired; null otherwise. */
  retry_prefix_hash: string | null;
};

async function writeAuditRow(payload: AuditPayload): Promise<void> {
  try {
    await getDb()
      .insert(schema.audit_log)
      .values({
        kind: "agent_retrieval",
        prompt_hash: RETRIEVAL_AGENT_PROMPT_HASH,
        payload: {
          ...payload,
          // Redact secrets from both query and error before persisting.
          // The audit_log is privileged, but a future debug endpoint
          // exposing payload would leak any Bearer / sk-* / pa-* literal
          // that snuck through (e.g., user pasted a token in their query).
          query: redactSecrets(payload.query),
          ...(payload.error ? { error: redactSecrets(payload.error).slice(0, 500) } : {}),
        },
      });
  } catch {
    // Audit-write failure is non-fatal — the request has already
    // produced its user-visible outcome. Surfacing a write error
    // post-stream is worse than dropping the audit row.
  }
}

// ── Handler ────────────────────────────────────────────────────────────────

async function handler(req: NextRequest, _ctx: unknown, role: Role): Promise<Response> {
  // 1. PARSE + VALIDATE BEFORE OPENING SSE.
  //    Once SSE Content-Type is on the wire we cannot retract to a JSON
  //    400; all rejections must happen pre-stream.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return jsonError(400, "invalid_json");
  }

  const parsed = RequestBody.safeParse(rawBody);
  if (!parsed.success) {
    // Stable discriminator: superRefine emits `params: { reason }` on each
    // custom issue. Pick the first custom issue's reason; treat the
    // wrong-shape case (rawBody.query missing or not a string → ZodInvalidTypeIssue)
    // as "query_invalid".
    const firstCustom = parsed.error.issues.find((i) => i.code === "custom");
    const reason =
      firstCustom && "params" in firstCustom
        ? (firstCustom.params as { reason?: string } | undefined)?.reason
        : undefined;
    return jsonError(400, reason === "empty" ? "query_empty" : "query_invalid");
  }
  const query = parsed.data.query;
  const sensitivityAllowed = sensitivityAllowedForRole(role);

  // 2. ATTRIBUTION ONLY — never .embed() in this slice.
  //    Iron rule #9 audit attribution: record the embedder that WOULD
  //    have run. If getEmbedder itself throws a config error (unknown
  //    provider), write an audit row, then bubble as 500. The config-
  //    error path is forensically interesting: a misconfigured prod env
  //    should be reconstructable from audit_log alone.
  let embeddingModel: string;
  let embeddingVersion: string;
  try {
    const e = getEmbedder();
    embeddingModel = e.model;
    embeddingVersion = e.version;
  } catch (err) {
    if (err instanceof EmbeddingUnavailableError) {
      // Defensive — the lazy factory shouldn't reach this in dev. If it
      // does, the configured embedder is unreachable; keyword lane is
      // still viable, but we cannot fill attribution. Record sentinels.
      embeddingModel = "unavailable";
      embeddingVersion = "unavailable";
    } else {
      await writeAuditRow({
        query,
        role,
        sensitivity_allowed: sensitivityAllowed,
        candidate_count: 0,
        embedding_model: "config_error",
        embedding_version: "config_error",
        synthesizer_model: null,
        synthesizer_version: null,
        keyword_only: true,
        degraded: true,
        degraded_reason: "embedder_config",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
        citation_ids: [],
        citation_validation_outcome: null,
        citation_validation_detail: null,
        retry_attempted: false,
        retry_prefix_hash: null,
      });
      return jsonError(500, "embedder_config");
    }
  }

  // 3. SYNTH FACTORY — surface SynthUnavailableError as 503 BEFORE the
  //    stream opens (cannot emit an SSE error after Content-Type SSE
  //    is committed). Slice 3 full will move this into the SSE error
  //    event when the live synth is wired with breakers.
  let synth;
  try {
    synth = getSynthesizer();
  } catch (err) {
    if (err instanceof SynthUnavailableError) {
      await writeAuditRow({
        query,
        role,
        sensitivity_allowed: sensitivityAllowed,
        candidate_count: 0,
        embedding_model: embeddingModel,
        embedding_version: embeddingVersion,
        synthesizer_model: null,
        synthesizer_version: null,
        keyword_only: true,
        degraded: true,
        degraded_reason: "synth_unavailable",
        status: "error",
        error: err.message,
        citation_ids: [],
        citation_validation_outcome: null,
        citation_validation_detail: null,
        retry_attempted: false,
        retry_prefix_hash: null,
      });
      return jsonError(503, "synth_unavailable");
    }
    await writeAuditRow({
      query,
      role,
      sensitivity_allowed: sensitivityAllowed,
      candidate_count: 0,
      embedding_model: embeddingModel,
      embedding_version: embeddingVersion,
      synthesizer_model: null,
      synthesizer_version: null,
      keyword_only: true,
      degraded: true,
      degraded_reason: ROW_8_REASON,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
      citation_ids: [],
      citation_validation_outcome: null,
      citation_validation_detail: null,
      retry_attempted: false,
      retry_prefix_hash: null,
    });
    return jsonError(500, "synth_config");
  }

  // 4. OPEN STREAM. All errors from here on emit a {kind:"error"} event;
  //    the audit_log keeps degraded_reason = ROW_8_REASON (this route is
  //    permanently row 8 by construction) and surfaces the failure mode
  //    via payload.status + payload.error.
  const enc = new TextEncoder();

  let candidateCount = 0;
  let outcomeStatus: "ok" | "error" = "ok";
  let errorMessage: string | undefined;
  let citationIds: string[] = [];
  let citationValidationOutcome: CitationValidationOutcome | null = null;
  let citationValidationDetail: CitationValidationDetail = null;
  let retryAttempted = false;
  let retryPrefixHash: string | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: QueryEvent): void => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          // Stream already closed.
        }
      };

      try {
        // 4a. KEYWORD LANE — sensitivity compiled into SQL WHERE by helper.
        const candidates = await keywordCandidates(
          getPool(),
          query,
          sensitivityAllowed,
          TOP_K_CANDIDATES,
        );
        candidateCount = candidates.length;

        if (candidates.length === 0) {
          send({ kind: "no_content" });
          return;
        }

        // 4b. FETCH top-N entry display rows.
        const topNIds = candidates.slice(0, TOP_N_SYNTH).map((c) => c.entry_id);
        const db = getDb();
        const entryRows = await db
          .select({
            id: schema.entries.id,
            title: schema.entries.title,
            category: schema.entries.category,
            body: schema.entries.body,
            sensitivity: schema.entries.sensitivity,
            last_verified_at: schema.entries.last_verified_at,
          })
          .from(schema.entries)
          .where(inArray(schema.entries.id, topNIds));

        // Preserve keyword-rank order (the select returns DB order, not
        // ranked order). Map by id, then re-order by candidates[i].entry_id.
        const byId = new Map(entryRows.map((r) => [r.id, r]));
        const orderedEntries = topNIds
          .map((id) => byId.get(id))
          .filter((r): r is NonNullable<typeof r> => r !== undefined);

        const candidateEvents: QueryCandidate[] = orderedEntries.map((r) => ({
          entry_id: r.id,
          title: r.title,
          category: r.category,
          sensitivity: r.sensitivity,
          last_verified_at: r.last_verified_at.toISOString(),
        }));

        send({ kind: "candidates", entries: candidateEvents });

        // 4c. SYNTHESIZE answer over the top-N bodies.
        //
        // Slice 2c-i intentionally passes the same `# title\nbody` context
        // shape as M3 item 2 — buildSynthContext (lib/retrieval-synth-input.ts)
        // requires a Voyage rerank score per chunk, which does not exist in
        // the keyword-bare row-8 path. The structured-context wire-up lands
        // in 2c-ii alongside the rerank lane.
        const context = orderedEntries.map((r) => `# ${r.title}\n${r.body}`);

        // 4d. VALIDATE CITATIONS — ADR-0012 §5 mechanical floor for iron rule #3.
        //
        // Two attempts max: the first uses RETRIEVAL_AGENT_PROMPT verbatim;
        // on validation fail, the second prepends STRICTER_PROMPT_PREFIX
        // (route-layer adjuster, hashed separately as
        // RETRIEVAL_RETRY_PREFIX_HASH and audit-traced). A second-attempt
        // failure surfaces as {kind:"error", code:"citation_validation_failed"}
        // and stops the §5 retry chain — ADR-0012 §5 explicitly forbids
        // retry-twice.
        const firstAttempt = await synth.synthesize(RETRIEVAL_AGENT_PROMPT, context);
        let validation = validateCitations(firstAttempt.answer, topNIds);

        if (!validation.ok) {
          retryAttempted = true;
          retryPrefixHash = RETRIEVAL_RETRY_PREFIX_HASH;
          const retryAttempt = await synth.synthesize(
            STRICTER_PROMPT_PREFIX + "\n\n" + RETRIEVAL_AGENT_PROMPT,
            context,
          );
          validation = validateCitations(retryAttempt.answer, topNIds);
        }

        if (!validation.ok) {
          // Both attempts failed validation. `degraded_reason` stays
          // ROW_8_REASON in this slice because the route is permanently
          // row 8 by construction (keyword-bare); 2c-ii's synth-ok rows
          // will flip to `citation_validation_failed` per ADR-0012 §3.
          // The forensic-replay payload is preserved in
          // `citation_validation_detail` per the validator's
          // discriminated-union failure shape — drops nothing.
          citationValidationOutcome = validation.reason;
          citationValidationDetail = detailFromValidation(validation);
          outcomeStatus = "error";
          errorMessage = `citation_validation_failed: ${validation.reason}`;
          send({ kind: "error", code: "citation_validation_failed" });
          return;
        }

        // Validation passed (on first OR second attempt). The validator
        // returns the Sources-stripped body and the dedup'd citation set.
        citationIds = validation.ids;
        citationValidationOutcome = "ok";
        send({ kind: "answer_delta", text: validation.body });
        send({ kind: "done", citation_ids: validation.ids });
      } catch (err) {
        outcomeStatus = "error";
        if (err instanceof SynthUnavailableError) {
          errorMessage = err.message;
          send({ kind: "error", code: "synth_unavailable" });
        } else if (isDbError(err)) {
          errorMessage = err instanceof Error ? err.message : String(err);
          send({ kind: "error", code: "db" });
        } else {
          errorMessage = err instanceof Error ? err.message : String(err);
          send({ kind: "error", code: "internal" });
        }
      } finally {
        // 5. AUDIT ROW — written once per request on every stream exit
        //    path (happy, no_content, mid-stream error). Pre-stream
        //    exits (400/500/503) write their own audit row before
        //    returning the JSON error.
        await writeAuditRow({
          query,
          role,
          sensitivity_allowed: sensitivityAllowed,
          candidate_count: candidateCount,
          embedding_model: embeddingModel,
          embedding_version: embeddingVersion,
          synthesizer_model: synth.model,
          synthesizer_version: synth.version,
          keyword_only: true,
          degraded: true,
          degraded_reason: ROW_8_REASON,
          status: outcomeStatus,
          ...(errorMessage ? { error: errorMessage } : {}),
          citation_ids: citationIds,
          citation_validation_outcome: citationValidationOutcome,
          citation_validation_detail: citationValidationDetail,
          retry_attempted: retryAttempted,
          retry_prefix_hash: retryPrefixHash,
        });

        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

function jsonError(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Map a {@link CitationValidationResult} failure variant to the
 * audit-row `citation_validation_detail` payload. Returns null for
 * {@link CitationValidationResult} ok-results and for variants that carry
 * no auxiliary payload (`sources_block_missing`, `sources_block_empty`).
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

function isDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // pg driver errors carry a `code` property (Postgres SQLSTATE) and a
  // `severity` field; either signal is enough for the audit branch.
  const e = err as Error & { code?: unknown; severity?: unknown };
  return typeof e.code === "string" || typeof e.severity === "string";
}

export const POST = withUserOrAdmin(handler);
