# ADR-0009 — Chunking strategy (sizes, boundaries, metadata, lifecycle)

- **Date:** 2026-05-17
- **Status:** Accepted
- **Deciders:** Gal Zilberman + Claude (with independent plan-reviewer subagent)

## Context

ROADMAP M1 line 22 reserves a chunking-strategy ADR with the working defaults of "~500 token chunks with overlap, semantic boundaries where possible." That line originally numbered the ADR `0004`; both `0004` (PR-title mechanical floor) and `0008` (ORM + migration ownership) have since claimed numbers ahead of it, so this is **ADR-0009**.

The chunking ADR sits between ADR-0008 (decided how schema lands) and the baseline-migration PR (will create real tables). Together with ADR-0008 it answers everything the baseline migration needs to know about `chunks`. After this ADR lands, the baseline migration is unblocked.

The unbiased plan reviewer flagged two BLOCKING issues that reshaped the original plan:

1. The original plan said `entries.body` was kept "verbatim" *and* that M2a applies a PII scrub. Those two claims are incompatible: either `entries.body` is pre-scrub (and embeddings + retrieval leak PII) or it's post-scrub (and "verbatim" is wrong). Picked one.
2. Denormalizing `sensitivity` to `chunks` with "sync enforced at write" is the exact "honor-system" pattern the project's mechanical-floor posture exists to replace. Replaced with a composite-FK mechanism that propagates at the DB level.

## Decision

### 1. Chunk size, overlap, trailing-chunk merge

- **Default chunk size:** 500 tokens.
- **Overlap:** 60 tokens (12%).
- **Minimum trailing chunk:** if a naive split would leave a final chunk smaller than 60 tokens, the trailing fragment is merged into the previous chunk (which then exceeds the 500 default by up to 60 tokens). The "merge trailing tiny chunk" rule avoids polluting recall with nearly-empty chunks that share most of their content with their predecessor.
- **Short entries:** if `body_token_count ≤ 500`, the entry becomes a single chunk equal to the whole body. **For Priority's OCR-dominated corpus this is the common case, not the edge case** — most screenshot OCR outputs are 100–300 tokens. The 500/60 defaults are the long-form fallback.

### 2. Tokenizer / sizing proxy

- **Tokenizer:** `js-tiktoken` (≥ 1.0.10, which introduced `o200k_base`) with the `o200k_base` vocabulary. `o200k_base` is the GPT-4o-family BPE and a marginally closer proxy for Voyage's undisclosed tokenizer than `cl100k_base`.
- **`chunks.token_count` is the local-proxy count** over the body slice (`entries.body[content_start..content_end]`). It is **not** wire-authoritative — Voyage's embeddings endpoint returns only an aggregate `usage.total_tokens` per request (one number for the whole batch), so per-chunk wire counts are not directly available. We accept the proxy with a clear name: this is a *planning* number, not a *billing* number.
- **Cost attribution at M5** is computed from Voyage's per-request `usage.total_tokens`, divided across the batch by proxy-weighted shares. The proxy's small inaccuracy averages out across a corpus; this is good enough for cost dashboards and does not propagate into recall.
- **Per-request limit enforcement:** at embed time, the planner checks `local_proxy(prefix + body_slice) ≤ 32k` before sending. Combined with the 500-token chunk default and a 256-char title clip (§6), the 32k Voyage per-input limit is never approached in normal flow; the check is a safety net for pathological inputs, not a hot-path concern.

### 3. Boundary rules

Prefer, in order: paragraph break → sentence end → word break. **Never split inside:** a fenced code block, an inline code span, a Markdown table row.

- **Hebrew + English** both honored. Modern Hebrew UI text uses the same ASCII sentence enders (`.`, `?`, `!`) the regex already looks for; the Hebrew-specific punctuation glyphs (`׃` sof pasuq, `׀` paseq) are biblical / cantillation marks and not in scope for Priority screenshots.
- **OCR-degraded text:** OCR output of Priority's mostly-form-label screenshots often lacks reliable sentence structure; the boundary rule degrades cleanly to word-level breaks. This is acceptable and expected for the dominant content type.

### 4. Per-chunk metadata (committed to schema)

The baseline-migration PR creates the `chunks` table with the union of ADR-0008's iron-rule columns and the columns below. Skeleton (subset of the full chunks shape):

```ts
export const chunks = pgTable("chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  entry_id: uuid("entry_id").notNull(),
  sensitivity: text("sensitivity", { enum: sensitivityEnum }).notNull(),       // #6 (composite FK below)
  chunk_index: integer("chunk_index").notNull(),
  chunk_total: integer("chunk_total").notNull(),
  content_start: integer("content_start").notNull(),                           // char offset into entries.body
  content_end: integer("content_end").notNull(),
  token_count: integer("token_count").notNull(),                               // BODY-only, excludes the embed prefix
  chunking_policy_version: text("chunking_policy_version").notNull(),          // analog of embedding_version
  embedding: vector("embedding", { dimensions: 1024 }).notNull(),              // ADR-0008
  embedding_model: text("embedding_model").notNull(),                          // #9
  embedding_version: text("embedding_version").notNull(),                      // #9
}, (t) => ({
  // composite FK that ON UPDATE CASCADEs entries.sensitivity changes into chunks.
  // REQUIRES: a UNIQUE constraint on entries(id, sensitivity) — Postgres FKs target
  // PRIMARY KEY or UNIQUE tuples only; entries.id alone being PK is not sufficient.
  // The baseline migration adds `unique("entries_id_sensitivity_uq").on(id, sensitivity)`
  // on the entries table.
  entryFk: foreignKey({
    columns: [t.entry_id, t.sensitivity],
    foreignColumns: [entries.id, entries.sensitivity],
  }).onUpdate("cascade"),
}));
```

**`entries` table addition required for the FK target:** the baseline migration adds `unique("entries_id_sensitivity_uq").on(entries.id, entries.sensitivity)`. Without it the FK declaration fails with `there is no unique constraint matching given keys for referenced table "entries"`.

- **`chunk_index`** — zero-based position of this chunk in the entry.
- **`chunk_total`** — denormalized count of chunks for the entry; used by the "chunk N of M" citation UI hint. Drift-resilient because every write of chunks for an entry happens in a single transaction that computes `chunk_total = len(chunks_for_entry)` once and writes the same value into every row — at initial INSERT, at edit (full DELETE-INSERT), and at re-chunk (full DELETE-INSERT). No partial-update path exists.
- **`token_count`** — **body-only**; equals `content_end - content_start` worth of tokens. The embed-time total (`token_count + prefix_tokens`) is what's checked against Voyage's per-request limit, but is not persisted.
- **`content_start` / `content_end`** — char offsets into **`entries.body`** (post-scrub canonical). Offsets are over the body, not over the prefixed embed input. Re-chunking is re-derivable from `entries.body` because the offsets and the canonical body match.
- **`chunking_policy_version`** — string identifier of the chunking-policy version the row was produced under (e.g., `"v1-2026-05-17"`). Mirrors ADR-0008's `embedding_version` convention; lets a re-chunk migration target rows under an outdated policy without scanning every entry.

### 5. Source-body retention and PII scrub ordering

- `entries.body` is the **post-scrub canonical text** — the same text that:
  - users see when they click through a citation,
  - chunks are derived from (`content_start` / `content_end` index into it),
  - the embed input is built from (prefix + slice of `entries.body`).
- The simple regex/heuristic PII scrub from M2a (emails, phones, IDs) runs **on ingest, before `entries.body` is written**. There is no `body_raw` column; the project does not retain raw PII. A future stronger-scrub policy (M2b) re-runs the new scrub against the already-scrubbed body, which is one-way: harder scrubs subsume softer ones, but the original characters are not recoverable. This is the deliberate tradeoff — non-retention of raw PII is the more compliance-friendly default and the project does not have a use case for un-scrubbed text.
- **Re-chunk on policy change is therefore re-derive-from-post-scrub.** The pre-scrub original is not part of the data model.

### 6. Title + tags prefix at embed time only

Each chunk's embed input is built as:

```
Title: <entries.title clipped to 256 chars>
Tags: <comma-separated entries.tags>

<entries.body[content_start..content_end]>
```

- **Embed only.** The prefix is part of what Voyage receives at embedding time. It is **not** part of `content_start`/`content_end`, **not** persisted on the chunk row, **not** passed to Voyage `rerank-2` as candidate text, and **not** included in the Sonnet synthesis prompt. Rerank receives the raw chunk content (`entries.body[content_start..content_end]`); Sonnet receives the same plus the entry's full metadata (`title`, `category`, `tags`, `source_pointer`, `last_verified_at`) as structured fields, not by re-embedding it into chunk text.
- **Rationale:** prepending title/tags at embed time tightens recall on otherwise-ambiguous chunks (e.g., a screenshot OCR that says "Quantity must be > 0" matches better with title context "PO Receipt — Validation Errors"). Forwarding the same prefix to rerank would double-count title terms across all candidate chunks under that title and bias the lexical signal; forwarding to Sonnet risks the model quoting the prefix as if it were body content. The clear three-way separation (embed: with prefix / rerank: raw content / synthesis: structured fields) avoids both failure modes.
- **Title clip at 256 chars** at ingestion is the only normalization needed; with 500-token chunks the Voyage 32k per-request limit is never approached in normal flow.

### 7. Lifecycle — entry edits, versioning, re-chunk

- **Entry edit appends to `entries_versions`** (per ROADMAP M2a line 40) **and updates `entries.body` + `entries.title` + `entries.tags`** to the new latest version. **Within the same transaction**, all `chunks` rows where `entry_id = X` are DELETED and re-derived from the new `entries.body`. Atomic per entry — under Postgres's default MVCC + `READ COMMITTED` isolation, concurrent readers either see the pre-edit state (old body + old chunks) or the post-edit state (new body + new chunks); they never see the intermediate state mid-transaction.
- **`entries_versions` rows are NOT chunked.** Historical versions are not retrievable in M3; retrieval is always over the current version. If retrieval-over-history becomes a M4 product requirement, that's a separate ADR.
- **Re-chunk-policy event** (the chunking strategy itself changes): a data-migration script (see §8) walks entries, deletes their chunks, re-derives under the new policy. Per-entry transactional shape is the same as for entry edit (`DELETE FROM chunks WHERE entry_id = $1; INSERT …`). There is no whole-corpus transaction — entries are processed one at a time so a long re-chunk job doesn't hold a corpus-wide lock.
- **Re-chunk triggered by a PII-scrub policy change.** The new scrub re-runs against the existing `entries.body` (which is already post-scrub from the previous policy); then chunks are re-derived under the same chunking policy as before. The scrub is *monotonic* — it can strip more characters, never restore them — so a "soften the scrub" change is not operationally meaningful, only "tighten it" is. This is the cost of not retaining a `body_raw` column; the trade-off is restated here so the migration planner doesn't have to re-discover it from §5.

### 8. Re-chunk operational shape — pre-M2b vs post-M2b

- **Pre-M2b (M3 evals likely surface chunking-quality issues here):** re-chunk runs as a one-off Node script — `scripts/rechunk.ts`. No queue, no worker, no FastAPI. Inputs: source policy version, target policy version, optional entry-ID allowlist. Run from `npm run rechunk`.
  - **Idempotency:** the script reads `chunks.chunking_policy_version` and skips rows already on the target policy. A mid-failure re-run resumes naturally; no separate `--resume` flag.
  - **Per-entry commit cadence:** one transaction per entry (DELETE old chunks + INSERT new). Entries are processed serially in the M1–M3 corpus-size regime; batching only matters at M5 scale.
  - **Voyage 5xx handling:** retry-with-exponential-backoff up to 3 attempts per entry; on persistent failure the entry's old chunks remain (transaction rolled back), the failure is logged with the entry ID, and the script continues with the next entry. A summary line at the end lists failures so the operator can re-run targeted.
  - **Progress log:** stdout NDJSON via the existing `lib/log.ts` helper (one `{kind:"rechunk", entry_id, status, ...}` line per entry). Same shape as the rest of the project's observability so no new sink is needed.
  - **This is the honest answer for the M1–M3 window** — M2b activates Python and the proper queued worker; before that, a TS script is sufficient and matches the corpus size.
- **Post-M2b:** the worker queue absorbs re-chunk jobs alongside the re-embed pattern from ADR-0008 §8. `scripts/rechunk.ts` is retired (or kept as a debug fallback). Schema migrations that bump `chunking_policy_version` enqueue work; the worker is the executor.
- **The chunking ADR does not call any LLM** — chunking is deterministic / model-free. **Iron rule #10 is N/A here** because chunking emits no agent response (the rule is "the hash is stored alongside every agent response"; there is no response to attach a hash to). The ingestion-agent's prompt_hash recorded on `audit_log` (per ADR-0008 §6) covers the entry-level write; chunking is purely downstream.

### 9. Hybrid search / `tsvector` — deferred to M3

`tsvector` keyword match (ROADMAP M3 line 58, Hebrew via `simple` config + `unaccent`) is a retrieval-layer concern, not a chunking-layer one. **The baseline migration ships `chunks` without a `search_tsv` column.** If M3 evals show hybrid recall benefits from a per-chunk tsvector index, M3 adds the column via its own migration. If M3 finds that an entry-level tsvector on `entries.body` is sufficient, no `chunks` change is needed. Either way, the chunking ADR does not pre-commit.

## Consequences

**Positive.**

- **Mechanical iron-rule enforcement.** `chunks.sensitivity` is FK-CASCADE-bound to `entries.sensitivity`; a future admin-edit route that forgets to propagate sensitivity is caught at the DB level. The composite-FK pattern is the chunks-layer twin of ADR-0008's `CHECK` on `audit_log`.
- **PII scrub semantics are unambiguous.** `entries.body` is the canonical post-scrub text; embeddings, offsets, and the citation surface all point to the same string. No "verbatim raw" vs "what users see" mismatch.
- **Re-chunk has an actual operational path** for the M1–M3 window, not a "the worker will do it" handwave. `scripts/rechunk.ts` is concrete enough to plan against.
- **`chunking_policy_version` lets re-chunk migrations target stale rows** without scanning the corpus — same ergonomics as ADR-0008's `embedding_version`.
- **Prefix scope is bounded.** Rerank and Sonnet receive raw chunk content; only the embedding model sees the title/tags-augmented form. The retrieval reviewer at M3 can't trip on title-double-counting.

**Negative / accepted.**

- **No raw-PII retention.** A future "we need to undo a scrub" request cannot be satisfied. Accepted — the compliance posture is more important than the recovery option, and no current product requirement names raw retention.
- **`chunks.token_count` is body-only, not embed-input.** Means cost-attribution code at M5 will need to compute embed-input totals from `token_count + len(prefix_tokens)`. Accepted — the alternative (storing the prefixed count) makes `token_count` no longer equal to `content_end - content_start` and breaks the offset/length invariant.
- **`scripts/rechunk.ts` is a temporary tool.** Will be retired when M2b's worker absorbs the job. Accepted; honest two-phase plan.
- **Trailing-chunk merge can produce chunks up to 560 tokens.** Within Voyage's 32k per-input limit by 60×; not a real risk.
- **`chunk_total` is denormalized.** Justified by the citation UI's "N of M" hint and protected from drift by the per-entry full-DELETE-INSERT re-chunk shape.

**Files this ADR's acceptance touches (no code in THIS PR; cascading edits only):**

- `docs/adr/README.md` — add ADR-0009 to the index.
- `docs/ROADMAP.md` M1 line 22 — amend to reference ADR-0009 (was placeholder `M1 ADR-0004`).

**Downstream PRs unblocked.**

- **Baseline migration PR.** With ADR-0008 (schema ownership) and ADR-0009 (chunking) both landed, the baseline migration can ship the real `entries`, `entries_versions`, `chunks`, `audit_log` tables. Drizzle schema absorbs ADR-0008's iron-rule columns + ADR-0009's chunking metadata + the composite FK on `chunks.(entry_id, sensitivity) → entries.(id, sensitivity)`.

## Alternatives considered

- **`entries.body_raw` retained alongside `entries.body`.** Rejected — raw-PII retention is a compliance liability without a current product justification. The simpler one-way scrub semantics are preferred.
- **Trigger-maintained `chunks.sensitivity` instead of composite FK.** Rejected — triggers hide enforcement and are easy to drop in a future migration without noticing. The FK is visible in the schema diff and fails loudly.
- **Drop `chunks.sensitivity` denormalization entirely; always join `entries` on retrieval.** Rejected — the M3 retrieval hot path filters by sensitivity on every query; the join cost is real and the FK-CASCADE makes denormalization safe.
- **`count_tokens` API call per chunk for authoritative sizing.** Rejected — extra round-trip per chunk for a marginal accuracy gain over `o200k_base`. Voyage already returns token counts in the embedding response; that's the authoritative source.
- **Per-content-type chunk size variants (long-form: 500/60; screenshot OCR: 200/20; PDF: page-bounded).** Rejected at this ADR — single-chunk-equals-body already handles screenshot OCR (the common case); per-type tuning is a M2b worker-ADR concern. ADR-0009 names the expectation explicitly so M2b can't claim surprise.
- **Title-prefix included in rerank candidate text.** Rejected — biases the reranker's lexical signal toward title-heavy queries.
- **Title-prefix forwarded as chunk text to Sonnet.** Rejected — risks the model quoting the prefix as if it were body content in a citation.
- **Per-chunk `tsvector` column declared in this ADR.** Rejected — defer to M3 where retrieval owns the call. Pre-committing here risks the baseline migration shipping a column M3 doesn't end up needing.
- **Whole-corpus transaction for re-chunk policy change.** Rejected — long re-chunk job holding a corpus-wide lock blocks ingestion. Per-entry transactions are the right granularity.
