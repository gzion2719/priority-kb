/**
 * Structured JSON log helper for Claude / Voyage API calls.
 *
 * Emits one NDJSON line per call event to the module-level sink (default:
 * `process.stdout`). The wire format is locked in ADR-0005; every M2a/M3
 * call site MUST use this helper.
 *
 * Iron-rule enforcement (compile-time, with runtime backstops):
 *   - Non-negotiable #10: `prompt_hash` is required for `kind: "claude"`.
 *   - Non-negotiable #9:  `model` + `model_version` required for every event.
 *   - ROADMAP M1:         `cost_usd: number | null` — `null` documents
 *                         "unknown" as a deliberate caller decision. The
 *                         compile-time guarantee is reinforced by a runtime
 *                         check that throws if the field is `undefined` or
 *                         a non-number (smuggled through `as any`).
 *   - Latency:            `latency_ms` must be a finite non-negative number;
 *                         NaN, ±Infinity, or negative values throw.
 *
 * Runtime: Node only. Next.js route handlers that import this MUST NOT run
 * on the edge runtime (`process.stdout` is unavailable there). When
 * `process.stdout` is missing, the default sink returns silently.
 *
 * Sink contract: `logEvent` is synchronous-write-by-contract — the sink is
 * called exactly once per invocation with one NDJSON-terminated line. Sink
 * errors are caught and swallowed: observability must NEVER break the API
 * call path. A serialization failure (e.g. circular structure smuggled into
 * `error` via `as any`) degrades to a minimal
 * `{"ts":..,"kind":..,"status":"error","error":"log serialization failed"}`
 * line.
 *
 * Secret hygiene: the helper applies a best-effort redaction pass to the
 * `error` field (Bearer tokens, Authorization headers, `sk-…` / `pa-…` API
 * keys) before truncation. This is a thin safety net to close the
 * log-channel exfil surface this helper introduces; callers MUST still
 * redact known PII before passing. Full PII pass is M2b's responsibility.
 *
 * See `docs/adr/0005-log-event-schema.md`.
 */

import type { DegradedReasonCode } from "@/lib/retrieval-degraded";
import type { CitationValidationOutcome } from "@/lib/retrieval";

export type Tokens = {
  input?: number;
  output?: number;
  total?: number;
};

export type LogStatus = "ok" | "error";

interface LogEventBase {
  /** Model identifier. Non-negotiable #9. */
  model: string;
  /** Model version. Non-negotiable #9 + ROADMAP M1. */
  model_version: string;
  tokens?: Tokens;
  /** Latency in milliseconds; finite and non-negative. */
  latency_ms: number;
  /**
   * Cost in USD. `null` documents "unknown" as a deliberate caller decision.
   * ROADMAP M1 lists `cost` in the required-fields list; omission is a
   * compile error AND a runtime throw.
   */
  cost_usd: number | null;
  /** Free-form request id; prefer the SDK-provided id when available. */
  request_id?: string;
  status?: LogStatus;
  /**
   * Error string. Subject to:
   *   1. Best-effort secret redaction (Bearer / Authorization / sk- / pa-).
   *   2. Truncation to {@link ERROR_MAX_LEN} characters.
   * Caller MUST still redact known-sensitive PII before passing.
   */
  error?: string;
  /**
   * @internal — the helper injects `ts` itself. `ts?: never` blocks callers
   * from passing one even when widening through a structural cast.
   */
  ts?: never;
}

export interface LogEventClaude extends LogEventBase {
  kind: "claude";
  /** SHA-256 of the prompt file content. Non-negotiable #10. */
  prompt_hash: string;
  /**
   * Number of tool-use round-trips inside a single agent turn (ADR-0010
   * §3). Present for the SSE-driven agent path; absent for one-shot
   * Retrieval-Agent calls (M3). Optional so the field is omitted from
   * the NDJSON line when unset, keeping non-agent log lines unchanged.
   */
  tool_iterations?: number;
  /**
   * `true` for the SSE-streaming agent path (ADR-0010 §1); absent for
   * one-shot non-streaming Claude calls. Optional so the field is
   * omitted from the NDJSON line when unset.
   */
  streaming?: boolean;
}

export interface LogEventVoyage extends LogEventBase {
  kind: "voyage";
}

/**
 * Pre-stream config-error sentinels emitted on the route's pre-stream paths
 * (embedder/synth/reranker factory throws). NOT in {@link DegradedReasonCode}
 * — those are matrix outcomes; these are upstream-of-the-matrix failures.
 * Mirrors the sentinel set in {@link app/api/retrieve/route.ts}'s
 * `preStreamErrorOutcome`.
 */
export type PreStreamConfigReason = "embedder_config" | "synth_config" | "synth_unavailable";

/**
 * Request-level summary event for the `/api/retrieve` pipeline.
 *
 * Intentionally does NOT extend {@link LogEventBase}: the aggregate event
 * spans three different vendor model calls (embed, rerank, synth) and naming
 * a single "model" would be a lie. Per-vendor identity lives on the
 * `kind:"voyage"` / `kind:"claude"` lines and on the `audit_log` row's
 * `embedding_model` / `synthesizer_model` fields. ADR-0005 amendment
 * 2026-05-23 names this as the second variant (alongside the open
 * `kind:"route"` BACKLOG item) without the `LogEventBase` shape.
 *
 * `cost_usd` is always `null` here — aggregate costs are summable from the
 * per-vendor lines; reporting a number would double-count. The field is
 * present so the {@link logEvent} cost-type runtime guard permits the line
 * uniformly across variants.
 *
 * The `error` field passes through the same redact-then-truncate pipeline as
 * the other variants (see {@link logEvent}).
 *
 * `keyword_only` is technically derivable from {@link degraded_reason}
 * (any `embed_*_keyword_*` or `no_keyword_match_under_embed_outage`), but
 * exposing both is cheap and lets log consumers filter on either without
 * pattern-matching the reason string.
 */
export interface LogEventRetrievalPipeline {
  kind: "retrieval_pipeline";
  /** Total end-to-end latency including pre-stream config-resolution. */
  latency_ms: number;
  /**
   * Always `null` for this variant — see interface JSDoc. Present so the
   * runtime cost-type guard fires uniformly across variants.
   */
  cost_usd: number | null;
  status?: LogStatus;
  /** Subject to redact + truncate (same pipeline as other variants). */
  error?: string;
  /**
   * Pipeline-level correlation id; intentionally a DIFFERENT field name from
   * the per-vendor SDK `request_id` (omitted from this variant to avoid
   * overloading the dashboard correlation key). Optional — populated when
   * the route layer surfaces one.
   */
  pipeline_request_id?: string;
  /**
   * SHA-256(redactSecrets(query.trim())) first 16 hex chars. Log-correlation
   * scope ONLY — NOT a cache key. Omitted on the JSON-parse-400 path where
   * no query was extractable.
   */
  query_hash?: string;
  /** Role string from stub-auth; decoupled from `auth.ts` `Role` union. */
  role: string;
  degraded: boolean;
  /**
   * Matrix `DegradedReasonCode` OR pre-stream config sentinel
   * (`embedder_config` / `synth_config` / `synth_unavailable`). Typed as the
   * explicit union so a future enum addition compiles loudly.
   */
  degraded_reason?: DegradedReasonCode | PreStreamConfigReason;
  /**
   * Validator outcome discriminant; `null` when validation never ran (synth
   * absent, pre-stream error, no-content terminal). Imported as type-only
   * from `lib/retrieval` — purely compile-time coupling, erased at runtime.
   */
  citation_validation_outcome: CitationValidationOutcome | null;
  retry_attempted: boolean;
  keyword_only: boolean;
  /**
   * @internal — the helper injects `ts` itself; `ts?: never` blocks callers
   * from passing one even when widening through a structural cast.
   */
  ts?: never;
}

/**
 * Route-layer-or-dispatch error event NOT attributable to a single vendor
 * call. Emitted by the catch-all paths in `app/api/ingest/route.ts`,
 * `app/api/ingest/[id]/route.ts`, and `app/api/agent/ingest/route.ts`'s
 * `dispatchTool` — sites where the failure happened in our own request
 * plumbing (Zod validation post-Zod fall-through, ORM error, dispatch
 * recovery), not in an outbound Voyage/Anthropic SDK call.
 *
 * Intentionally does NOT extend {@link LogEventBase}: there is no vendor
 * `model` / `model_version` to attribute, and the original
 * `kind:"voyage", model:"route", model_version:"ingest"` pollution that
 * this variant replaces violated dashboards that group by `kind`. Same
 * carve-out rationale as {@link LogEventRetrievalPipeline} (ADR-0005
 * Amendment 2026-05-23 §1) — iron rules #9/#10 don't apply when no
 * vendor call was made, so there is nothing to attribute and the type
 * level enforcement is vacuously satisfied.
 *
 * `cost_usd` is always `null` here — no vendor cost was incurred. The
 * field is present so the {@link logEvent} cost-type runtime guard fires
 * uniformly across variants without a per-kind branch.
 *
 * The `error` field passes through the same redact-then-truncate
 * pipeline as the other variants (see {@link logEvent}).
 *
 * `latency_ms` is typically `0` on these catch-all paths — they're
 * recovery sites, not timed operations. Dashboards that average latency
 * by `kind` should filter on `status:"error"` first.
 *
 * No `request_id` field: there is no SDK call whose id we could carry.
 * Sibling variant's `pipeline_request_id` is for spanning multiple
 * vendor calls — not applicable here.
 */
export interface LogEventRoute {
  kind: "route";
  /**
   * Stable `METHOD path` label dashboards group by — e.g.
   * `"POST /api/ingest"`. Keep this symmetric across sites so a future
   * dashboard `GROUP BY route` doesn't see phantom rows that don't
   * correspond to a real endpoint.
   */
  route: string;
  /** Finite, non-negative. Typically `0` on catch-all paths. */
  latency_ms: number;
  /**
   * Always `null` for this variant — no vendor invoked, no cost. Field
   * is present so the runtime cost-type guard permits the line uniformly
   * across variants.
   */
  cost_usd: number | null;
  status?: LogStatus;
  /** Subject to redact + truncate (same pipeline as other variants). */
  error?: string;
  /**
   * @internal — the helper injects `ts` itself; `ts?: never` blocks
   * callers from passing one even when widening through a structural
   * cast.
   */
  ts?: never;
}

export type LogEvent = LogEventClaude | LogEventVoyage | LogEventRetrievalPipeline | LogEventRoute;

/** Maximum length of the `error` field after redaction; longer is truncated. */
export const ERROR_MAX_LEN = 500;

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._\-~+/=]+/gi, "Bearer [REDACTED]"],
  [/Authorization:\s*\S+/gi, "Authorization: [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[REDACTED]"],
  [/\bpa-[A-Za-z0-9_-]{8,}/g, "pa-[REDACTED]"],
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

type Writer = (chunk: string) => unknown;

function defaultSink(chunk: string): boolean {
  if (typeof process === "undefined" || !process.stdout) {
    return false;
  }
  return process.stdout.write(chunk);
}

let sink: Writer = defaultSink;

/** Swap the log sink. Intended for tests. */
export function setLogSink(fn: Writer): void {
  sink = fn;
}

/** Restore the default sink (writes one NDJSON line to `process.stdout`). */
export function resetLogSink(): void {
  sink = defaultSink;
}

/**
 * Emit one structured-JSON log line for a Claude or Voyage API call.
 *
 * @throws TypeError if `latency_ms` is not a finite non-negative number,
 *   or if `cost_usd` is neither `null` nor a number.
 */
export function logEvent(event: LogEvent): void {
  if (!Number.isFinite(event.latency_ms) || event.latency_ms < 0) {
    throw new TypeError(
      `logEvent: latency_ms must be a finite non-negative number, got ${String(event.latency_ms)}`,
    );
  }
  if (event.cost_usd !== null && typeof event.cost_usd !== "number") {
    throw new TypeError(
      `logEvent: cost_usd must be a number or null, got ${typeof event.cost_usd}`,
    );
  }

  // Spread event first, `ts` last → helper-injected timestamp always wins.
  const payload: Record<string, unknown> = {
    ...event,
    ts: new Date().toISOString(),
  };

  if (typeof event.error === "string") {
    const redacted = redactSecrets(event.error);
    payload.error = redacted.length > ERROR_MAX_LEN ? redacted.slice(0, ERROR_MAX_LEN) : redacted;
  }

  let line: string;
  try {
    line = JSON.stringify(payload) + "\n";
  } catch {
    line =
      JSON.stringify({
        ts: new Date().toISOString(),
        kind: event.kind,
        status: "error",
        error: "log serialization failed",
      }) + "\n";
  }

  try {
    sink(line);
  } catch {
    // Observability must never break the API call path.
  }
}
