// app/api/retrieve/route.ts — M3 stage E sub-slice 2c-ii thin route.
//
// SSE retrieval route. The 8-row ADR-0013 §3 degraded matrix and all stage
// orchestration lives in `lib/retrieval-pipeline.ts`. This file owns:
//
//   1. Request parsing + Zod validation (ADR-0013 §4 §M5 empty-query 400).
//   2. Pre-stream config-error resolution (embedder/synth singleton failures
//      that can't be surfaced as SSE events because the Content-Type isn't
//      committed yet).
//   3. SSE transport: encoding `data: <json>\n\n` per yielded QueryEvent.
//   4. Manual iterator drive of the orchestrator generator — `for await ...
//      of gen` discards the terminal return value, which is the entire
//      audit row.
//   5. Generator finalize on stream cancel — `try { ... } finally { gen.return?.() }`
//      releases lane DB transactions if the SSE consumer disconnects.
//   6. Audit-row write from the orchestrator's returned {@link AuditOutcome}.
//
// Iron-rule wiring is unchanged from slice 2c-i; the orchestrator now owns
// the per-row implementation. CSRF posture: inherited from ADR-0010 — stub
// auth header is the dev-only gate; M5 brings Microsoft Entra ID.

import { type NextRequest } from "next/server";
import { z } from "zod";

import * as schema from "@/drizzle/schema";
import { sensitivityAllowedForRole, withUserOrAdmin, type Role } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { EmbeddingUnavailableError, getEmbedder } from "@/lib/embedding";
import { redactSecrets } from "@/lib/log";
import { RETRIEVAL_AGENT_PROMPT_HASH } from "@/lib/prompts";
import { SynthUnavailableError, getReranker, getSynthesizer } from "@/lib/retrieval";
import { RETRIEVAL_RETRY_PREFIX_HASH, STRICTER_PROMPT_PREFIX } from "@/lib/retrieval-retry-prefix";
import { drainPipelineEvents, retrievePipeline, type AuditOutcome } from "@/lib/retrieval-pipeline";
import type { QueryEvent } from "@/lib/query-chat-state";

// Re-exports retained for callers that imported these constants from the
// route in earlier slices; the canonical site is now `lib/retrieval-retry-prefix`.
export { RETRIEVAL_RETRY_PREFIX_HASH, STRICTER_PROMPT_PREFIX };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ── Request validation ─────────────────────────────────────────────────────

/**
 * Zod-validates the body shape AND rejects queries that are empty,
 * whitespace-only, or punctuation-only (no letters/numbers in any Unicode
 * script). Per ADR-0013 §4 §M5 the 400 fires at the route layer; the
 * orchestrator + keyword/ANN helpers all assume non-empty input.
 *
 * Discriminator: each issue carries `params: { reason }` so the 400-code
 * mapping is stable against Zod issue-ordering or message-text changes.
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
    if (!/[\p{L}\p{N}]/u.test(data.query)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["query"],
        message: "query has no searchable characters",
        params: { reason: "no_searchable" },
      });
    }
  });

// ── Audit-row writer ───────────────────────────────────────────────────────

async function writeAuditRow(outcome: AuditOutcome): Promise<void> {
  try {
    await getDb()
      .insert(schema.audit_log)
      .values({
        kind: "agent_retrieval",
        prompt_hash: RETRIEVAL_AGENT_PROMPT_HASH,
        payload: {
          ...outcome,
          // Redact secrets from both query and error before persisting.
          query: redactSecrets(outcome.query),
          ...(outcome.error ? { error: redactSecrets(outcome.error).slice(0, 500) } : {}),
        },
      });
  } catch {
    // Audit-write failure is non-fatal — the request has already produced
    // its user-visible outcome. Surfacing a write error post-stream is
    // worse than dropping the audit row.
  }
}

/**
 * Pre-stream config-error audit row. Returns a minimal {@link AuditOutcome}
 * shape sufficient for the audit-row schema; the orchestrator never ran, so
 * lane arrays and per-stage tokens stay empty.
 */
function preStreamErrorOutcome(args: {
  query: string;
  role: Role;
  embedding_model: string;
  embedding_version: string;
  synthesizer_model: string | null;
  synthesizer_version: string | null;
  degraded_reason: "embedder_config" | "synth_unavailable" | "synth_config";
  error: string;
}): AuditOutcome {
  // `degraded_reason` here intentionally uses the slice-2c-i pre-stream
  // sentinel values that are NOT in the DEGRADED_REASON_CODES enum — they
  // are pre-stream config-error markers, not matrix outcomes. The audit
  // payload is jsonb so the extra value is storable; analytics consumers
  // filtering on the matrix enum naturally skip these rows.
  return {
    query: args.query,
    role: args.role,
    sensitivity_allowed: sensitivityAllowedForRole(args.role),
    embedding_model: args.embedding_model,
    embedding_version: args.embedding_version,
    ann_candidate_ids: [],
    keyword_candidate_ids: [],
    fused_ids: [],
    rrf_k: 0,
    reranked_ids: [],
    citation_ids: [],
    keyword_only: false,
    tokens: { embed: 0, keyword: 0, rerank_input: 0, synth_input: 0, synth_output: 0 },
    latencies_ms: {},
    degraded: true,
    // Cast: pre-stream values intentionally outside the matrix enum.
    degraded_reason: args.degraded_reason as AuditOutcome["degraded_reason"],
    status: "error",
    error: args.error,
    synthesizer_model: args.synthesizer_model,
    synthesizer_version: args.synthesizer_version,
    citation_validation_outcome: null,
    citation_validation_detail: null,
    retry_attempted: false,
    retry_prefix_hash: null,
  };
}

// ── Handler ────────────────────────────────────────────────────────────────

async function handler(req: NextRequest, _ctx: unknown, role: Role): Promise<Response> {
  // 1. PARSE + VALIDATE pre-stream. Once Content-Type: text/event-stream
  //    commits we cannot retract to a JSON 400.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return jsonError(400, "invalid_json");
  }
  const parsed = RequestBody.safeParse(rawBody);
  if (!parsed.success) {
    const firstCustom = parsed.error.issues.find((i) => i.code === "custom");
    const reason =
      firstCustom && "params" in firstCustom
        ? (firstCustom.params as { reason?: string } | undefined)?.reason
        : undefined;
    return jsonError(400, reason === "empty" ? "query_empty" : "query_invalid");
  }
  const query = parsed.data.query;

  // 2. RESOLVE EMBEDDER for attribution + pre-stream config-error path.
  //    The orchestrator catches EmbeddingUnavailableError internally as the
  //    matrix's embed-fail branch; only RangeError (config error) is
  //    pre-stream.
  let embedding_model: string;
  let embedding_version: string;
  let embedder;
  try {
    embedder = getEmbedder();
    embedding_model = embedder.model;
    embedding_version = embedder.version;
  } catch (err) {
    if (err instanceof EmbeddingUnavailableError) {
      // Defensive — the lazy factory shouldn't reach this in dev. Treat as
      // pre-stream so we don't write a half-formed audit row.
      embedding_model = "unavailable";
      embedding_version = "unavailable";
      await writeAuditRow(
        preStreamErrorOutcome({
          query,
          role,
          embedding_model,
          embedding_version,
          synthesizer_model: null,
          synthesizer_version: null,
          degraded_reason: "embedder_config",
          error: err.message,
        }),
      );
      return jsonError(500, "embedder_config");
    }
    await writeAuditRow(
      preStreamErrorOutcome({
        query,
        role,
        embedding_model: "config_error",
        embedding_version: "config_error",
        synthesizer_model: null,
        synthesizer_version: null,
        degraded_reason: "embedder_config",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return jsonError(500, "embedder_config");
  }

  // 3. RESOLVE SYNTH for attribution + pre-stream 503 path.
  let synth;
  try {
    synth = getSynthesizer();
  } catch (err) {
    if (err instanceof SynthUnavailableError) {
      await writeAuditRow(
        preStreamErrorOutcome({
          query,
          role,
          embedding_model,
          embedding_version,
          synthesizer_model: null,
          synthesizer_version: null,
          degraded_reason: "synth_unavailable",
          error: err.message,
        }),
      );
      return jsonError(503, "synth_unavailable");
    }
    await writeAuditRow(
      preStreamErrorOutcome({
        query,
        role,
        embedding_model,
        embedding_version,
        synthesizer_model: null,
        synthesizer_version: null,
        degraded_reason: "synth_config",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return jsonError(500, "synth_config");
  }

  // 4. RESOLVE RERANKER — config error pre-stream; transient
  //    RerankUnavailableError is caught by the orchestrator as the matrix's
  //    rerank-fail branch.
  let reranker;
  try {
    reranker = getReranker();
  } catch (err) {
    await writeAuditRow(
      preStreamErrorOutcome({
        query,
        role,
        embedding_model,
        embedding_version,
        synthesizer_model: synth.model,
        synthesizer_version: synth.version,
        degraded_reason: "synth_config",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return jsonError(500, "reranker_config");
  }

  // 5. OPEN STREAM and drive the orchestrator.
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: QueryEvent): void => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          // Stream already closed (consumer disconnect).
        }
      };

      const gen = retrievePipeline({ embedder, reranker, synth }, { query, role });
      let outcome: AuditOutcome | undefined;
      try {
        outcome = await drainPipelineEvents(gen, send);
      } catch (err) {
        // Orchestrator threw an uncaught error (DB failure, etc.). Emit a
        // generic error event and synthesize a minimal audit outcome — we
        // lost the orchestrator's accumulated state.
        send({ kind: "error", code: isDbError(err) ? "db" : "internal" });
        outcome = preStreamErrorOutcome({
          query,
          role,
          embedding_model,
          embedding_version,
          synthesizer_model: synth.model,
          synthesizer_version: synth.version,
          degraded_reason: "synth_config",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        // Best-effort generator finalize — releases lane DB transactions if
        // the iterator stopped early (consumer disconnect, throw).
        try {
          await gen.return?.(undefined as never);
        } catch {
          // ignore
        }
        if (outcome) {
          await writeAuditRow(outcome);
        }
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
  const e = err as Error & { code?: unknown; severity?: unknown };
  return typeof e.code === "string" || typeof e.severity === "string";
}

export const POST = withUserOrAdmin(handler);
