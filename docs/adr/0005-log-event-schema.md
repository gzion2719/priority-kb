# ADR-0005 — Log event schema (structured JSON observability)

- **Date:** 2026-05-16
- **Status:** Accepted
- **Deciders:** Gal Zilberman + Claude (with independent plan-reviewer subagent)

## Context

The M1 ROADMAP observability checklist line reads:

> structured JSON log helper (every Claude/Voyage call → `tokens, latency, cost, prompt_hash, model, model_version`)

This is the wire format that the M5 production observability dashboard, the M3 eval runner, and any downstream log aggregator (Azure App Insights / CloudWatch / Loki / Vercel Logs) will all parse. Locking the shape now — before any call sites exist — keeps every M2a/M3 caller honest with the iron rules:

- **Non-negotiable #9** — `embedding_model + embedding_version` stored per row; re-embed when the model changes. The log mirror carries the same identifiers.
- **Non-negotiable #10** — `prompts/*.md` are hashed; the hash is stored alongside every agent response for attribution.

The unbiased plan reviewer rejected a flat optional-everywhere TypeScript interface on three grounds:

- `prompt_hash?: string` with a comment "required for Claude calls" is honor-system, not enforcement.
- `model_version?: string` makes a ROADMAP-required field optional.
- `cost_usd?: number` silently lets callers skip a ROADMAP-listed required field.

A choke-point logger that lets you forget the iron-rule fields is worse than no logger.

## Decision

A discriminated union on `kind` makes the iron-rule fields un-forgettable at every call site. The Claude variant requires `prompt_hash`; both variants require `model`, `model_version`, `latency_ms`, and `cost_usd` (`null` for "unknown" — a deliberate caller decision, not absence).

**Type skeleton (per the ADR-with-new-types sub-rule):**

```ts
type Tokens = { input?: number; output?: number; total?: number };
type LogStatus = "ok" | "error";

interface LogEventBase {
  model: string; model_version: string;       // non-negotiable #9
  tokens?: Tokens; latency_ms: number;
  cost_usd: number | null;                    // ROADMAP M1 — null = unknown
  request_id?: string; status?: LogStatus; error?: string;
}
export interface LogEventClaude extends LogEventBase {
  kind: "claude"; prompt_hash: string;        // non-negotiable #10
}
export interface LogEventVoyage extends LogEventBase { kind: "voyage"; }
export type LogEvent = LogEventClaude | LogEventVoyage;
export function logEvent(event: LogEvent): void;
```

**Wire format.** One NDJSON line per call, written to `process.stdout`. The auto-injected ISO 8601 `ts` field is the last property emitted; the input type omits `ts` so callers cannot collide via the input shape.

**Iron-rule enforcement at the type level.**

- **#10** — `prompt_hash` is required on `LogEventClaude`. A Claude call site that forgets it fails to compile.
- **#9** — `model + model_version` required on both variants.
- **ROADMAP M1 `cost`** — `cost_usd: number | null` forces the caller to decide. `null` documents "unknown"; omission is a type error.

**Runtime guard.** When `process.stdout` is unavailable (Next.js edge runtime on Vercel / Cloudflare Workers), the default sink returns silently. The file is documented as Node-runtime-only; any edge call site is a config bug, not a logging bug.

**Error field hygiene.** `error` is truncated to 500 characters before serialization. The JSDoc on the field reads: *caller MUST redact secrets before passing*. The full PII/secret-redaction pattern for the error path is parked in BACKLOG under M2b's PII scrub.

**Latency guard.** Non-finite `latency_ms` (NaN, ±Infinity) throws synchronously rather than silently serializing to `null` and corrupting downstream metrics.

**Sink injection.** A module-level `sink` variable (default: a closure over `process.stdout.write`) with exported `setLogSink(fn)` / `resetLogSink()`. Tests swap in a capture function; no `vi.spyOn(process.stdout)` brittleness; no `LOG_SILENT` env var needed. Parallels the `globalThis.__pgPool` pattern in `lib/db.ts`.

## Consequences

**Positive.**

- Iron-rule fields are mechanical, not honor-system. A Claude call site that forgets `prompt_hash` fails to compile, not at runtime.
- NDJSON to stdout is the universal log shape — every major aggregator consumes it natively, no logging-library dep.
- Test-friendly sink injection means M2a/M3 unit tests won't pollute vitest's stdout with log lines.
- The schema is documented in one place; the implementation cannot drift without an ADR amendment.

**Negative / accepted.**

- The discriminated union is more verbose than a flat interface. Accepted because the alternative (comment-as-enforcement) is exactly what mechanical floors exist to replace (cf. ADR-0004).
- `cost_usd: number | null` requires every call site to decide. Accepted — that decision IS the iron-rule check.
- Edge-runtime fallback is silent. Accepted because the file is Node-only by design; an edge call site surfaces as missing logs (visible on the M5 dashboard), not as a runtime exception.

## Alternatives considered

- **Flat optional-everywhere interface** (the plan's first cut). Rejected — optional iron-rule fields are honor-system.
- **Two separate exports** (`logClaude`, `logVoyage`). Rejected — duplicates code; adding a third event kind (rerank, eval) becomes copy-paste instead of a union extension.
- **Logging library** (pino, winston, bunyan). Rejected at M1 — the helper is <80 lines and stdout NDJSON does everything needed. Revisit at M5 if log volume, sampling, or log levels become real concerns.
- **`cost_usd` always required `number`** (no `null`). Rejected — some callers genuinely won't know cost (free cached responses, batched-billing endpoints). `number | null` documents "unknown" without making it default behavior.
- **`vi.spyOn(process.stdout, "write")` as the primary testing strategy.** Rejected — vitest's worker-pool reporter also writes to stdout; spy call counts get polluted. Sink injection is cleaner. (`vi.spyOn` is still used in one targeted test to verify that `resetLogSink()` restores the default behavior — that's bounded.)
- **Per-vendor `request_id` fields** (`claude_request_id`, `voyage_request_id`). Rejected — premature; one `request_id` field with a JSDoc note ("prefer SDK-provided id") is enough until evidence of correlation failures.
- **`kind ↔ model` consistency check** (refuse `kind:"claude"` + `model:"voyage-3-large"`). Rejected — model-name allowlists drift; JSDoc note "caller is responsible" is enough until evidence of the typo bug.
