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

import { createHash } from "node:crypto";

import { type NextRequest } from "next/server";
import { z } from "zod";

import * as schema from "@/drizzle/schema";
import { sensitivityAllowedForRole, withUserOrAdmin, type Role } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { EmbeddingUnavailableError, getEmbedder } from "@/lib/embedding";
import { logEvent, redactSecrets, type LogEventRetrievalPipeline } from "@/lib/log";
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

// ── Env knobs ──────────────────────────────────────────────────────────────

/**
 * Read a positive-integer env var with a fallback. Throws `RangeError` on
 * non-integer or non-positive values rather than silently coercing — a
 * stray `RETRIEVAL_KEEPALIVE_MS="-5"` would otherwise become a 1ms flood
 * loop via `setInterval` clamping. Mirrors `app/api/agent/ingest/route.ts:80`.
 */
function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${raw}`);
  }
  return n;
}

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

// ── Retrieval-pipeline log emitter (ADR-0012 §8, ADR-0005 amendment 2026-05-23) ──

/**
 * Compute the 16-hex-char `query_hash` field per ADR-0005 amendment
 * 2026-05-23. Trim-normalized so leading/trailing whitespace doesn't fork the
 * hash; secrets stripped via {@link redactSecrets} before hashing so accidental
 * key-paste in a query doesn't burn into the log file. Scope is
 * log-correlation only — NOT a cache key (collision-prone at 64 bits).
 */
function computeQueryHash(query: string): string {
  return createHash("sha256").update(redactSecrets(query.trim())).digest("hex").slice(0, 16);
}

/**
 * Emit one `kind:"retrieval_pipeline"` NDJSON line summarizing this request.
 *
 * Called from every terminal route path EXCEPT the 401-from-`withUserOrAdmin`
 * short-circuit — that path returns before `handler` runs so neither `t0`
 * nor `role` is in scope; by-design no line is emitted (ADR-0005 amendment
 * 2026-05-23 documents the gap).
 *
 * On the orchestrator-uncaught-throw branch use
 * {@link emitOnOrchestratorThrow} instead — that helper omits
 * `retry_attempted` / `keyword_only` / `citation_validation_outcome` from
 * the wire rather than reporting the synthetic placeholder values from
 * `preStreamErrorOutcome`.
 */
function emitRetrievalPipelineLog(args: {
  outcome: AuditOutcome | null;
  query?: string;
  role: Role | "unknown";
  t0: number;
  status: "ok" | "error";
  error?: string;
}): void {
  const { outcome, query, role, t0, status, error } = args;
  const event: LogEventRetrievalPipeline = {
    kind: "retrieval_pipeline",
    latency_ms: Date.now() - t0,
    cost_usd: null,
    role,
    degraded: outcome?.degraded ?? false,
    citation_validation_outcome: outcome?.citation_validation_outcome ?? null,
    retry_attempted: outcome?.retry_attempted ?? false,
    keyword_only: outcome?.keyword_only ?? false,
  };
  if (status) event.status = status;
  if (error) event.error = error;
  if (query !== undefined) event.query_hash = computeQueryHash(query);
  if (outcome?.degraded_reason !== undefined) {
    event.degraded_reason = outcome.degraded_reason as LogEventRetrievalPipeline["degraded_reason"];
  }
  logEvent(event);
}

/**
 * Emit a `kind:"retrieval_pipeline"` line for the orchestrator-uncaught
 * exception path. Omits `retry_attempted` / `keyword_only` /
 * `citation_validation_outcome`-as-anything-but-null rather than emitting the
 * `preStreamErrorOutcome` synthetic placeholders, which would lie about
 * in-flight state at the moment of throw.
 */
function emitOnOrchestratorThrow(args: {
  query: string;
  role: Role;
  t0: number;
  error: string;
}): void {
  const { query, role, t0, error } = args;
  logEvent({
    kind: "retrieval_pipeline",
    latency_ms: Date.now() - t0,
    cost_usd: null,
    role,
    degraded: true,
    citation_validation_outcome: null,
    retry_attempted: false,
    keyword_only: false,
    status: "error",
    error,
    query_hash: computeQueryHash(query),
  });
}

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
  // Captured first thing so the `retrieval_pipeline` log line on EVERY
  // terminal path measures wall-clock from request entry. Pre-stream
  // resolution time (embedder/synth/reranker factory) IS included by design
  // — observability of cold-start cost on the request-summary line.
  const t0 = Date.now();

  // 1. PARSE + VALIDATE pre-stream. Once Content-Type: text/event-stream
  //    commits we cannot retract to a JSON 400.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    emitRetrievalPipelineLog({
      outcome: null,
      role,
      t0,
      status: "error",
      error: "invalid_json",
    });
    return jsonError(400, "invalid_json");
  }
  const parsed = RequestBody.safeParse(rawBody);
  if (!parsed.success) {
    const firstCustom = parsed.error.issues.find((i) => i.code === "custom");
    const reason =
      firstCustom && "params" in firstCustom
        ? (firstCustom.params as { reason?: string } | undefined)?.reason
        : undefined;
    const code = reason === "empty" ? "query_empty" : "query_invalid";
    emitRetrievalPipelineLog({
      outcome: null,
      // Pass the raw query string if present so query_hash correlates even
      // for invalid-shape rejections; undefined when body was missing the field.
      query:
        typeof (rawBody as { query?: unknown })?.query === "string"
          ? (rawBody as { query: string }).query
          : undefined,
      role,
      t0,
      status: "error",
      error: code,
    });
    return jsonError(400, code);
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
      const outcome = preStreamErrorOutcome({
        query,
        role,
        embedding_model,
        embedding_version,
        synthesizer_model: null,
        synthesizer_version: null,
        degraded_reason: "embedder_config",
        error: err.message,
      });
      await writeAuditRow(outcome);
      emitRetrievalPipelineLog({
        outcome,
        query,
        role,
        t0,
        status: "error",
        error: err.message,
      });
      return jsonError(500, "embedder_config");
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    const outcome = preStreamErrorOutcome({
      query,
      role,
      embedding_model: "config_error",
      embedding_version: "config_error",
      synthesizer_model: null,
      synthesizer_version: null,
      degraded_reason: "embedder_config",
      error: errorMsg,
    });
    await writeAuditRow(outcome);
    emitRetrievalPipelineLog({
      outcome,
      query,
      role,
      t0,
      status: "error",
      error: errorMsg,
    });
    return jsonError(500, "embedder_config");
  }

  // 3. RESOLVE SYNTH for attribution + pre-stream 503 path.
  let synth;
  try {
    synth = getSynthesizer();
  } catch (err) {
    if (err instanceof SynthUnavailableError) {
      const outcome = preStreamErrorOutcome({
        query,
        role,
        embedding_model,
        embedding_version,
        synthesizer_model: null,
        synthesizer_version: null,
        degraded_reason: "synth_unavailable",
        error: err.message,
      });
      await writeAuditRow(outcome);
      emitRetrievalPipelineLog({
        outcome,
        query,
        role,
        t0,
        status: "error",
        error: err.message,
      });
      return jsonError(503, "synth_unavailable");
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    const outcome = preStreamErrorOutcome({
      query,
      role,
      embedding_model,
      embedding_version,
      synthesizer_model: null,
      synthesizer_version: null,
      degraded_reason: "synth_config",
      error: errorMsg,
    });
    await writeAuditRow(outcome);
    emitRetrievalPipelineLog({
      outcome,
      query,
      role,
      t0,
      status: "error",
      error: errorMsg,
    });
    return jsonError(500, "synth_config");
  }

  // 4. RESOLVE RERANKER — config error pre-stream; transient
  //    RerankUnavailableError is caught by the orchestrator as the matrix's
  //    rerank-fail branch.
  let reranker;
  try {
    reranker = getReranker();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const outcome = preStreamErrorOutcome({
      query,
      role,
      embedding_model,
      embedding_version,
      synthesizer_model: synth.model,
      synthesizer_version: synth.version,
      degraded_reason: "synth_config",
      error: errorMsg,
    });
    await writeAuditRow(outcome);
    emitRetrievalPipelineLog({
      outcome,
      query,
      role,
      t0,
      status: "error",
      error: errorMsg,
    });
    return jsonError(500, "reranker_config");
  }

  // 5. OPEN STREAM and drive the orchestrator.
  const enc = new TextEncoder();
  // Keepalive heartbeat (`: keepalive\n\n` SSE comment per WHATWG §9.2.6)
  // keeps proxies / CDNs from dropping the connection during the ADR-0012
  // §5 retry window (up to 2× synth round-trip ≈ 10-30s × 2 with live
  // Anthropic synth). Pattern mirrors `app/api/agent/ingest/route.ts:381-454`.
  // Hoisted above the stream construction so `cancel()` can clear it on
  // consumer-abort before `start.finally` would have fired.
  const keepaliveMs = readPositiveInt("RETRIEVAL_KEEPALIVE_MS", 10_000);
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: QueryEvent): void => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          // Stream already closed (consumer disconnect).
        }
      };

      keepaliveTimer = setInterval(() => {
        try {
          controller.enqueue(enc.encode(": keepalive\n\n"));
        } catch {
          // Stream already closed (consumer disconnect).
        }
      }, keepaliveMs);

      const gen = retrievePipeline({ embedder, reranker, synth }, { query, role });
      let outcome: AuditOutcome | undefined;
      let orchestratorThrewError: string | null = null;
      try {
        outcome = await drainPipelineEvents(gen, send);
      } catch (err) {
        // Orchestrator threw an uncaught error (DB failure, etc.). Emit a
        // generic error event and synthesize a minimal audit outcome — we
        // lost the orchestrator's accumulated state.
        send({ kind: "error", code: isDbError(err) ? "db" : "internal" });
        const errorMsg = err instanceof Error ? err.message : String(err);
        orchestratorThrewError = errorMsg;
        outcome = preStreamErrorOutcome({
          query,
          role,
          embedding_model,
          embedding_version,
          synthesizer_model: synth.model,
          synthesizer_version: synth.version,
          degraded_reason: "synth_config",
          error: errorMsg,
        });
      } finally {
        if (keepaliveTimer) clearInterval(keepaliveTimer);
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
        // ADR-0012 §8 + ADR-0005 amendment 2026-05-23: one `retrieval_pipeline`
        // line per request, AFTER writeAuditRow, BEFORE controller.close().
        // Orchestrator-throw branch uses a separate emitter that omits
        // retry/keyword/citation rather than reporting the synthetic
        // preStreamErrorOutcome placeholders (which would lie about
        // in-flight state at the moment of throw).
        if (orchestratorThrewError !== null) {
          emitOnOrchestratorThrow({ query, role, t0, error: orchestratorThrewError });
        } else {
          emitRetrievalPipelineLog({
            outcome: outcome ?? null,
            query,
            role,
            t0,
            status: outcome?.status === "error" ? "error" : "ok",
            error: outcome?.error,
          });
        }
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      }
    },
    cancel() {
      // Defensive: `start.finally` already clears the timer, but if the
      // consumer cancels before `start` returns and before any keepalive
      // tick has run, clearing here avoids the gap. Mirrors agent/ingest/route.ts:449.
      if (keepaliveTimer) clearInterval(keepaliveTimer);
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
