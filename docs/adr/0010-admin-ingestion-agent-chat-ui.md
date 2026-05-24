# ADR-0010 — Admin Ingestion Agent chat UI: architecture

- **Date:** 2026-05-18
- **Status:** Accepted
- **Deciders:** Gal Zilberman + Claude (with independent plan-reviewer subagent)

## Context

ROADMAP M2a item 3 ([docs/ROADMAP.md:39](../ROADMAP.md)) is the admin chat UI that drives the Ingestion Agent. Spec lives at [docs/AGENTS.md](../AGENTS.md) lines 9–28: admin-only, conversational, one-question-at-a-time field collection, language-mirroring, PII coaching, duplicate-detection coaching, refuses to write to the DB without structural validation. System prompt is [prompts/ingestion-agent.md](../../prompts/ingestion-agent.md) v0.1.0; hash is sealed at process boot by [lib/prompts.ts](../../lib/prompts.ts) and pinned onto `audit_log` via the agent path in [lib/ingest.ts](../../lib/ingest.ts) (`source: { kind: "agent" }` → `kind: "agent_ingest"` / `"agent_ingest_update"` + non-null `prompt_hash`; storage-layer CHECK `audit_log_prompt_hash_required_for_agent` is the backstop).

What's already built and reusable:

- `withAdmin` HOF gating ([lib/auth.ts](../../lib/auth.ts), PR #70).
- `createEntry` / `updateEntry` orchestration with the `source: IngestSource` discriminator ([lib/ingest.ts:55](../../lib/ingest.ts), PRs #76 / #78 / #82).
- `INGESTION_AGENT_PROMPT_HASH` sealed at boot ([lib/prompts.ts:56](../../lib/prompts.ts), PR #82).
- Server-side `scrubPii` runs unconditionally in the ingest pipeline ([lib/ingest.ts:127](../../lib/ingest.ts), PR #76) — the agent's PII step is UX coaching, not enforcement.
- Direct-form fallback already wired: `POST /api/ingest` with `source: { kind: "direct" }` ([app/api/ingest/route.ts](../../app/api/ingest/route.ts), PR #76).

What this ADR does **not** decide:

- File attachments (M2b — image / PDF / Word ingestion path).
- Real `search_kb` implementation (M3 — retrieval pipeline).
- Conversation persistence (deferred to the agent-rejected-audit-row decision, [docs/BACKLOG.md](../BACKLOG.md) "Agent-rejected ingest audit rows (no `entry_id`)").
- Eval set for agent transcripts — captured as a new BACKLOG item in the Consequences section.

## Decision

### 1. Transport: Server-Sent Events over Next.js Route Handlers

```ts
// lib/agents.ts — public event surface (see §5 for AgentClient interface)
export type AgentEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_use_start"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; name: string; ok: true; output: unknown }
  | { kind: "tool_result"; name: string; ok: false; error: string }
  | { kind: "done"; stop_reason: "end_turn" | "tool_use" | "max_tokens" | "max_iterations" | "max_turns" }
  | { kind: "error"; code: string; message: string };
```

The chat UI calls a single POST endpoint that returns `Content-Type: text/event-stream`; the server holds the connection open for one assistant turn (which may itself loop through several tool calls) and streams events to the client. App-Router-native, one-way streaming sufficient, zero new transport deps.

Wire framing: each event is one SSE record (`data: <JSON-stringified AgentEvent>\n\n`). Heartbeat is an SSE comment line (`: keepalive\n\n`) emitted every 10s of stream silence — see §3 for why.

There is **no text streaming during tool execution.** Claude's SDK serializes turns: text deltas → `tool_use` block → stream pauses while the caller runs the tool → `tool_result` is submitted back → next assistant turn streams. The keepalive comment fills the gap so proxies don't kill the connection.

The adapter buffers `input_json_delta` events server-side; **`tool_use_start` fires only after `content_block_stop` confirms the tool_use block is complete** — `input` is therefore the finalized JSON object, never partial. The `id` field is the Anthropic-wire `tool_use.id` (e.g. `toolu_01XYZ...`) and **must round-trip verbatim** to the next-turn `AgentContentBlock.tool_result.tool_use_id`; the loop driver in §3 echoes it without modification. The `stop_reason` union narrows the Anthropic SDK's native values (`end_turn | tool_use | max_tokens | stop_sequence`) and adds two route-synthesized values (`max_iterations`, `max_turns`) for the caps in §3; the adapter swallows `stop_sequence` (we set no stop sequences) and emits `end_turn` on its behalf.

**Amendment 2026-05-18 (impl step 3a):** the originally-shipped §1 sample omitted the `id` field on `tool_use_start`. Step 3a added it as an additive (non-breaking) field bump. Without it the loop driver cannot correlate `tool_use_start` with the `tool_result` block it must echo in the next-turn `messages[]`, and the real Anthropic SDK in step 3b would reject the turn for missing `tool_use_id`. The stub-agent fixture scripts in `lib/agents.test.ts` were updated to provide a deterministic `id` (e.g. `"toolu_test_<n>"`).

Response headers pinned at impl time: `Cache-Control: no-cache, no-transform`, `Content-Type: text/event-stream`, `X-Accel-Buffering: no`. The `no-transform` directive prevents Brotli / gzip framing breaks at the CDN edge; `X-Accel-Buffering: no` covers nginx-class proxies.

### 2. Agent route mandates `source: { kind: "agent" } as const`

```ts
// lib/ingest.ts — new wrappers alongside existing createEntry / updateEntry
export async function submitEntryFromAgent(
  args: Omit<Parameters<typeof createEntry>[0], "source">,
): Promise<IngestResult> {
  return createEntry({ ...args, source: { kind: "agent" } as const });
}

export async function updateEntryFromAgent(
  id: string,
  args: Omit<Parameters<typeof updateEntry>[0], "source" | "id">,
): Promise<IngestResult> {
  return updateEntry({ id, ...args, source: { kind: "agent" } as const });
}
```

Hard mechanical floor. The agent route's `submit_entry` tool handler MUST call one of the wrappers above. Type system requires the discriminator but accepts `{kind:"direct"}` silently — a future maintainer copying the route shape from [app/api/ingest/route.ts:56](../../app/api/ingest/route.ts) (which uses `source: { kind: "direct" }`) would otherwise ship the agent path through the direct audit shape and silently drop `prompt_hash`, defeating iron rule #10. Code review on PRs that touch `app/api/agent/**` checks for `createEntry(` direct calls in the agent route — should be zero. The direct path keeps using `createEntry` directly.

### 3. Tool-use loop on the server with explicit caps

One HTTP request runs the full tool-use loop. The server is the loop driver — calls `messages.stream()`, materializes `tool_use` blocks, executes them locally (DB / search / etc.), submits `tool_result` back to the SDK, loops until `stop_reason !== "tool_use"`.

Caps (M2a defaults; revisit at M5 hosting cut):

- **Max tool iterations per request: 8.** A normal flow (list_categories → text → search_kb → text → submit_entry) is 3 tool calls inside a 5-step conversational turn. A pathological loop hits 8 and the server emits `{ kind: "done", stop_reason: "max_iterations" }`. The 8-cap protects against runaway tool loops and bounds worst-case wall-clock.
- **Per-request wall-clock budget: 60s.** Above this the server aborts the SDK call, emits `{ kind: "error", code: "deadline_exceeded", message: "..." }`, and closes the connection. 60s is Vercel Pro's *default* `maxDuration` for Node functions (configurable to 300s on Pro plans) and a practical upper bound for a single multi-tool conversational turn; M5 hosting may tune.
- **Max conversation turns: 20.** Client-side cap; the route rejects requests whose `messages.length > 40` (admin + assistant pairs, each tool round counts as 1 assistant message). **Rejection happens before the SSE stream opens**, as HTTP 400 `{ error: "max_turns_exceeded" }` — cheaper to fail fast than to open a stream just to close it. The 20-turn cap is the cost-control mechanism for §4's "client sends full history each turn" choice.
- **SSE keepalive: comment line every 10s** of stream silence. Below the 30–60s idle timeout most edge proxies enforce, well above the per-event tool-execution latency.

The two `done.stop_reason` values that the route synthesizes (`max_iterations`, `max_turns`) are distinct: `max_iterations` fires inside a single turn when the tool-use loop won't terminate; `max_turns` fires when the next request would push history past 40 messages (and is in practice a 400 before SSE rather than a `done` event — kept in the union for symmetry).

These four numbers are tunable via env vars (`AGENT_MAX_TOOL_ITERATIONS`, `AGENT_REQUEST_DEADLINE_MS`, `AGENT_MAX_TURNS`, `AGENT_KEEPALIVE_MS`) with the defaults above; the factory validates them at boot and fails closed (`RangeError`) on invalid values.

### 4. Conversation state ephemeral per request

The client sends the full message history (admin turns + assistant turns + tool round-trips) each HTTP request. No `agent_sessions` Postgres table in M2a. Iron rule #10 is satisfied by `INGESTION_AGENT_PROMPT_HASH` being sealed at process boot — the hash is independent of conversation state and lands in `audit_log` when `submit_entry` fires.

Consequences of ephemeral state:

- **Browser refresh mid-conversation:** admin starts the entry over. Conversation history is React-state-only in M2a (no localStorage). Persistence is deferred until either (a) the agent-rejected-audit-row decision lands and rejection metadata wants the transcript, or (b) admins ask for resume-after-refresh as UX feedback. Neither is M2a.
- **Mid-conversation prompt-hash rotation:** if a deploy happens mid-chat, the next `submit_entry` writes the new boot's hash — not the hash the conversation started under. Acceptable: a deploy that changes the agent prompt is also a deploy-time decision that the behavioral change is now in effect.
- **Abort/cancel:** the route reads `req.signal` (Next.js App Router exposes this on `NextRequest`) and passes it into `streamMessages({signal})` from §5. Browser tab close → underlying TCP close → `req.signal` aborts → SDK call propagates abort. Three outcomes are all safe: the `db.transaction(...)` at [lib/ingest.ts:218](../../lib/ingest.ts) (createEntry) / [lib/ingest.ts:350](../../lib/ingest.ts) (updateEntry) commits (already issued); rolls back (abort mid-transaction); or never starts the write (abort during pre-tx `scrubPii` / chunk / embed). No partial entries.

### 5. `lib/agents.ts` abstraction (parallel to `lib/embedding.ts`)

```ts
// lib/agents.ts — full public surface
export interface AgentClient {
  readonly model: string;          // "claude-haiku-4-5-20251001"
  readonly model_version: string;  // SDK version string for audit / logEvent
  streamMessages(input: AgentStreamInput): AsyncIterable<AgentEvent>;
}

export type AgentStreamInput = {
  system_prompt: string;            // file contents of prompts/ingestion-agent.md
  messages: AgentMessage[];         // admin + assistant + tool round-trips
  tools: AgentToolDefinition[];     // from §6 registry
  max_tool_iterations: number;      // §3 cap
  deadline_ms: number;              // §3 wall-clock budget
  signal: AbortSignal;              // §4 abort propagation
};

export class AgentUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "AgentUnavailableError";
    if (options?.cause) (this as { cause?: unknown }).cause = options.cause;
  }
}

// Test-fixture surface — mirrors lib/embedding.ts's createStubEmbedder.
// Yields a pre-canned AgentEvent[] script; tests assert on the script.
export function createStubAgent(script: ReadonlyArray<AgentEvent>): AgentClient;

// Factory wired via AGENT_PROVIDER env. "stub" in tests; "anthropic" in prod.
export function getAgent(): AgentClient;
export function resetAgentForTests(): void;
```

The non-negotiable-#8 mechanical floor mirrors `lib/embedding.test.ts:161-175`: a source-file-no-import test asserts that `lib/agents.ts` never imports `@anthropic-ai/sdk` directly at module top level — the real client is dynamically imported inside the production adapter, the stub adapter and tests never trigger the import.

Anthropic SDK pin: **exact version, no caret prefix.** The existing pattern in `package.json` is that runtime-load-bearing deps tend to be pinned (`next: 16.2.6`, `react: 19.2.4`, `drizzle-orm: 0.36.4`, `js-tiktoken: 1.0.20`, `drizzle-kit: 0.28.1`) while leaf utilities use caret (`pg: ^8.20.0`, `zod: ^3.23.0`). `@anthropic-ai/sdk` sits on the load-bearing side and gets the pinned treatment. Add to `package.json` at impl-PR step 1: pin to the latest stable on the impl-PR-1 commit date; the chosen version goes into the commit message and a `package.json` comment is unnecessary because `npm ls @anthropic-ai/sdk` always answers. Bump deliberately, never via dependabot auto-merge.

### 6. Tool registry (typed in TS, not JSON)

Three tools for M2a:

```ts
// lib/agents-tools.ts — the registry the agent gets at every call
export type AgentToolDefinition =
  | { name: "submit_entry"; description: string; input_schema: JSONSchema }
  | { name: "list_categories"; description: string; input_schema: JSONSchema }
  | { name: "search_kb"; description: string; input_schema: JSONSchema };
```

- **`submit_entry`** — input wire shape matches the `IngestBody` Zod schema ([lib/ingest-schema.ts](../../lib/ingest-schema.ts)) including `last_verified_at: string` (ISO 8601). The tool-use loop driver runs `IngestBody.safeParse(tool_use_start.input)` and branches: on success, calls `submitEntryFromAgent` with `result.data` (Date-transformed `last_verified_at` and all); on failure, emits a `tool_result` with `ok: false` and `error: JSON.stringify(issuesFromZodError(result.error))` so the agent re-prompts the admin. The route does **not** convert a parse failure into an SSE `error` event — schema mismatch is a recoverable signal that the agent should act on, not a connection-fatal error. Output on success is `IngestResult`.
- **`list_categories`** — input is empty; output is `{ categories: string[] }`. Server-side handler runs `SELECT DISTINCT category FROM entries ORDER BY category`. M2a is admin-only so sensitivity-filtered categories are moot; when the agent surface widens (M4+) the SELECT needs a sensitivity filter clause. No new index — `entries.category` is text and the distinct scan is cheap until corpus exceeds ~50k entries (M4+ concern).
- **`search_kb`** — M3-deferred. M2a stub returns `{ candidates: [], note: "retrieval_unavailable_m2a" }`. The prompt (v0.2.0, see Consequences) treats the `note` field as a skip signal for duplicate detection. Real impl ships with M3.

**Idempotency on `submit_entry`.** A tool-use loop where the SSE connection drops between the `tool_use` event and the next `tool_result` submit can lose the user's confirmation. M2a position: single-shot, no auto-retry — the route's tool-execution path does not retry the `createEntry` call on transient failure, and the admin sees no confirmation on a dropped connection. On reconnect / restart the agent does not know an entry was created; if the admin re-runs the chat they may produce a duplicate. Captured in the BACKLOG idempotency-key bullet ("`submit_entry` idempotency key (post-M2a)" in Consequences). Acceptable for M2a; revisit if duplicates show up in audit logs.

Tool input schemas are JSON Schema Draft 7 (Anthropic SDK's accepted format). Schemas live in TS as `const` objects with `as const` assertions so the registry is fully typed.

### 7. Degraded mode (non-negotiable #12)

If `getAgent()` throws `AgentUnavailableError` (Anthropic 5xx, rate-limit, network down), the route returns `503` with `{ error: "agent_unavailable" }`. The chat UI renders a banner: "Agent is down — use direct form" with a link to a minimal HTML form posting to `POST /api/ingest` (the direct path already wired in PR #76).

The degraded fallback **does not** call the agent's PII-coaching flow — admin enters fields directly; `scrubPii` runs server-side regardless. This is exactly the non-negotiable #12 posture: keyword search vs no search for retrieval, direct form vs no ingest for ingestion.

### 8. Iron-rule footprint

| Rule | Mechanism |
|---|---|
| **#1** credentials never committed | `ANTHROPIC_API_KEY` env var, read in `lib/agents.ts` factory (mirrors `EMBEDDING_PROVIDER` in [lib/embedding.ts](../../lib/embedding.ts)). Missing key in prod throws `RangeError` at first call (not `AgentUnavailableError` — the latter would mask misconfig as transient outage). `.env*` already gitignored. |
| **#2** all KB writes through Ingestion Agent | Agent route's `submit_entry` tool handler goes through `submitEntryFromAgent` → `createEntry` (§2). [lib/ingest.ts:7](../../lib/ingest.ts) names itself as the only DB-write entry point; the agent path inherits that property by construction — no sibling write path is permitted. |
| **#4** admin-only writes | `withAdmin` HOF on the SSE route ([lib/auth.ts](../../lib/auth.ts)). Same pattern as `POST /api/ingest`. |
| **#6** sensitivity tagged | Comes through the `submit_entry` tool's `IngestBody` Zod boundary ([lib/ingest-schema.ts:49](../../lib/ingest-schema.ts)). Agent collects; route enforces. The system prompt prompts for it; admin cannot omit. |
| **#7** source + last_verified_at | Same `IngestBody` Zod boundary. The system prompt makes both fields mandatory before tool invocation; the schema is the floor. |
| **#8** no live API calls in tests | `lib/agents.ts` source-file-no-import test + factory's `AGENT_PROVIDER=stub` default in test env + `createStubAgent` fixture. Mirrors `lib/embedding.test.ts:161-175`. |
| **#9** embedding model + version per row | The agent path inherits #9 because `submitEntryFromAgent` → `createEntry` → `deriveChunksAndEmbeddings` records `embedding_model + embedding_version` ([lib/ingest.ts:114](../../lib/ingest.ts)). No new code path. |
| **#10** prompt hash on every agent response | `INGESTION_AGENT_PROMPT_HASH` sealed at boot; `submitEntryFromAgent` mechanically pins `source: { kind: "agent" } as const` (§2); DB CHECK `audit_log_prompt_hash_required_for_agent` is storage backstop. |
| **#11** ≥2 admin accounts | N/A at the ADR layer — auth-config concern, not architecture. Tracked in ROADMAP M5 (Entra ID app registration). |
| **#12** degraded mode | §7 — `AgentUnavailableError` → 503 → direct-form fallback. |
| **#13** Kramer brand standards | `app/admin/ingest/page.tsx` (impl-PR step 4) consumes `styles/kramer-brand.css` tokens directly: chat-bubble bg / fg / borders, send-button + cancel-button states, system-message accent. GT Eesti family from the brand stylesheet. The brand surface for the chat UI is in scope of impl-PR step 4, not deferred. |

## Out of scope

- **File attachments.** M2b's media-ingestion path adds image / PDF / Word tools to the registry; this ADR is text-only.
- **Real `search_kb`.** M3's retrieval pipeline ships the implementation; M2a uses the stub returning `retrieval_unavailable_m2a`.
- **Conversation persistence.** Deferred to whatever resolves [docs/BACKLOG.md](../BACKLOG.md) "Agent-rejected ingest audit rows (no `entry_id`)".
- **Multi-entry batch ingestion.** The agent's `Final confirmation` step ([prompts/ingestion-agent.md:50–67](../../prompts/ingestion-agent.md)) ends the conversation after one entry. Batch ingestion is M4+ if requested.
- **Cost dashboard for agent spend.** Goes through `LogEvent` (see Consequences); the dashboard itself is M5.

## Consequences

### Implementation order

The smallest E2E increment is the abstraction, not the route. Mirror the M1 pattern (`lib/embedding.ts` landed before `app/api/ingest/route.ts`):

1. `lib/agents.ts` interface + `AgentEvent` types + `createStubAgent` + `getAgent` factory + tests (including the source-file-no-import mechanical floor). One PR.
2. `lib/agents-tools.ts` registry + `submitEntryFromAgent` / `updateEntryFromAgent` wrappers in `lib/ingest.ts` + tests. One PR.
3. `app/api/agent/ingest/route.ts` SSE route handler with `withAdmin` + tool-use loop driver + tests. One PR.
4. `app/admin/ingest/page.tsx` client chat UI + `prompts/ingestion-agent.md` bump to v0.2.0 (PII coaching rewording + `search_kb` empty-result fallback) + integration tests with stub agent. One PR.

Each PR is a self-contained slice; CI green before the next starts.

### `LogEvent` extension (not a new variant)

[ADR-0005](0005-log-event-schema.md)'s `LogEventClaude` already requires `prompt_hash: string` and has optional `tokens` — the shape fits streaming + tool-use without modification, **as long as we log once per agent turn aggregating `tokens.total`**, not once per `text_delta`. The impl-PR step 1 extends `LogEventClaude` with two optional fields: `tool_iterations?: number` (how many tool round-trips inside this turn) and `streaming?: boolean` (`true` for the SSE-driven agent path; absent for one-shot Retrieval-Agent calls in M3). No new `kind` discriminator — keeps the union narrow and `prompt_hash` requirement intact for every Anthropic call site, agent or not.

### Prompt v0.2.0 (rides with impl PR step 4)

[prompts/ingestion-agent.md](../../prompts/ingestion-agent.md) gets two edits when the chat UI lands:

1. **PII coaching language.** Current line 33 says: *"If admin says no, proceed unchanged but log the decision in the audit metadata."* Reality: `scrubPii` is unconditional in `createEntry` and there is no audit-metadata channel for the admin's preference. Rewrite to: *"I'll strip these before storage — flagging so you know what's being removed. (Stripping happens server-side regardless of your answer; this is a heads-up, not a vote.)"*
2. **`search_kb` empty-result fallback.** Current line 37 mandates the call unconditionally. Add: *"If `search_kb` returns `{candidates: [], note: 'retrieval_unavailable_m2a'}`, retrieval is not yet enabled — proceed without duplicate detection and inform the admin in one line."*

The prompt hash will change on this bump; from that deploy forward `audit_log.prompt_hash` carries the v0.2.0 hash. Prior `agent_ingest` rows keep the v0.1.0 hash — that's the provenance design working as intended.

**Note on §"Why not just a structured form?" below.** The v0.1.0 PII-coaching dialogue was one of three form-vs-chat arguments at the original ADR-0010 write-up. v0.2.0's shift to a one-shot PII alert ("heads-up, not a vote") neutralizes that argument — both shapes would now show a one-shot strip notice. Language-mirroring and duplicate-detection remain valid form-vs-chat differentiators; see §"Why not just a structured form?" below.

### Anthropic SDK adoption

`@anthropic-ai/sdk` is a non-trivial new dependency. At impl-PR step 1, run `npm ls` against the lockfile produced and check for transitive conflicts with `next@16` / `react@19`. Pin exactly; bump deliberately.

### New BACKLOG items

- **Agent-transcript eval fixture format.** Define `evals/agent_fixtures/*.json` shape: `{system_prompt_hash, messages[], expected_events[]}`. Stub `AgentClient` replays from a fixture file; integration tests assert on the streamed events. Lands when the agent's behavior space stabilizes (after impl step 4); pre-mature in step 1.
- **CSRF posture for the SSE route (M5).** Stub auth makes CSRF essentially N/A in M2a. Entra ID (M5) introduces real session cookies; the agent route needs CSRF protection or `SameSite=Strict` + Origin-header check at that point. One-line forward reference.
- **`submit_entry` idempotency key (post-M2a).** A tool-use loop that retries (network blip between `tool_result` submit and next streaming chunk) could double-submit. M2a position: **single-shot, no auto-retry on `submit_entry`** — the route's tool-execution path does not retry the `createEntry` call on transient failure; the admin re-runs the chat. Revisit if double-submits show up in audit logs.
- **Model id review at M5 hosting cut.** `claude-haiku-4-5-20251001` is the M2a pin per AGENTS.md; review against the then-current Haiku at M5 deploy.

### What unlocks downstream

- **M2b file-attachments.** Adds image / PDF / Word tools to `AgentToolDefinition` + extends `IngestBody` with attachments. Transport, loop driver, prompt-hash plumbing all reuse from this ADR.
- **M3 retrieval.** Replaces the `search_kb` stub with the real `kind: "retrieval_search"` LogEvent-emitting impl. Same tool name and schema; only the handler changes.
- **M5 hosting.** SSE caps (§3) become hosting-config decisions; the env-var defaults move into the deploy config.

## Why not just a structured form?

The reviewer's q1 challenge. The form-vs-chat scope question is real — a structured HTML form ("Title:", "Category:", "Body:", "Source:", "Sensitivity:") with a single Claude call to validate + suggest fixes on submit is ~10× less surface than this ADR.

But the spec [docs/AGENTS.md:11–17](../AGENTS.md) prescribes a conversational flow specifically: "Guides the admin through producing a well-structured KB entry **via a chat conversation**", "one question at a time when collecting fields" ([prompts/ingestion-agent.md:48](../../prompts/ingestion-agent.md)), "mirrors the admin's input language" ([prompts/ingestion-agent.md:14](../../prompts/ingestion-agent.md)), "Hebrew + English". A form would regress the spec — language mirroring becomes per-field rather than per-conversation, and duplicate detection becomes a modal popup (the PII-coaching argument is now neutral — see §"Prompt v0.2.0" above).

The ADR keeps the conversational shape and bounds the surface via the caps in §3 instead. If the caps turn out wrong in practice (60s deadline too tight, 8 iterations too few, 20 turns too few), the env vars are tunable — but the conversational shape is the AGENTS.md commitment.

## Open questions answered

| q | Answer |
|---|---|
| streaming chat vs form | §"Why not just a structured form?" above. AGENTS.md spec mandates conversational. |
| prompt bump timing | Bundle with impl PR step 4 (one verifiable slice: prompt + code + tests). |
| abort/cancel | §4 — route reads `req.signal`; `createEntry` transaction atomicity prevents partial entries. |
| token / cost attribution | §"`LogEvent` extension (not a new variant)" in Consequences. Extend `LogEventClaude` with optional `tool_iterations` + `streaming` fields. |
| mid-conversation hash rotation | §4 — boot-time hash at submit time is authoritative; deploy implicitly says behavior change is in effect. |
| string → Date conversion path | §6 `submit_entry` bullet — tool-use loop driver runs `IngestBody.safeParse` and passes `result.data` (Date-transformed) to the wrapper. |
| messages.length > 40 rejection | §3 — HTTP 400 *before* SSE opens, not a `done` event. Fail fast. |
| list_categories sensitivity filtering | §6 — N/A in M2a (admin-only); add WHERE clause when agent surface widens (M4+). |
| `submit_entry` idempotency on dropped connection | §6 — single-shot, no auto-retry. Admin sees no confirmation; duplicate possible on retry. BACKLOG idempotency-key bullet. |
| SSE headers at impl time | §1 — `Cache-Control: no-cache, no-transform`, `Content-Type: text/event-stream`, `X-Accel-Buffering: no`. |
