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
// ADR-0013 §5 citation-validation retry-once is SKIPPED in this slice —
// the stub synth's answer is deterministic and not subject to citation
// drift. Slice "M3 item 3 full" wires the live retry policy when the
// Anthropic Sonnet adapter lands.
//
// LogEvent: this slice does NOT emit a logEvent record — the audit_log
// row carries iron-rule-#9 attribution and forensic state. Adding a
// `kind:"voyage"` log here when no Voyage call ran pollutes downstream
// dashboards that aggregate Voyage cost/latency. Slice "M3 item 3 full"
// will add a dedicated `kind:"retrieval_pipeline"` LogEvent variant
// (BACKLOG Retrieval §"LogEvent discriminant for retrieval pipeline").
//
// CSRF posture: inherited from ADR-0010 Consequences — deferred to M5 with
// Microsoft Entra ID. Stub-auth header is the dev-only gate.

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
import type { QueryEvent } from "@/lib/query-chat-state";
import { stripSynthSourcesBlock } from "@/lib/retrieval-stub-strip";
import type { Sensitivity } from "@/drizzle/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hardcoded slice-1 caps. Slice 3 full will lift to env knobs following
// ADR-0012 §K convention (e.g., RETRIEVAL_KEYWORD_TOP_K, RETRIEVAL_SYNTH_TOP_N).
const TOP_K_CANDIDATES = 20;
const TOP_N_SYNTH = 5;
const ROW_8_REASON = "embed_rerank_synth_unavailable_keyword_bare" as const;

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
        const context = orderedEntries.map((r) => `# ${r.title}\n${r.body}`);
        const synthResult = await synth.synthesize(RETRIEVAL_AGENT_PROMPT, context);

        // Strip stub synth's sentinel Sources block — UI cites the real IDs.
        const cleanedAnswer = stripSynthSourcesBlock(synthResult.answer);
        send({ kind: "answer_delta", text: cleanedAnswer });

        send({ kind: "done", citation_ids: topNIds });
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

function isDbError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // pg driver errors carry a `code` property (Postgres SQLSTATE) and a
  // `severity` field; either signal is enough for the audit branch.
  const e = err as Error & { code?: unknown; severity?: unknown };
  return typeof e.code === "string" || typeof e.severity === "string";
}

export const POST = withUserOrAdmin(handler);
