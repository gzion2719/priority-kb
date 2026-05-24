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

**Wire format.** One NDJSON line per call, written to `process.stdout`. The auto-injected ISO 8601 `ts` field is the last property emitted. The input type declares `ts?: never` — a caller widening through a structural cast still gets a compile error, and the spread-then-override ordering means the helper's `ts` always wins even if `any` smuggles a field through.

**Iron-rule enforcement at the type level (with runtime backstops).**

- **#10** — `prompt_hash` is required on `LogEventClaude`. A Claude call site that forgets it fails to compile.
- **#9** — `model + model_version` required on both variants.
- **ROADMAP M1 `cost`** — `cost_usd: number | null` at compile time + a runtime `TypeError` if a caller smuggles `undefined` through `as any`. The type system alone isn't enough — `cost_usd: undefined as any` would `JSON.stringify` to a dropped field, defeating the iron rule silently. The runtime guard makes the bypass loud.
- **Latency** — `latency_ms` must be a finite non-negative number; `NaN`, `±Infinity`, and negatives all throw. Mirrors the cost guard.

**Runtime guard.** When `process.stdout` is unavailable (Next.js edge runtime on Vercel / Cloudflare Workers), the default sink returns silently. The file is documented as Node-runtime-only; any edge call site is a config bug, not a logging bug.

**Sink robustness — observability never breaks the API path.** Both `JSON.stringify` and the sink call are wrapped in try/catch. A serialization failure (circular reference smuggled into `error` via `as any`) degrades to a minimal `{"ts":..,"kind":..,"status":"error","error":"log serialization failed"}` line. A sink throw is swallowed entirely — the API call path completes normally. `logEvent` is synchronous-write-by-contract: exactly one sink call per invocation, no batching, no deferral.

**Error field hygiene — two-step pipeline.** The `error` field passes through:

1. **Best-effort secret redaction** — regex pass replaces `Bearer …`, `Authorization: …`, `sk-…`, and `pa-…` patterns with `[REDACTED]`. This is a thin safety net to close the log-channel exfil surface this helper introduces; the channel didn't exist before this commit.
2. **Truncation** — to `ERROR_MAX_LEN` (500) characters after redaction.

The redaction pass is *not* a full PII scrub — it covers the highest-blast-radius patterns (live API credentials) and nothing else. Callers MUST still redact known-sensitive PII before passing. Full PII pass is M2b's responsibility (see BACKLOG, Quality & Evals).

**Sink injection.** A module-level `sink` variable (default: a closure over `process.stdout.write`) with exported `setLogSink(fn)` / `resetLogSink()`. Tests swap in a capture function; no `vi.spyOn(process.stdout)` brittleness; no `LOG_SILENT` env var needed.

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

---

## Amendment 2026-05-23 — `kind:"retrieval_pipeline"` request-summary variant

Closes [docs/BACKLOG.md](../BACKLOG.md) "LogEvent discriminant for retrieval pipeline" + the open item in [ADR-0012](0012-retrieval-pipeline.md) §8.

**What ships.** `LogEvent` gains a third variant `LogEventRetrievalPipeline` (`kind:"retrieval_pipeline"`) emitted exactly once per `/api/retrieve` request on every terminal route path except the 401-from-`withUserOrAdmin` short-circuit (the auth wrapper returns before `handler` is invoked; emitting from there would require a separate outer-logger surface — out of scope for this slice).

**Shape (full declaration in [lib/log.ts](../../lib/log.ts)):**

```ts
export interface LogEventRetrievalPipeline {
  kind: "retrieval_pipeline";
  latency_ms: number;                 // total wall-clock from handler entry
  cost_usd: number | null;            // always null — aggregate costs sum from per-vendor lines
  role: string;                       // decoupled from auth.ts Role union
  degraded: boolean;
  degraded_reason?: DegradedReasonCode | "embedder_config" | "synth_config" | "synth_unavailable";
  citation_validation_outcome: CitationValidationOutcome | null;
  retry_attempted: boolean;
  keyword_only: boolean;
  status?: "ok" | "error";
  error?: string;                     // redact + truncate pipeline inherited
  query_hash?: string;                // sha256(redact(query.trim())).slice(0,16) — log-correlation only
  pipeline_request_id?: string;       // distinct from per-vendor request_id
  ts?: never;                         // helper-injected
}
```

**Departures from the original ADR shape.**

1. **Does NOT extend `LogEventBase`.** The aggregate event spans embed + rerank + synth model calls; naming a single "model" / "model_version" / "prompt_hash" would be a lie. Per-vendor identity lives on the `kind:"voyage"` / `kind:"claude"` lines and on the `audit_log` row's `embedding_model` / `synthesizer_model` columns. This is the second variant in the union that opts out of `LogEventBase` (the BACKLOG `kind:"route"` item for route-layer-error consolidation is the sibling, closed by Amendment 2026-05-27; the two BACKLOG items resolved independently). The original-ADR enforcement framing of #9/#10 at the type level is preserved for the variants where it applies; this variant explicitly does NOT carry vendor identity, so #9/#10 are not relevant.
2. **`cost_usd: number | null` is required and always `null`.** Field is present so the existing runtime cost-type guard permits this variant uniformly across the union — no special-case in `logEvent()`.
3. **`request_id` is intentionally not reused.** ADR-0005 reserved `request_id` for SDK-provided vendor call ids. A separate optional `pipeline_request_id` field is provided for route-level correlation to avoid collapsing two semantically-different correlation keys into one dashboard filter.
4. **`citation_validation_outcome` typed as `CitationValidationOutcome | null`.** Imported as `import type` from `@/lib/retrieval` — purely compile-time coupling, erased at runtime. M5 dashboards filtering on string literals get compile-time-checked values rather than bare `string`.
5. **`degraded_reason` typed as the explicit union of `DegradedReasonCode` + pre-stream sentinels** (`embedder_config` / `synth_config` / `synth_unavailable` — also exported as `PreStreamConfigReason`). The pre-stream-error path emits these sentinels onto the audit row's `degraded_reason` even though they aren't in `DEGRADED_REASON_CODES`; the log line accepts both shapes via the union so a future enum addition compiles loudly rather than passing through `string`.
6. **`keyword_only` is redundant with `degraded_reason`** (any `embed_*_keyword_*` or `no_keyword_match_under_embed_outage` reason implies `keyword_only:true`). Exposing both is cheap and lets log consumers filter on either without pattern-matching the reason string. Same field appears on `RetrievalAuditPayload` for the same reason.
7. **401 path emits no line — by design.** `withUserOrAdmin` returns before `handler` runs; emitting a `retrieval_pipeline` line for unauthenticated requests would require either an outer-logger wrapper or in-handler auth resolution. Both enlarge scope; the gap is documented here and in the helper's JSDoc.
8. **Orchestrator-uncaught-throw path uses a separate `emitOnOrchestratorThrow` helper** rather than reusing the main emitter with `outcome = preStreamErrorOutcome(...)`. The synthetic outcome hard-codes `retry_attempted:false` / `keyword_only:false` / `citation_validation_outcome:null`; reporting those on a throw that happened mid-retry would lie about in-flight state. The throw-path helper emits a minimal shape with `status:"error"` + `degraded:true` + the throw message.

**`query_hash` semantics.** SHA-256 of `redactSecrets(query.trim())`, first 16 hex chars (64 bits). Scope is log-correlation ONLY — collision-prone for cache-key reuse. The BACKLOG memoization item (line 70) uses a separate `(query_hash, role, sensitivity_allowed, prompt_hash)` cache key; do not reach for the log-line value.

**Test coverage.** [lib/log.test.ts](../../lib/log.test.ts) gains 7 cases for the new variant (NDJSON shape, optional-field omission, latency/cost guard inheritance, redaction inheritance, `ts` non-overridable). [app/api/retrieve/route.test.ts](../../app/api/retrieve/route.test.ts) gains a Layer 3 describe-block asserting exactly one `kind:"retrieval_pipeline"` line per terminal path with the correct field mapping — filtered by `kind` first so the assertions remain stable when per-vendor (`kind:"voyage"` / `kind:"claude"`) lines land in future M3 slices.

---

## Amendment 2026-05-27 — `kind:"route"` route-layer-error variant

Closes [docs/BACKLOG.md](../BACKLOG.md) "Extend `LogEvent` union with a `kind:"route"` variant" — the sibling pointer named open in Amendment-2026-05-23 §1.

**What ships.** `LogEvent` gains a fourth variant `LogEventRoute` (`kind:"route"`) emitted from the catch-all paths in [app/api/ingest/route.ts](../../app/api/ingest/route.ts) (POST), [app/api/ingest/[id]/route.ts](../../app/api/ingest/[id]/route.ts) (PUT), and the `dispatchTool` recovery catch in [app/api/agent/ingest/route.ts](../../app/api/agent/ingest/route.ts). These three sites previously emitted `kind:"voyage", model:"route", model_version:"ingest"|"ingest_update"|"agent-ingest"` — a misuse of the Voyage discriminant that polluted any observability filter grouping by `kind` (e.g. M5 dashboard's "Voyage error rate" panel would have double-counted ORM errors as Voyage errors).

**Shape (full declaration in [lib/log.ts](../../lib/log.ts)):**

```ts
export interface LogEventRoute {
  kind: "route";
  route: string;              // stable "METHOD path" label dashboards GROUP BY
  latency_ms: number;         // typically 0 on catch-all paths
  cost_usd: number | null;    // always null — no vendor invoked
  status?: "ok" | "error";
  error?: string;             // redact + truncate pipeline inherited
  ts?: never;                 // helper-injected
}
```

**Departures from the original ADR shape.**

1. **Does NOT extend `LogEventBase`.** No vendor model invoked, nothing to attribute. Same carve-out rationale as `kind:"retrieval_pipeline"` (Amendment 2026-05-23 §1) — iron rules #9 (`model+model_version`) and #10 (`prompt_hash`) are vacuously satisfied because the variant explicitly does NOT carry vendor identity. With this amendment the union has three opt-in-`LogEventBase` slots (`claude`, `voyage`) and two opt-out slots (`retrieval_pipeline`, `route`); the contract is "extend `LogEventBase` if and only if exactly one vendor call is being attributed."
2. **`cost_usd: number | null` is required and always `null`.** Field is present so the existing runtime cost-type guard permits the line uniformly across the union — no per-`kind` branch in `logEvent()`.
3. **No `request_id` / `pipeline_request_id`.** There is no SDK call whose id we could carry; sibling's `pipeline_request_id` is for events that span multiple vendor calls, which the route variant does not.
4. **Guard-inheritance test cases are re-asserted on the variant** (latency_ms / cost_usd / redact-truncate / sink-throw-swallow) for the same reason the sibling variant re-asserts them: the variant doesn't extend `LogEventBase`, so a future refactor of `logEvent()` that special-cases the base-shape variants could regress the guard surface on this variant without the dedicated tests catching it.
5. **`latency_ms: 0` is the common case.** Catch-all paths are recovery sites, not timed operations. Dashboards that average latency by `kind` should filter on `status:"error"` first; documented in the variant JSDoc.
6. **`route` label convention is bare `METHOD path`** — `"POST /api/ingest"`, `"PUT /api/ingest/[id]"`, `"POST /api/agent/ingest"`. The agent-ingest catch lives inside `dispatchTool` (not the outer HTTP handler), but the label is kept bare for `GROUP BY route` symmetry. If a future outer-handler 500 catch lands on the same path, a `phase?:string` field can be added then.

**Invariant: no runtime changes to `logEvent()`.** The new variant supplies `latency_ms: number` and `cost_usd: number | null` correctly; the existing two runtime guards fire uniformly across all four variants. Any future variant added to the union MUST also satisfy this invariant or `logEvent()` needs an explicit type-narrowing branch.

**No consumer migration window.** No M5 dashboard exists yet; the old `kind:"voyage", model:"route"` tuple has no downstream consumer pattern-matching on it. Clean swap.

**`tool_dispatch` site scope expansion.** The original BACKLOG entry named only the two ingest-route 500-paths; the agent-ingest `dispatchTool` recovery catch was added to the same slice because it shared the identical pollution pattern. The variant JSDoc reflects this: "route-layer-or-dispatch error not attributable to a single vendor call," broader than the original "500-path catch-all" framing.

**Test coverage.** [lib/log.test.ts](../../lib/log.test.ts) gains 7 cases for the new variant mirroring the Amendment 2026-05-23 sibling block: NDJSON shape pin (with raw-line assertions catching `undefined`-key spread regressions), optional-field omission, `latency_ms` guard inheritance, `cost_usd` guard inheritance, redact-then-truncate on `error`, `ts?:never` runtime non-overridable via structural-cast smuggle, sink-throw-swallow. The three call-site swaps have no pre-existing test assertions on the old tuple (greped: zero hits in `app/**/*.test.ts`), so no assertion churn outside `lib/log.test.ts`.
