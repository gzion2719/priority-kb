# ADR-0012 — Retrieval pipeline architecture (M3 item 3)

**Status:** Accepted
**Date:** 2026-05-20
**Scope:** ROADMAP M3 item 3 — `query embedding → pgvector HNSW top-K → Voyage rerank-2 → top-N to Claude → answer with citation IDs`. ROADMAP M3 item 4 (hybrid `tsvector` keyword lane + score fusion) is **out of scope** and reserved for ADR-0013.

---

## Context

M3 (retrieval E2E) is the milestone where a `user`-role caller asks a question and gets a cited answer. The schema, embedder abstraction, and retrieval-agent prompt are all in place:

- `chunks.embedding vector(1024)` + HNSW `vector_cosine_ops` index ([drizzle/schema.ts:87-112](../../drizzle/schema.ts#L87-L112)).
- `chunks.embedding_model` + `chunks.embedding_version` columns mandated by iron rule #9 (per-row embedder provenance).
- `chunks.sensitivity` enforced by composite-FK from `entries` ([drizzle/schema.ts:97-105](../../drizzle/schema.ts#L97-L105)), so server-side sensitivity filtering reduces to a `WHERE chunks.sensitivity IN (...)` predicate without join risk.
- `audit_log` CHECK `audit_log_prompt_hash_required_for_agent` mandates `prompt_hash IS NOT NULL` when `kind LIKE 'agent_%'` ([drizzle/schema.ts:129-132](../../drizzle/schema.ts#L129-L132)).
- `RETRIEVAL_AGENT_PROMPT_HASH` is exported from [lib/prompts.ts](../../lib/prompts.ts) with boot-time roundtrip assertion (shipped 2026-05-20, M3 item 1).
- `Embedder` interface + `EmbeddingUnavailableError` already pattern the degraded-mode fallback contract from M1 ([lib/embedding.ts](../../lib/embedding.ts)).

The iron rules this ADR is bound by:

| # | Rule | How this ADR satisfies it |
|---|---|---|
| #3 | Every retrieval answer cites the entries it used. No source = no claim. | Mandatory trailing `Sources: [uuid, ...]` block; server-side mechanical validation (§5). |
| #6 | Sensitivity respected by role server-side, not UI-hidden. | Authorization predicate compiled into stage B's SQL `WHERE` (§2 + §6). |
| #8 | Tests never call live embedding/Claude/Voyage APIs. | `Reranker` + `Synthesizer` interfaces with stub providers, mirroring `Embedder` (§2 skeleton). |
| #9 | Embedding model+version stored per row; re-embed when model changes. | Stage B's WHERE filters by query-embedder's `(model, version)` to forbid cross-version ANN nonsense (§2 stage B). |
| #10 | Prompts in git, hashed; hash stored with every agent response. | Stage E audit row pins `prompt_hash = RETRIEVAL_AGENT_PROMPT_HASH` (§2 stage E). |
| #12 | Degraded mode (keyword-only, no synthesis) when Claude/Voyage down. | Out-of-scope here because the keyword lane is ADR-0013 territory. This ADR's degraded contract covers the embedder + rerank + synth failure surface (§3); the full degraded-mode acceptance shifts to ADR-0013 + the implementation of items 3+4 together. |

A note on iron rule #12: M3 item 8 ("degraded mode: keyword-only fallback when Claude or Voyage 5xx") presupposes the keyword lane (item 4) exists. Until ADR-0013 lands item 4, this pipeline's degraded modes are: (a) embed-down → 503 with retry guidance, (b) rerank-down → ANN-only top-N to synth (degraded flag set), (c) synth-down → citations + chunk snippets without synthesis (degraded flag set). Full keyword-only fallback unlocks once item 4 ships.

---

## Decision

### Pipeline stages

**Stage A — Embed query.** Call `getEmbedder().embed(query, { input_type: "query" })`. Voyage's `input_type` discriminator pairs query embeddings with `voyage-3-large`'s asymmetric query-document mode; mis-tagging halves recall. The `Embedder` interface gains an optional second arg `{ input_type?: "query" | "document" }` defaulting to `"document"` for backward compatibility with M2a ingest call sites.

**Stage B — ANN search.** Top-K=20 candidates via pgvector HNSW. SQL:

```sql
SELECT chunks.id, chunks.entry_id, chunks.sensitivity, chunks.content_start, chunks.content_end,
       (chunks.embedding <=> $1) AS cosine_distance
FROM chunks
WHERE chunks.sensitivity = ANY($2::text[])
  AND chunks.embedding_model = $3
  AND chunks.embedding_version = $4
ORDER BY chunks.embedding <=> $1
LIMIT 20;
```

- `$1` = query vector (1024-dim, matches index).
- `$2` = `sensitivity_allowed[]` — the **authorization predicate**, computed server-side from session role (§6). Compiled into the SQL `WHERE`, never a post-hoc filter.
- `$3`/`$4` = query embedder's `model` + `version`. Iron rule #9 mandates the columns exist; this stage uses them. Cross-version ANN scores are meaningless and would silently rank stale chunks above current ones; the SQL filter forbids the regime. If the corpus is mid-re-embedding and zero rows match, the pipeline degrades per §3 with `reason_code:"embedding_version_mismatch"`.

HNSW index op-class is `vector_cosine_ops` ([drizzle/schema.ts:111](../../drizzle/schema.ts#L111)). Voyage L2-normalizes outputs, so cosine ≡ dot-product for the production path; but the stub embedder is intentionally **not** L2-normalized ([lib/embedding.ts:23-27](../../lib/embedding.ts#L23-L27)) so iron-rule-#8 stub-mode tests stay valid only under cosine, not inner-product. Keeping cosine is load-bearing for the test stack.

**Stage C — Rerank.** Voyage `rerank-2`: pass the 20 candidate chunk bodies + the original query; receive ranked indices + relevance scores. Take top-N=5.

Voyage rerank-2 bills on input tokens of the candidate documents (not per-call), so:
- The §B authorization predicate is a real cost win (drops chunks the requester can't see before rerank pays for them).
- A minimum-cosine floor is exposed as env knob `RETRIEVAL_RERANK_MIN_COSINE` (default `0.3`). Candidates with cosine distance > `1 - floor` (i.e., similarity below floor) are dropped before rerank. Set to `0` to disable.

**Stage D — Synthesis.** Compose the prompt: retrieval-agent system prompt (already hashed) + tool-style block listing the 5 reranked chunks with `{entry_id, title, body, category, tags, source_pointer, last_verified_at, sensitivity, score}`. Send to Claude Sonnet. **Required output shape:** answer text followed by a trailing block:

```
Sources: [uuid1, uuid2, ...]
```

The `Sources:` block is mechanically validated (§5). The retrieval-agent prompt v0.2.0 update accompanying the implementation PR will pin this output contract; until then, the prompt's existing per-claim `[uuid]` markers are advisory.

Context-budget math: 5 chunks × ~500 tokens/chunk + query (~50) + system prompt (~600) + tool framing (~200) ≈ **3.5K input tokens** per request. Bumping N to 10 doubles the chunk portion to ~5K and pushes into a different latency regime; treat 5 as the v1 cap.

**Stage E — Audit.** One row per request:

```
audit_log:
  kind = "agent_retrieval"
  entry_id = NULL                            -- retrieval does not write entries
  prompt_hash = RETRIEVAL_AGENT_PROMPT_HASH  -- pinned by lib/prompts.ts
  payload = {
    query: string,
    role: "admin" | "user",
    sensitivity_allowed: ("public" | "internal" | "restricted")[],
    embedding_model: string,
    embedding_version: string,
    candidate_ids: uuid[]    -- the 20 from stage B
    reranked_ids: uuid[]     -- the 5 from stage C
    citation_ids: uuid[]     -- the IDs Claude cited in §D Sources block (subset of reranked_ids)
    latencies_ms: { embed, ann, rerank, synth, total }
    tokens: { embed, rerank_input, synth_input, synth_output }
    degraded: boolean
    degraded_reason?: string
  }
```

`citation_ids[]` lives in `payload` (no FK protection — analytics queries should JOIN against `entries` carefully and tolerate dangling IDs if entries are deleted later).

### Type skeletons (per ADR-with-new-types sub-rule)

```typescript
// lib/retrieval.ts (skeleton; implementation lands in M3 item 3 PR)

export interface Reranker {
  readonly model: string;
  readonly version: string;
  rerank(query: string, docs: string[]): Promise<{
    ranking: { index: number; score: number }[];
    tokens_used: number;
  }>;
}

export interface Synthesizer {
  readonly model: string;
  readonly version: string;
  synthesize(prompt: string, context: string[]): Promise<{
    answer: string;
    tokens_in: number;
    tokens_out: number;
  }>;
}

export class RerankUnavailableError extends Error { constructor(m: string, opts?: { cause?: unknown }) { super(m, opts); this.name = "RerankUnavailableError"; } }
export class SynthUnavailableError  extends Error { constructor(m: string, opts?: { cause?: unknown }) { super(m, opts); this.name = "SynthUnavailableError";  } }

// Env knobs:
//   RERANK_PROVIDER  = "stub" | "voyage"   (mirror EMBEDDING_PROVIDER)
//   SYNTH_PROVIDER   = "stub" | "anthropic"
//   RETRIEVAL_RERANK_MIN_COSINE         default 0.3
//   RETRIEVAL_BREAKER_THRESHOLD         default 3
//   RETRIEVAL_BREAKER_WINDOW_MS         default 60000
//   RETRIEVAL_BREAKER_OPEN_MS           default 60000
```

`getReranker()` / `getSynthesizer()` factories mirror `getEmbedder()` ([lib/embedding.ts:148-164](../../lib/embedding.ts#L148-L164)) — env-driven, singleton on `globalThis`, fail-loud `RangeError` on unknown provider.

---

## §3 — Degraded mode contract

Three independent dependencies (embed, rerank, synth). Each guarded by an independent circuit breaker with the env knobs above. Breaker state machine: `closed` → (`THRESHOLD` consecutive 5xx in `WINDOW_MS`) → `open` for `OPEN_MS` → `half_open` (one probe) → `closed` on success or back to `open` on fail.

Outcome matrix (rows = `(embed, rerank, synth)` independent statuses):

| embed | rerank | synth | Response shape | `degraded` | `reason_code` |
|-------|--------|-------|----------------|------------|---------------|
| ok    | ok     | ok    | Full answer + citations | `false` | — |
| ok    | ok     | fail  | Citations + ranked chunk snippets, no synthesis | `true`  | `synth_unavailable` |
| ok    | fail   | ok    | ANN top-5 → synth (rerank skipped) | `true`  | `rerank_unavailable` |
| ok    | fail   | fail  | ANN top-5 chunks, no rerank, no synth | `true`  | `rerank_and_synth_unavailable` |
| fail  | —      | —     | HTTP 503 with `Retry-After`; no fallback (keyword lane lands in ADR-0013) | n/a | `embed_unavailable` |

Citation regex (§5) failures after the retry-once are mapped to `degraded:true` + `reason_code:"citation_validation_failed"` with the answer text discarded and citations returned bare.

---

## §4 — API shape

`POST /api/retrieve`
- **Auth:** `x-stub-user-role: admin | user` header per ADR-0010 stub-auth convention. Missing/invalid → 401. **Empty resolved `sensitivity_allowed[]` → 401**, not empty result — anonymous = unauthorized, not "user who sees nothing".
- **Body:** `{ query: string }`. No client-supplied `mode` discriminator (the eval entry point is internal-only; see §7).
- **Response:**
  ```typescript
  {
    answer: string;          // empty string when degraded with no synth
    citations: { entry_id: string; title: string; score: number }[];
    degraded: boolean;
    reason_code?: string;
    audit_id: string;        // uuid of the audit_log row written for this request
  }
  ```
- **No SSE streaming in v1.** Reserved for a future ADR if user-perceived latency on M3 acceptance demos justifies it. JSON-when-complete keeps the surface narrow.
- **No per-request rate limit in M3.** Rate limits ship at M5 ([ROADMAP.md §M5](../ROADMAP.md)). The eval runner enforces client-side concurrency.

---

## §5 — Citation enforcement (iron rule #3 mechanical floor)

Required output shape from synth: answer prose + a final `Sources: [<uuid>, <uuid>, ...]` block on its own line.

Server-side validation, in order:
1. Match `/^Sources:\s*\[([^\]]*)\]\s*$/m` against the answer body. Missing → fail.
2. Parse the bracket contents as a comma-separated list. Empty → fail.
3. Each ID must be a valid UUID v4 string. Otherwise → fail.
4. Each ID must appear in the `reranked_ids[]` candidate set from stage C. ID not in set → fail (model hallucinated a citation).

On fail: **retry once** with a stricter system-prompt prefix appended (e.g., `IMPORTANT: your last response was missing or invalid Sources block. Append "Sources: [<id1>, <id2>]" listing the entry_ids you cited.`). On second fail: respond with `degraded:true`, `reason_code:"citation_validation_failed"`, `answer:""`, and `citations:[]` mapped from `reranked_ids` instead.

This is the mechanical floor for iron rule #3 — without it, an uncited answer can ship.

---

## §6 — Sensitivity enforcement (iron rule #6)

Role → `sensitivity_allowed[]` mapping (server-side, never client-supplied):

| Role | `sensitivity_allowed[]` |
|------|-------------------------|
| `admin` | `["public", "internal", "restricted"]` |
| `user`  | `["public", "internal"]` |
| (none / invalid) | `[]` → 401 |

Compiled into stage B's SQL `WHERE chunks.sensitivity = ANY($2::text[])`. Forbidden post-hoc filtering of returned candidates: leak surface if downstream code skips the filter.

The composite-FK ([drizzle/schema.ts:99-105](../../drizzle/schema.ts#L99-L105)) ensures `chunks.sensitivity` is always in lockstep with `entries.sensitivity`; no second lookup needed.

---

## §7 — Eval hook

Internal function only:

```typescript
export async function evalRetrieve(query: string, role: "admin" | "user"): Promise<{
  reranked_ids: string[];        // top-N=5
  candidate_ids: string[];       // top-K=20 from ANN
}>;
```

Not exposed via HTTP. The eval runner (M3 items 6-7) imports it directly. Skipping the synth stage avoids paying Claude tokens to compute recall@5 / citation-precision against `evals/golden_set.yaml` `expected_source_ids`. Iron-rule-#8 stubs: `evalRetrieve` resolves the same `Reranker` singleton, so eval runs with `RERANK_PROVIDER=stub` exercise the pipeline shape without live Voyage calls.

---

## §8 — Log/audit extensions

Per ADR-0005, structured JSON logs cover every Voyage + Claude call. This pipeline emits:
- One `LogEventVoyage` per stage A (embed) and stage C (rerank), keyed by call site.
- One `LogEventClaude` for stage D (synth).
- One `LogEventRetrievalPipeline` (`kind:"retrieval_pipeline"`) per request for the request-level summary: total latency, degraded state + reason, citation-validation outcome, retry state, keyword-only flag. Shipped 2026-05-23; see ADR-0005 amendment of the same date. The route layer is the single emit site; one line per request on every terminal path EXCEPT the 401-from-`withUserOrAdmin` short-circuit (by design — auth wrapper returns before `handler` runs).

Audit row schema is pinned in stage E above. Cross-ref ADR-0005 for the per-call log shape contract; this ADR does not amend it.

---

## §9 — Consequences

### Positive
- All four in-scope iron rules satisfied by mechanical floors (compile-time, SQL constraint, or runtime regex), not by prose.
- Stub-mode test path remains valid: `EMBEDDING_PROVIDER=stub` + `RERANK_PROVIDER=stub` + `SYNTH_PROVIDER=stub` exercises the pipeline E2E with zero live API calls.
- Eval mode is internal-only — no public enumeration oracle.
- Embedding-version SQL filter prevents the silent failure mode of querying a corpus mid-re-embedding.
- Cost shape is bounded: stage C bills per-doc-token on 20 candidates (capped by min-cosine floor); stage D bills on ~3.5K input + N output tokens per request.

### Negative
- Trailing `Sources:` block is a structural commitment for the retrieval-agent prompt (v0.2.0 bump owns the wording). Models occasionally drop trailing blocks under heavy multi-step reasoning; the retry-once policy mitigates but does not eliminate.
- No SSE streaming in v1 means first-response latency = end-to-end latency (~1-3s expected on Sonnet). M5 may need to revisit if user feedback demands streaming.
- Circuit-breaker state is per-process; multi-instance prod (post-M5) will see breaker desynchronization unless promoted to a shared store. Acceptable for M3 single-instance dev.
- Five-stage pipeline pre-rerank-filter is bounded to `entries.sensitivity ∈ {public, internal, restricted}`; finer-grained ACLs (per-entry user allowlists, team-based restriction) are out of scope and would re-shape stage B's predicate.

### Deferred (BACKLOG)
- **ADR-0013 — Hybrid search + RRF fusion + Hebrew tsvector tokenization** (ROADMAP M3 item 4). Includes the `unaccent` + Hebrew morphology question and the RRF `k` constant tuned to top-K=20 lane sizes.
- **Query rewrite / HyDE** for short Hebrew queries (2-4 words). M4 polish candidate.
- **Identical-query memoization** `(query_hash, role, sensitivity_allowed, prompt_hash) → answer` for N minutes. Cuts Claude spend on eval demos. M4 polish.
- **Pagination / "show more results"** in the API response. M4 polish.
- **`LogEvent` `kind:"retrieval_pipeline"` discriminant** vs reusing existing kinds. Decide at implementation time; cross-ref existing BACKLOG `kind:"route"` entry.
- **Per-entry ACL / team-scoped restriction** beyond the three sensitivity tiers. Post-M5.
- **Multi-instance breaker promotion** to a shared store (Redis / Postgres advisory locks). Post-M5 hosting.

---

## Amendment 2026-05-26 — Candidates wire-shape extension (M4 #6 citation hover preview)

**Scope:** ROADMAP M4 #6 — citation hover preview on `/query`. Extends the `candidates` SSE event (defined at §2 stage B emission point) with three new fields projected from the same `boundaries[].body` the reranker/synth see. Cross-refs ADR-0013 §2.3 step 4 because the keyword-only entry's `body_snippet` is sourced from `synthesizeKeywordOnlyRepresentative` output (with the title prefix stripped — see §C below).

### §A — Type skeleton (per ADR-with-new-types sub-rule)

```ts
export type QueryCandidate = {
  entry_id: string;
  title: string;
  category: string;
  sensitivity: "public" | "internal" | "restricted";
  last_verified_at: string;          // ISO timestamp
  body_snippet: string;              // NEW — capped at 240 chars + ellipsis
  tags: string[];                    // NEW — entry tags verbatim
  source_pointer: string;            // NEW — entry source verbatim, plain text
};
```

### §B — Projection source: `boundaries[]`, not `orderedRows[]`

The orchestrator's `boundaries[]` array (built pre-rerank in [lib/retrieval-pipeline.ts](../../lib/retrieval-pipeline.ts)) carries the EXACT body string the reranker and synth see for each entry — `annBestChunkBodyByEntry` slice for ANN-lane entries; `synthesizeKeywordOnlyRepresentative(title, body)` for keyword-only entries. Re-using this string for the user-facing hover preview means the popup matches what the model scored — no parallel "snippet for the human" vs "snippet for the model" surface to drift.

**Emission timing.** The candidates event is yielded BEFORE the rerank stage (stage C), so `boundaries[i]` and `orderedRows[i]` correspond to the same fused-top-N entry at the same index at emission time. This invariant is preserved by the orchestrator's structure — never reorder `boundaries` after build.

### §C — Title-prefix strip on the keyword-only path

`synthesizeKeywordOnlyRepresentative` prepends `# ${title}\n` to its output. The candidate card already shows the title above the preview, so leaving the prefix in `body_snippet` would double the title in the UI. [lib/snippet.ts](../../lib/snippet.ts) `projectCandidateSnippet` strips the prefix only when an exact-title match is present at the head — a regression that pattern-stripped any leading `# …\n` line would silently delete real h1 markdown from a chunk.

### §D — 240-char cap with grapheme-safe back-off

Cap = 240 chars (~2-4 sentences in either Hebrew or English; ~50 English words or ~60 Hebrew words). Picked by readability for v1; BACKLOG holds a follow-up to size against the real entry-body distribution once M2a #8 lands real Priority entries. The cap is applied with a back-off step (`safeSnippetSlice`) that:
- Avoids splitting Unicode combining sequences (`\p{M}`) — Hebrew niqqud (U+05B0-U+05C7) are separate code points under NFC; a naïve `slice(0, 240)` could leave an orphan base letter on the edge.
- Avoids orphaning a UTF-16 high surrogate (0xD800-0xDBFF) at the snippet edge.

### §E — Required, not optional

Unlike `degraded?` / `degraded_reason?` (added incrementally as wire-evolution opt-ins), the three new fields are **required**. Justification:
- The orchestrator is the only emitter in the repo; there is no out-of-repo consumer and no rolling-window deploy that would see a slice-1 client paired with a slice-3 server (single Next.js app, lockstep deploy).
- Zero-length sentinels (`""`, `[]`) carry meaning ("no snippet/tags/source available") — optional would force needless `?? ""` / `?? []` handling at every reader.
- Required-field type-errors on test fixtures are the desired surface-completeness signal per the Reconciliation-grep-completeness sub-rule.

### §F — Iron-rule #6 (sensitivity) — same data plane

The candidate row already passed sensitivity SQL `WHERE` filtering in stage B (and ADR-0013's keyword-lane SQL). Projecting `body_snippet` / `tags` / `source_pointer` onto the wire surfaces no new sensitivity territory beyond what `chunks_only.snippet` already does. Non-negotiables #6 and #7 treat the entry row as the sensitivity unit — there is no finer-grained per-field policy for tags or source_pointer. (Per-field ACLs are post-M5 territory, same line as per-entry ACLs.)

### §G — Audit-row shape unaffected

`audit_log.payload` for `kind:"agent_retrieval"` carries `ann_candidate_ids` / `keyword_candidate_ids` / `fused_ids` / `citation_ids` (UUID arrays) — no wire-event shape. Adding fields to the wire `candidates` event does NOT touch audit columns. Confirmed by grep of `lib/retrieval-audit*.ts`.

### §H — Performance

240 chars × top-N=5 + small tag arrays = ~1.2 KB extra per first SSE frame. Negligible against the ~3.5K-token synth input that follows it. No new audit-write volume (the entry_view audit fires only on click-through to `/entries/[id]`, unchanged).

### §I — Snippet precedence on `chunks_only` terminal

The orchestrator already emits `chunks_only` with per-rank `snippet` strings (post-rerank order). Once `candidates` also carries `body_snippet` (pre-rerank), the page must define precedence:

- `state.status === "chunks_only"` → prefer `chunkSnippets[].snippet` (post-rerank, matches the order the user already sees in chunks_only UX).
- All other states → use `candidates[].body_snippet`.

Aligned by `entry_id`; chunks_only entries are a subset of candidates by construction. **Fallback when chunks_only path is active but the entry is NOT in `chunkSnippets`** (i.e., the candidate was emitted pre-rerank but didn't survive rerank): use `c.body_snippet`. The card is still rendered (the candidates list — not `chunks_only.entries` — is the visible surface), so the user gets the pre-rerank preview rather than a popup with no content. Trade-off: the snippet won't match chunks_only's rank-specific ordering for that card. Acceptable v1; alternative considered was to hide the popup entirely on this fallback path — rejected as worse UX. Codified in [app/query/page.tsx](../../app/query/page.tsx).

### §J — 2-pass code review expected

Wire-discriminant extension touches strict-equality test assertions across multiple test files. Per SESSION_PROTOCOL.md Step 7b "Amplified covers review-induced plan changes", a fresh code-CR on the implemented diff is the default expectation, not the exception.

---

## Amendment 2026-05-28 — citation_precision eval leg (live-Anthropic opt-in)

**Scope:** ROADMAP M3 #7 citation_precision leg. The recall@5 leg shipped 2026-05-27 via `evalRetrieve` (§7), which deliberately omits stage D — so `citation_precision` reports `skipped`. This amendment wires the metric via a **live-Anthropic opt-in** path while keeping the default `npm run eval` stub-only and honest.

### §K — Decision: (a) live-opt-in, not (b) eval-stub citing reranked_ids[0]

The deferred design choice (docs/BACKLOG.md, ADR-0012 §7) was:

- **(a) live-Anthropic opt-in (CHOSEN).** New `evalRetrieveWithSynth(query, role, deps?)` resolves `getSynthesizer()` into `PipelineDeps.synth`, so the orchestrator runs stage D + §5 citation validation and populates `outcome.citation_ids`. The eval runner routes through it only under `EVAL_USE_LIVE_SYNTH=1`; default stays `evalRetrieve` (synth omitted → `citation_precision` skipped). Real numbers require `SYNTH_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` and a manual run (~$0.01–0.10/run for n≈3–5 cases).
- **(b) eval-stub citing `reranked_ids[0]` (REJECTED).** A deterministic stub that always cites the top reranked id would make `citation_precision` free + CI-runnable, but the number would measure "did rerank put the expected entry first" (i.e. recall@1) under a `citation_precision` label. Mislabeling a metric is the same smell the project's negative-assertion-test discipline (WORKFLOW.md) forbids. Rejected.

### §L — Type skeleton (per ADR-with-new-types sub-rule)

```ts
// lib/retrieval.ts
export type EvalRetrieveWithSynthResult = EvalRetrieveResult & {
  citation_ids: string[]; // synth-cited entry_ids; subset of reranked_ids; [] on any non-ok terminal
};

// lib/retrieval-eval.ts
export async function evalRetrieveWithSynth(
  query: string, role: Role, deps?: Partial<PipelineDeps>,
): Promise<EvalRetrieveWithSynthResult>;          // resolves getSynthesizer() into PipelineDeps.synth
export function projectToEvalWithSynthResult(
  outcome: AuditOutcome,
): EvalRetrieveWithSynthResult;                    // = { ...projectToEvalResult(outcome), citation_ids }
```

### §M — The gate (single chokepoint in `pinStubProviders`)

`EVAL_USE_LIVE_SYNTH=1` ⇒ require `SYNTH_PROVIDER` unset or `"anthropic"` (set to `anthropic` if unset; **reject explicit `stub`**) AND require `ANTHROPIC_API_KEY` — both fail-loud `Error`. Embed + rerank stay pinned to stub so synth is the only live variable. The synth singleton is reset (`resetSynthesizerForTests()`) in `pinStubProviders` BEFORE the first `getSynthesizer()`; without the reset a stub cached by a prior vitest worker would leak into the live path, silently running the stub and producing fake "live" numbers. (The reset helper is named `…ForTests` but is the only reset available; the production-CLI use is intentional — a rename to drop the `ForTests` suffix is a cheap BACKLOG follow-up, not load-bearing.)

**Why reject explicit `stub` under the live flag:** the stub synth (`createStubSynthesizer`) cites `STUB_SYNTH_SENTINEL_UUID`, never in `reranked_ids`, so §5 validation hard-fails → `citation_ids = []` → `skipped`. A `live flag + stub provider` combination would look like a measured run that measured nothing.

### §N — Iron-rule stances

- **#8 (tests never call live APIs).** Unchanged. The default gate + CI run `evalRetrieve` (stub-only); the new unit tests inject a stub synth via `deps` (no live call). The live path is reachable only via the `EVAL_USE_LIVE_SYNTH=1` CLI opt-in — a manual smoke, not a test. This matches the eval module's standing rule (`lib/retrieval-eval.ts` header: "Live-API eval is a separate, manually-run smoke session per ADR-0011 repo-visibility constraints") and §9 Positive ("Eval mode is internal-only — no public enumeration oracle"). No vitest test sets the flag with a real key.
- **#10 (prompt hash stored with every agent response) — carve-out.** A live synth call during eval IS an Anthropic agent response, but eval writes **no `audit_log` row** (the route writes audits; `evalRetrieve`/`evalRetrieveWithSynth` bypass the route). This is **not** a #10 violation: #10 binds the **served** retrieval path and its `audit_log` row, not the offline eval CLI. Eval is measurement, not a user-facing served response — it produces no answer to a user, persists nothing, and exists only to score retrieval against the golden set. The orchestrator still pins `RETRIEVAL_AGENT_PROMPT_HASH` internally; the eval simply discards the answer after extracting `citation_ids`. Recorded here so the contradiction is reconciled, not silent.

### §O — Verification + manual-smoke expectation

- **Plumbing** is unit-tested (injected-stub `evalRetrieveWithSynth` positive/negative + the gate fail-loud paths). CI proves the wiring, never the live numbers.
- **Manual smoke** (operator, Phase-2): `EVAL_USE_LIVE_SYNTH=1 SYNTH_PROVIDER=anthropic npm run eval` with `ANTHROPIC_API_KEY` set, against local Postgres seeded with the 3 anchored fixtures (en-001 / en-009 / he-003). Expected: `citation_precision_mean` non-null and high (likely 1.0 — each query directly anchors its fixture entry). An all-`null`/all-zero result across the 3 anchored cases signals a broken wire (synth not actually running, or the corpus unseeded), not a genuine precision failure.
- **No `SCHEMA_VERSION` bump.** `EvalRunSummary` already carries `citation_precision` / `citation_precision_mean`; this amendment changes the metric's *values*, not the runner output *shape* or the golden-set YAML contract (schema.ts `SCHEMA_VERSION` unchanged).
- **n < 20 stays pipeline-correctness signal,** not acceptance evidence — the M3 0.9 bar remains double-gated on n ≥ 20 measurable cases AND a real Voyage embedder (ROADMAP M3 Acceptance).

## References

- ROADMAP M3 items 1-8 ([docs/ROADMAP.md §M3](../ROADMAP.md)).
- ADR-0005 — log event schema.
- ADR-0008 — Drizzle + migration ownership (`vector(1024)` + HNSW lifecycle).
- ADR-0009 — chunking strategy (500/60, sensitivity composite-FK).
- ADR-0010 — admin ingestion chat UI (stub-auth convention reused here).
- ADR-0011 — repo visibility (orthogonal but constrains demo-data scope).
- [prompts/retrieval-agent.md](../../prompts/retrieval-agent.md) — v0.1.0 prompt; v0.2.0 bump for `Sources:` block lands with the implementation PR.
- Voyage embedding `input_type` parameter — see `voyage-3-large` API docs (asymmetric query/document mode).
- Voyage `rerank-2` pricing — billed per-input-token of candidate documents.
- pgvector HNSW operator classes — `vector_cosine_ops` chosen for stub-mode compatibility (stub vectors are not L2-normalized).
