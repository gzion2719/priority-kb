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
}

export interface LogEventVoyage extends LogEventBase {
  kind: "voyage";
}

export type LogEvent = LogEventClaude | LogEventVoyage;

/** Maximum length of the `error` field after redaction; longer is truncated. */
export const ERROR_MAX_LEN = 500;

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._\-~+/=]+/gi, "Bearer [REDACTED]"],
  [/Authorization:\s*\S+/gi, "Authorization: [REDACTED]"],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, "sk-[REDACTED]"],
  [/\bpa-[A-Za-z0-9_-]{8,}/g, "pa-[REDACTED]"],
];

function redactSecrets(input: string): string {
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
