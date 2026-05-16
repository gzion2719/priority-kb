/**
 * Structured JSON log helper for Claude / Voyage API calls.
 *
 * Emits one NDJSON line per call event to the module-level sink (default:
 * `process.stdout`). The wire format is locked in ADR-0005; every M2a/M3
 * call site MUST use this helper.
 *
 * Iron-rule enforcement (compile-time):
 *   - Non-negotiable #10: `prompt_hash` is required for `kind: "claude"`.
 *   - Non-negotiable #9:  `model` + `model_version` required for every event.
 *   - ROADMAP M1:         `cost_usd` is `number | null` — `null` documents
 *                         "unknown" as a deliberate caller decision; omission
 *                         is a compile error.
 *
 * Runtime: Node only. Next.js route handlers that import this MUST NOT run
 * on the edge runtime (`process.stdout` is unavailable there). When
 * `process.stdout` is missing, the default sink returns silently.
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
  latency_ms: number;
  /**
   * Cost in USD. `null` documents "unknown" as a deliberate caller decision.
   * ROADMAP M1 lists `cost` in the required-fields list.
   */
  cost_usd: number | null;
  /** Free-form request id; prefer the SDK-provided id when available. */
  request_id?: string;
  status?: LogStatus;
  /**
   * Error string. Truncated to 500 characters before serialization.
   * Caller MUST redact secrets (Authorization headers, customer PII) before
   * passing. Full redaction pass is M2b's PII scrub.
   */
  error?: string;
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

const ERROR_MAX_LEN = 500;

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
 * @throws TypeError if `latency_ms` is not finite (NaN, +Infinity, -Infinity).
 */
export function logEvent(event: LogEvent): void {
  if (!Number.isFinite(event.latency_ms)) {
    throw new TypeError(
      `logEvent: latency_ms must be a finite number, got ${String(event.latency_ms)}`,
    );
  }

  // Spread event first, `ts` last → helper-injected timestamp always wins
  // even if a caller cast through `any` to sneak a `ts` field in.
  const payload: Record<string, unknown> = {
    ...event,
    ts: new Date().toISOString(),
  };

  if (typeof event.error === "string" && event.error.length > ERROR_MAX_LEN) {
    payload.error = event.error.slice(0, ERROR_MAX_LEN);
  }

  sink(JSON.stringify(payload) + "\n");
}
