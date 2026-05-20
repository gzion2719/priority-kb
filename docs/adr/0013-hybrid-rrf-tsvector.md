# ADR-0013 — Hybrid keyword lane + RRF fusion + Hebrew tsvector tokenization (M3 item 4)

**Status:** Accepted
**Date:** 2026-05-20
**Scope:** ROADMAP M3 item 4 — hybrid search combining ADR-0012's ANN lane with a Postgres `tsvector` keyword lane via Reciprocal Rank Fusion, plus the Hebrew-tokenization decision pinned at `simple` + `unaccent`. Also closes ROADMAP M3 item 8 (full keyword-only degraded-mode fallback when the embedder is down). No code ships in this PR — schema migration, route changes, and pipeline wiring land with the M3 item 4 implementation PR.

---

## Context

ADR-0012 spec'd the M3 item 3 pipeline (`query embed → pgvector HNSW → Voyage rerank-2 → Claude synth → cited answer`) and explicitly reserved hybrid keyword search + score fusion for this ADR:

- ADR-0012 §"Context" iron-rule-#12 row: "the keyword lane is ADR-0013 territory. This ADR's degraded contract covers the embedder + rerank + synth failure surface; the full degraded-mode acceptance shifts to ADR-0013."
- ADR-0012 §9 "Deferred (BACKLOG)" first entry: "ADR-0013 — Hybrid search + RRF fusion + Hebrew tsvector tokenization (ROADMAP M3 item 4). Includes the `unaccent` + Hebrew morphology question and the RRF `k` constant tuned to top-K=20 lane sizes."

ROADMAP M3 item 4 wording (verbatim): "Hybrid search: combine pgvector ANN scores with Postgres `tsvector` keyword match (Hebrew via `simple` config + `unaccent`)." That language pins the tokenization config; this ADR commits to it and documents the tradeoff.

AGENTS.md retrieval pipeline step 4: "Hybrid: blend with Postgres `tsvector` keyword scores (M3)." Same constraint, restated.

Iron rules this ADR is bound by:

| # | Rule | How this ADR satisfies it |
|---|---|---|
| #3 | Every retrieval answer cites the entries it used. | Degraded-bare mode (no synth) returns `citations[]` from the keyword lane directly; §3 makes the "Sources" validation policy explicit for the empty-answer case. |
| #6 | Sensitivity respected server-side. | Stage B′ compiles `WHERE entries.sensitivity = ANY($2::text[])` into the keyword SQL — same role-derived predicate ADR-0012 stage B uses. |
| #8 | Tests never call live embedding/Claude/Voyage APIs. | Keyword lane is pure Postgres SQL — no external SDK boundary; integration tests against the project's containerized Postgres (with `unaccent` extension installed by the migration) suffice. §6 names this explicitly. |
| #9 | Embedding model+version stored per row + per request. | Keyword lane has no embedding involvement, but §5 still records `embedding_model`/`embedding_version` of the *configured* embedder in the keyword-only-fallback audit row — the embedder that would have run. Shape stability over null-fields. |
| #12 | Degraded mode required (keyword-only when Claude/Voyage down). | §3 ships the full 8-combo `(embed × rerank × synth)` outcome matrix. ADR-0012's `embed_unavailable` → 503 row is superseded by four new keyword-fallback rows. |

No code ships in this ADR. The implementation PR (M3 item 4) will land: the migration, the `entries.tsv` trigger, the GIN index, the `evalRetrieve`/route changes, and the audit-payload schema extension.

---

## Decision

### §2.1 — Schema additions

**Postgres extension.** Install `unaccent` via a Drizzle migration:

```sql
CREATE EXTENSION IF NOT EXISTS unaccent;
```

**Generated-column trade-off resolved: trigger-maintained `tsv` column, not `GENERATED ALWAYS AS ... STORED`.**

The natural form is a generated column:

```sql
-- REJECTED — does not run.
ALTER TABLE entries
  ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('simple',
      unaccent(coalesce(title,'') || ' ' || array_to_string(tags,' ') || ' ' || coalesce(body,'')))
  ) STORED;
```

Postgres rejects this: `unaccent(text)` from the `unaccent` extension is declared **STABLE** (not IMMUTABLE) because it reads from the `unaccent` rules dictionary at runtime. Postgres requires generated-column expressions to be IMMUTABLE end-to-end and errors with `generation expression is not immutable`. `to_tsvector('simple', literal_config, text)` is itself IMMUTABLE when the config arg is a literal (it is here), so the failure point is `unaccent` alone.

The two viable paths:

1. **Trigger-maintained column** (chosen): plain `tsv tsvector NOT NULL` column, populated by a `BEFORE INSERT OR UPDATE` trigger that runs the same `to_tsvector('simple', unaccent(...))` expression. Cost: one trigger; write path goes through a function instead of a generated-column expression. Honest about the STABLE→runtime dependency.
2. **IMMUTABLE wrapper** (alternative-considered, rejected): declare a SQL-language wrapper `CREATE FUNCTION immutable_unaccent(text) RETURNS text AS $$ SELECT unaccent('unaccent', $1) $$ LANGUAGE sql IMMUTABLE;` and reference it in the generated-column expression. This is a "lie to the planner" with known sharp edges: if the `unaccent` rules dictionary is updated (a maintainer action, not a user action) the stored values become stale and are not auto-rebuilt. Pre-M5 the rules dictionary is static, so the lie is harmless — but the trigger path is cleaner and avoids the IMMUTABLE-lie pattern. Reserved as a future optimization if trigger overhead surfaces in M5+ profiling.

Schema after the migration:

```sql
ALTER TABLE entries ADD COLUMN tsv tsvector NOT NULL DEFAULT ''::tsvector;

CREATE OR REPLACE FUNCTION entries_tsv_refresh() RETURNS trigger AS $$
BEGIN
  NEW.tsv := to_tsvector('simple',
    unaccent(coalesce(NEW.title,'') || ' ' || array_to_string(NEW.tags,' ') || ' ' || coalesce(NEW.body,'')));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER entries_tsv_refresh_trigger
  BEFORE INSERT OR UPDATE OF title, tags, body ON entries
  FOR EACH ROW EXECUTE FUNCTION entries_tsv_refresh();

-- Backfill existing rows so DEFAULT '' is replaced by the real tsvector.
-- Errata 2026-05-21 — see note at end of §2.1: the original snippet was
-- `UPDATE entries SET tsv = tsv WHERE TRUE;`, which does NOT fire the
-- trigger above (trigger is scoped to `UPDATE OF title, tags, body`, not
-- `tsv`). The canonical Postgres idiom is to update a watched column to
-- itself, which fires the trigger and recomputes `tsv`:
UPDATE entries SET title = title WHERE TRUE;

CREATE INDEX entries_tsv_gin_idx ON entries USING gin (tsv);
```

Note: `array_to_string(NEW.tags,' ')` doesn't need `coalesce` — the `tags` column has `NOT NULL DEFAULT '{}'::text[]` (see `drizzle/schema.ts:25-28`), and `array_to_string` on an empty array returns `''`, not NULL.

**Errata 2026-05-21** — Four corrections found during M3 item 4 implementation review + gate run (see CHATLOG 2026-05-21 entry); applied in-place above and listed here for traceability:

1. **Backfill snippet (`UPDATE entries SET tsv = tsv WHERE TRUE;`)** does not fire the trigger. The trigger is declared `BEFORE INSERT OR UPDATE OF title, tags, body` — column `tsv` is not in that list, so writing to it bypasses the recompute path. The canonical Postgres backfill idiom for column-list triggers is to write a watched column to itself: `UPDATE entries SET title = title WHERE TRUE;`. Applied above.
2. **`CREATE EXTENSION IF NOT EXISTS unaccent;`** belongs in `db/init.sql`, not in the Drizzle migration, per ADR-0008 §10 (extension installs run as the bootstrap superuser; Drizzle migrations run as the least-privilege app user — a future role split would make a migration-level `CREATE EXTENSION` fail). Migration 0002 assumes the extension is pre-installed.
3. **`CREATE INDEX CONCURRENTLY`** is unsupported by `drizzle-kit migrate` (single-transaction per file, see ADR-0008 §12). The implementation ships plain `CREATE INDEX` in migration 0003 — safe because the M3-era corpus is empty pre-M5. The M5+ obligation to ship a `CREATE INDEX CONCURRENTLY` re-creation alongside the production-data backfill is added to §"Deferred (BACKLOG)" below.

Implementation also adds a defensive `BEFORE UPDATE OF tsv` guard trigger that raises an exception on any direct `UPDATE entries SET tsv = ...` (admin SQL, future migration, etc.) — defense-in-depth against silently storing a stale tsvector that diverges from the title/tags/body that should have generated it.

4. **`unaccent()` does NOT strip Hebrew niqqud.** §2.2 claimed `unaccent()` collapses `שָׁלוֹם` and `שלום` to the same indexed token. Empirically refuted on `pgvector/pgvector:pg16` (the project's pinned image): `SELECT unaccent('שָׁלוֹם')` returns `שָׁלוֹם` unchanged — Postgres's default `unaccent.rules` ships Latin-only mappings, no Hebrew-character coverage. Fix: compose `regexp_replace(text, '[֑-ׇ]', '', 'g')` (Unicode U+0591..U+05C7 — Hebrew vowel points + cantillation marks) BEFORE `unaccent` at both index and query time. Trigger function in migration 0002 and `keywordCandidates` SQL in `lib/retrieval-keyword.ts` both apply the composition `to_tsvector('simple', unaccent(regexp_replace(text, '[֑-ׇ]', '', 'g')))`. The Latin-diacritic claim (`café` ↔ `cafe`) remains correct — only the Hebrew claim was wrong.

The Hebrew niqqud miss is the kind of factual error that the verify-before-implementing-CR-claim sub-rule (`SESSION_PROTOCOL.md` Step 7b) catches when applied to CR findings; this same discipline now extends symmetrically to ADR claims about external behavior — verify with a `SELECT` before relying on an unverified spec statement.

Drizzle declaration mirrors the HNSW pattern from `drizzle/schema.ts:109-112`:

```typescript
// drizzle/schema.ts — additions to entries table
tsv: customType<{ data: string }>({ dataType: () => "tsvector" })("tsv").notNull(),
// In the table-options callback:
tsvGin: index("entries_tsv_gin_idx").using("gin", t.tsv),
```

**Migration ownership** (per ADR-0008 §12 transactional-wrap caveat): for non-empty production tables, the `CREATE INDEX` must run as `CREATE INDEX CONCURRENTLY` in its own no-other-DDL migration file. Pre-M5 the production corpus is empty, so the caveat is moot in practice but the rule still applies for forward-compat. The implementation PR will ship the migration in two files: (a) extension + column + trigger + backfill (transactional), (b) `CREATE INDEX CONCURRENTLY` (own file, non-transactional).

### §2.2 — Tokenization config

**Text search config:** `simple`. Postgres has no built-in Hebrew text-search configuration. `simple` tokenizes by word boundaries without stemming or stopword removal, which is the correct floor for a language without a packaged stemmer — better to under-collapse (`לסגור` and `סגירה` remain distinct tokens) than to apply a wrong-language stemmer.

**Accent normalization:** the pipeline applies (a) `regexp_replace(text, '[֑-ׇ]', '', 'g')` to strip Hebrew niqqud (U+0591..U+05C7 — vowel points + cantillation marks), then (b) `unaccent()` to strip Latin diacritics. Result: `שָׁלוֹם` and `שלום` collapse to the same indexed token, and `cafe` matches `café`. Without the regex strip step, niqqud-vs-no-niqqud is two distinct words in `simple` and source-doc-with-niqqud-vs-user-query-without-niqqud silently fails to match — Postgres's default `unaccent.rules` only covers Latin characters, not Hebrew (see §2.1 Errata 2026-05-21 item 4).

**Query side:** `websearch_to_tsquery('simple', unaccent($1))`. `websearch_to_tsquery` tolerates quotes (`"phrase match"`), `OR`, and `-term` (negation) in user input without throwing on malformed syntax — `plainto_tsquery` would throw on edge characters. Empty / whitespace-only / all-punctuation input is handled at the route layer (see §M5 in §3, below) with a 400 response, not silently routed to the keyword lane.

**Hebrew morphology gap (deferred).** A real Hebrew stemmer (HSpell wrapper, custom Snowball stemmer, or a dictionary-based recall expander) materially improves recall on inflected Hebrew (verb conjugations, noun plurals, possessive suffixes — `הזמנה` ↔ `הזמנות` ↔ `ההזמנות`). Deferred to BACKLOG with a measurable trigger: **if Hebrew recall@5 on the golden eval set drops below 0.6 once the corpus has > 20 real entries with Hebrew bodies, escalate HSpell evaluation.** Without a measurable trigger the BACKLOG entry never fires.

### §2.3 — Pipeline integration (extends ADR-0012)

ADR-0012's pipeline gains a parallel stage **B′** running alongside stage B. Both stages take the same role-derived `sensitivity_allowed[]` predicate computed at the route layer (per §6 of ADR-0012). The stages are independent — failure of either is contained to its lane.

**Stage B (ANN) over-fetch correction.** ADR-0012's stage B returns top-K=20 chunks. After §"Entry-id collapse" below, those 20 chunks may map to as few as 1 distinct entry (worst case) or 20 (best case). To preserve ADR-0012's recall floor through the fusion stage, **stage B's K bumps to 50 chunks pre-collapse**, expected to yield ~20 distinct entries in typical M3 corpora (5-10 chunks per entry). The cosine-distance min-floor `RETRIEVAL_RERANK_MIN_COSINE` (ADR-0012 §C) is applied pre-collapse to drop low-similarity stragglers. The bump from K=20 to K=50 is index-cheap (HNSW returns the extra candidates in roughly the same query cost) and the per-token cost of stage C rerank is unchanged because rerank still receives top-N=5 documents.

**Stage B′ (keyword) SQL:**

```sql
SELECT entries.id, ts_rank_cd(entries.tsv, q) AS keyword_score
FROM entries, websearch_to_tsquery('simple', unaccent($1)) q
WHERE entries.sensitivity = ANY($2::text[])
  AND entries.tsv @@ q
ORDER BY keyword_score DESC
LIMIT 20;
```

- `$1` = the raw query string (post route-layer empty-check, pre-tokenizer).
- `$2` = `sensitivity_allowed[]` — same authorization predicate as ADR-0012 stage B, compiled into the SQL `WHERE`. Never a post-hoc filter; see ADR-0012 §6.
- `ts_rank_cd` is the cover-density variant of `ts_rank`. It partially mitigates the per-entry granularity concern in §6 by normalizing for document length and rewarding term proximity. The keyword lane does not filter by `chunking_policy_version` or `embedding_model`/`embedding_version` — those are chunk-level provenance columns, and the keyword lane operates at entry granularity over `entries.tsv`, which is policy-version-independent.

**Entry-id-collapse-before-fusion.** Stage B returns chunks; stage B′ returns entries. Fusion happens at entry granularity:

1. Collapse stage B chunks → entries: for each `entry_id`, keep the chunk with the lowest ANN rank (== best ANN score). Now both lanes are `entry_id → rank` lists, each up to 20 entries (B post-collapse; B′ by `LIMIT`).
2. RRF-fuse (§2.4) over the two `entry_id → rank` lists.
3. Pick top-20 fused `entry_id`s (may be fewer if the lane union is smaller — "up to 20", not exactly 20).
4. **Rerank input selection** (stage C, owned by ADR-0012): for each of the fused top-20 entries, send one representative chunk to the reranker:
   - If the entry was in the ANN lane, send the best ANN chunk for that entry (the one preserved at step 1).
   - If the entry is keyword-only (came from B′ but not B), send a synthetic representative: the entry's `title` plus the first 500 tokens of its `body` (matches the chunk-size contract from ADR-0009). This is approximated server-side via `js-tiktoken` `o200k_base` (same tokenizer ADR-0009 uses for `chunks.token_count`) for byte-stable representative selection.

This collapse loses no ANN information that ADR-0012 had access to: stage B's K=50 over-fetch gives the collapse room to surface the top-ranked chunk per distinct entry, and stage C's per-entry rerank input is still the best ANN chunk when available. The keyword-only branch's "title + first 500 tokens" is degraded compared to a real chunk match, but only fires for entries that have no ANN hit at all — by definition, the ANN lane offered nothing better.

### §2.4 — RRF fusion

Reciprocal Rank Fusion (Cormack, Clarke, Buettcher 2009 — *Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods*, SIGIR 2009):

```
RRF_score(d) = Σ_lane∈{ann, keyword}  1 / (k + rank_lane(d))
```

- `rank_lane(d)` is 1-indexed position of `d` in the lane's output, or `∞` (term contributes 0) if `d` is not in that lane.
- Default `k = 60` — the value from the original 2009 paper. Worth flagging that the 2009 paper validated `k=60` on TREC-scale lanes (top-1000), not top-20-scale. At K=20 the spread between rank-1 (`1/61 ≈ 0.0164`) and rank-20 (`1/80 ≈ 0.0125`) is ~24%, which is still discriminating but tighter than the paper's setting. Small-K validation: Bruch et al. 2023 (*An Analysis of Fusion Functions for Hybrid Retrieval*, ACM TOIS) tested RRF at smaller K with `k ∈ [40, 80]` and found stable behavior. The eval set is the real gate: the M3 golden set (item 6) recall@5 is what validates the k choice, and the env knob below lets us sweep if needed.
- Env knob `RETRIEVAL_RRF_K` (mirrors ADR-0012's `RETRIEVAL_RERANK_MIN_COSINE`, `RETRIEVAL_BREAKER_*` convention). Default `60`. Range `1..1000` (validated at startup; out-of-range → fail-loud `RangeError`).
- Output: up to 20 entries by RRF score. If the union of the two lanes is smaller than 20 (rare; both lanes returned narrow results), output is the union size.

**Why RRF over CombSUM, weighted-z, or learned-fusion:** ANN cosine-distance and `ts_rank_cd` live on incomparable scales (cosine ∈ [0, 2]; `ts_rank_cd` is unbounded above and depends on document length). Any score-normalizing fusion (CombSUM with min-max, weighted-z) requires per-lane statistics that drift as the corpus grows. RRF is rank-based — no normalization, no per-lane weight tuning, no statistics dependency. It degrades gracefully if one lane is empty (the absent lane contributes 0 to every doc, the present lane's ranking is preserved). The cost: RRF cannot express "the ANN lane is twice as trustworthy as the keyword lane" — that requires per-lane weights. If the eval set surfaces a systematic asymmetry, BACKLOG item "per-lane weighting beyond RRF" handles it.

### §2.5 — Type skeletons (per ADR-with-new-types sub-rule)

**`DegradedReasonCode` enum** (extends ADR-0012's set; see §3 for outcome-matrix mapping):

```typescript
// lib/retrieval.ts — additions to ADR-0012's existing reason-code enum
export const DEGRADED_REASON_CODES = [
  // ADR-0012:
  "synth_unavailable",
  "rerank_unavailable",
  "rerank_and_synth_unavailable",
  "citation_validation_failed",
  // ADR-0013 additions (embed-down → keyword fallback variants):
  "embed_unavailable_keyword_fallback",       // embed fail, rerank+synth ok
  "embed_and_rerank_unavailable_keyword_fallback",  // embed+rerank fail, synth ok
  "embed_and_synth_unavailable_keyword_bare",       // embed+synth fail, rerank ok-or-skipped
  "embed_rerank_synth_unavailable_keyword_bare",    // all three fail; keyword lane survives
  "no_keyword_match_under_embed_outage",       // embed fail AND keyword returned 0 rows
] as const;
export type DegradedReasonCode = (typeof DEGRADED_REASON_CODES)[number];
```

**`RetrievalAuditPayload`** (extends ADR-0012 §E `payload`):

```typescript
// Audit row payload after this ADR.
// ADR-0012 fields that remain unchanged are elided for brevity.
export type RetrievalAuditPayload = {
  // ... ADR-0012 fields (query, role, sensitivity_allowed, latencies_ms, ...)
  embedding_model: string;    // configured embedder's model — recorded even if call failed (see iron rule #9 note)
  embedding_version: string;  // configured embedder's version — recorded even if call failed
  ann_candidate_ids: string[];        // post-collapse entry_ids from ANN lane (replaces ADR-0012's `candidate_ids`)
  keyword_candidate_ids: string[];    // entry_ids from stage B′
  fused_ids: string[];                // post-RRF entry_ids (up to 20)
  rrf_k: number;                      // env-knob value in force at request time
  reranked_ids: string[];             // top-N=5 entry_ids post stage C (unchanged from ADR-0012)
  citation_ids: string[];             // entry_ids cited by synth (unchanged from ADR-0012; subset of reranked_ids)
  keyword_only: boolean;              // derived convenience: true when stage A failed and B′ carried the request
  tokens: {
    embed: number;          // 0 if stage A failed
    keyword: number;        // always 0 — Postgres is local; field exists for shape symmetry with embed/rerank_input/synth_input/synth_output
    rerank_input: number;
    synth_input: number;
    synth_output: number;
  };
  degraded: boolean;
  degraded_reason?: DegradedReasonCode;
};
```

**`EvalRetrieveResult`** (extends ADR-0012 §7):

```typescript
export type EvalRetrieveResult = {
  ann_candidate_ids: string[];       // up to 20 from ANN, post entry-collapse
  keyword_candidate_ids: string[];   // up to 20 from keyword lane
  fused_candidate_ids: string[];     // up to 20 by RRF
  reranked_ids: string[];            // top-N=5 (post rerank stage C)
};
```

ADR-0012's `candidate_ids` field is dropped in favor of the three lane-specific fields. The eval runner (M3 items 6-7) is not yet written, so no breaking-change concern.

---

## §3 — Degraded mode contract (iron rule #12 full closure)

Three independent dependencies — embed (Voyage), rerank (Voyage rerank-2), synth (Claude Sonnet) — guarded by independent circuit breakers per ADR-0012 §3. Keyword lane (Postgres) has no breaker because the project's own database is not a degradable dependency in this model (if Postgres is down, the entire app is down — this ADR scopes degraded-mode to external-service failure).

Eight `(embed × rerank × synth)` outcome combinations. This table is the new source of truth and **supersedes ADR-0012 §3's matrix** for embed-fail rows. ADR-0012's `embed_unavailable` → 503 row is removed.

| embed | rerank | synth | Response shape | `degraded` | `reason_code` |
|-------|--------|-------|----------------|------------|---------------|
| ok    | ok     | ok    | Full ANN+keyword fused → rerank → synth → cited answer | `false` | — |
| ok    | ok     | fail  | ANN+keyword fused → rerank → top-5 chunk snippets + citations, no synthesis | `true`  | `synth_unavailable` |
| ok    | fail   | ok    | ANN+keyword fused → skip rerank → top-5 from fused → synth → answer | `true`  | `rerank_unavailable` |
| ok    | fail   | fail  | ANN+keyword fused → top-5 chunk snippets + citations | `true`  | `rerank_and_synth_unavailable` |
| fail  | ok     | ok    | Keyword-only → rerank → synth → cited answer | `true`  | `embed_unavailable_keyword_fallback` |
| fail  | fail   | ok    | Keyword-only → skip rerank → top-5 from keyword → synth → answer | `true`  | `embed_and_rerank_unavailable_keyword_fallback` |
| fail  | ok     | fail  | Keyword-only → rerank → top-5 chunk snippets + citations | `true`  | `embed_and_synth_unavailable_keyword_bare` |
| fail  | fail   | fail  | Keyword-only → top-5 by ts_rank_cd + citations | `true`  | `embed_rerank_synth_unavailable_keyword_bare` **(implemented in M3 item 2 slice, PR stacked on #158; rows 1-7 deferred to M3 item 3 full slice)** |

Special case: **keyword lane returns zero rows while embed is down** (any of the four `fail × * × *` rows above): respond `{degraded: true, reason_code: "no_keyword_match_under_embed_outage", answer: "", citations: []}`. Explicit "we couldn't find anything" per AGENTS.md retrieval non-negotiable ("If retrieval returns nothing high-confidence, say so explicitly").

**Citation-validation interaction (§5 of ADR-0012).** ADR-0012 §5 mandates a `Sources: [...]` regex retry-once policy on synthesizer output. After this ADR:

- §5 still applies in full for any row where `synth = ok` (rows 1, 3, 5, 6 above) — synth output must contain a valid `Sources:` block or the retry-once fires.
- **§5 retry policy is skipped iff `degraded === true && answer === ""`** (rows 2, 4, 7, 8 above plus the zero-keyword special case) — the answer is empty by construction, there is no `Sources:` block to validate, and the retry would be a pointless no-op. The `citations[]` array in the response body comes from the post-rerank chunk list or the keyword candidates directly, not from synth output.

**Iron-rule-#9 attribution when stage A never runs.** Even when the embedder call failed (rows 5-8) and no query embedding was computed, the audit row records `embedding_model` and `embedding_version` from the *configured* embedder (the one that `getEmbedder()` resolved at request time). Semantics: "this is the embedder that would have run." This preserves shape stability (no null fields in the audit payload) and keeps cross-version analytics queryable: a future "compare retrieval quality across embedder versions" report can still bucket the keyword-fallback requests by configured-embedder, which is the right unit of analysis.

---

## §4 — API + route shape (deltas from ADR-0012 §4)

`POST /api/retrieve` body and response shapes are unchanged from ADR-0012 §4. Three behavioral additions:

1. **Empty-query rejection at the route layer.** Trim + Unicode-normalize the input query; if the result is empty OR contains only punctuation/whitespace after `unaccent`-style normalization, respond `400 Bad Request` with `{error: "query_empty"}`. This prevents `websearch_to_tsquery('simple', '')` from silently returning zero rows under keyword-only degraded mode and surfacing as `no_keyword_match_under_embed_outage`, which would mislead users.
2. **`degraded_reason` enum** extended per §2.5 — clients reading the response need the extended values to render appropriate UI.
3. **Response `degraded` field** is now `true` whenever the keyword fallback fires, even if the user-perceived shape (answer + citations) is the same as the healthy path. The `degraded_reason` discriminates which fallback fired.

---

## §5 — Audit-row additions

See `RetrievalAuditPayload` skeleton in §2.5. Concretely, the audit row written per request gains:

- `ann_candidate_ids: uuid[]` — post-collapse entry_ids from ANN lane (replaces ADR-0012's single `candidate_ids`).
- `keyword_candidate_ids: uuid[]` — entry_ids from stage B′.
- `fused_ids: uuid[]` — post-RRF entry_ids (up to 20).
- `rrf_k: integer` — env-knob value at request time, for retrospective tuning.
- `keyword_only: boolean` — derived convenience flag; true iff `reason_code` starts with `embed_` AND the response was served from B′. Avoids forcing analytics consumers to parse the reason-code enum.
- `tokens.keyword: 0` — Postgres is local; the field exists for symmetry with the other token fields (embed / rerank_input / synth_input / synth_output) so analytics SUM-by-stage aggregations don't need stage-specific null-handling.
- `degraded_reason` enum extended per §2.5.

---

## §6 — Test strategy (iron rule #8)

The keyword lane is pure Postgres SQL — no external SDK boundary. Iron rule #8 ("Tests never call live embedding/Claude APIs") is about external billed services; the project's containerized Postgres (per `docker-compose.yml`) is local infrastructure, the same status as any other in-process module.

**Test layout for the M3 item 4 implementation PR:**

- **Migration tests** assert the trigger fires on `INSERT` and `UPDATE OF (title, tags, body)`, and that updates of unrelated columns (e.g., `last_verified_at`) do not regenerate the `tsv`. Negative-assertion test per `WORKFLOW.md`: an update that *should not* fire the trigger must be distinguishable from one that should.
- **Tokenization tests** assert `unaccent`+`simple` collapses Hebrew niqqud variants (`שָׁלוֹם` ↔ `שלום`) and Latin diacritics (`café` ↔ `cafe`), and preserves Hebrew word boundaries.
- **Keyword-lane SQL tests** assert the sensitivity predicate compiles into the SQL `WHERE`, that `ts_rank_cd` ordering is stable for a fixed corpus, and that `websearch_to_tsquery` handles quoted phrases / OR / minus-terms without throwing.
- **Fusion tests** are unit tests against a pure RRF function — pass two synthetic rank lists, assert the fused score and ordering against the formula by hand. No DB or external service touched.
- **Degraded-mode integration tests** drive each row of the §3 8-combo matrix by mocking the embedder / rerank / synth singletons (per the existing `getEmbedder()`/`getReranker()`/`getSynthesizer()` factory pattern from ADR-0012). Iron rule #8 is satisfied because the mocked clients throw, never call the network.

CI must install the `unaccent` extension in the test database (the migration does this; the test DB is migrated before each suite per the existing M2a test setup).

---

## §7 — Consequences

### Positive

- **Closes iron rule #12** in full. The keyword lane is the durable fallback when the embedder is unreachable, and the §3 matrix covers every embed/rerank/synth combination.
- **ROADMAP M3 items 4 + 8 both unblocked** by the implementation PR that follows this ADR.
- **Rank-fusion is robust to score-scale incompatibility.** RRF requires no per-lane statistics and no normalization.
- **Sensitivity predicate cleanly reused.** Stage B′'s authorization is identical to stage B's; no second source of truth for role → `sensitivity_allowed[]` mapping.
- **`simple` + `unaccent` is the cheapest viable Hebrew baseline.** No stemmer-vendor decision lock-in, no per-language config drift; the upgrade path (HSpell or similar) is gated by a measurable eval metric.
- **Cost shape unchanged from ADR-0012.** Keyword lane costs are local Postgres (already paid); RRF is a pure-CPU operation on rank lists; entry-collapse and rerank-input selection add a handful of milliseconds per request.

### Negative

- **Per-entry granularity in the keyword lane** means a 20K-word entry with a single matching token receives the same rank position as a 500-word entry with the same single match. `ts_rank_cd` partially mitigates via length normalization, but the real metric is the golden eval — if recall@5 suffers, the BACKLOG item "chunk-level tsvector" promotes to active.
- **Trigger-maintained tsv column has a write-amplification cost** on entry insert/update — the trigger reads `title`+`tags`+`body` and recomputes the tsvector once per row write. For the admin-only write path at M3 volumes this is negligible; the impact surfaces at M5+ if a bulk-reingest workflow appears. The migration's larger cost is the one-time backfill on existing rows when this ADR's migration ships.
- **`unaccent` is STABLE, not IMMUTABLE.** Stored values are only as fresh as the `unaccent` rules dictionary at write time. The rules dictionary is static in stock Postgres images; the risk surfaces only if a maintainer manually edits `unaccent.rules`. Not a real risk pre-M5.
- **RRF `k=60` is from a paper validated at TREC-scale lanes**, not K=20. The Bruch et al. 2023 small-K paper validates the general range but not the specific `k=60` choice; the env knob exists precisely so the eval set can drive the final value.
- **Stage B's K=20 → K=50 bump** is a defensive over-fetch for the entry-collapse step. If post-collapse the lane is still systematically narrow (a Priority KB where most queries hit a small number of entries with many chunks each), the K may need to climb further; surface in the eval set, not pre-emptively.
- **Hebrew morphology gap.** Inflected Hebrew (verbs, plurals, possessives) won't collapse under `simple` + `unaccent`. Acknowledged; gated on eval metric per §2.2.
- **The §3 matrix is now 8 rows, not 5.** Implementation complexity (state-machine branches in the route handler) grows accordingly; the type skeleton in §2.5 narrows the enum so the compiler catches missing branches.

### Deferred (BACKLOG)

- **Hebrew morphological stemmer** (HSpell, Snowball-for-Hebrew, or dictionary expansion). Trigger: Hebrew recall@5 < 0.6 on the golden eval set once corpus has > 20 Hebrew entries.
- **Chunk-level tsvector**. Trigger: eval set surfaces per-entry granularity as a real recall failure on long entries.
- **Per-lane weighting beyond symmetric RRF**. Trigger: eval surfaces systematic asymmetry where one lane consistently outranks the other on the golden set.
- **Composite `(sensitivity, tsv)` partial index or partial GIN indexes per sensitivity tier**. Trigger: eval or production profiling shows the full GIN scan is slow under tight sensitivity filtering.
- **IMMUTABLE `unaccent` wrapper** to migrate from trigger-maintained to GENERATED-STORED. Trigger: M5+ profiling shows trigger overhead on bulk re-ingest is real.
- **`CREATE INDEX CONCURRENTLY` re-creation for the GIN index.** M3 implementation (migration 0003) ships plain `CREATE INDEX` because `drizzle-kit migrate` wraps each file in a transaction and the corpus is empty pre-M5 (transactional `CREATE INDEX` is acceptable when no concurrent writes exist). Trigger: before the first production data backfill, drop + re-create the GIN index with `CONCURRENTLY` in a hand-applied DDL step outside the Drizzle migration runner, OR adopt a non-transactional migration mechanism (e.g., `node-pg-migrate` for select files, or a separate raw-`psql` deploy step). Recorded against ADR-0008 §12 transactional-wrap caveat.
- **RRF `k` sweep**. Trigger: golden eval. The env knob is already in place.

---

## §References

- ADR-0005 — log event schema.
- ADR-0008 §12 — Drizzle + migration ownership; HNSW/index CONCURRENTLY caveat applies symmetrically to the new GIN index.
- ADR-0009 — chunking strategy; chunks store offsets, not denormalized text. Confirms §2.1's entry-vs-chunk decision.
- ADR-0010 — admin ingestion chat UI; stub-auth convention reused at the route layer.
- ADR-0011 — repo visibility; orthogonal but constrains demo-data scope.
- ADR-0012 — retrieval pipeline architecture. Direct predecessor; this ADR extends §3, §5, §7, §E.
- `docs/ROADMAP.md` §M3 items 4 + 8.
- `docs/AGENTS.md` retrieval pipeline step 4.
- `prompts/retrieval-agent.md` — prompt v0.1.0; the v0.2.0 bump (ADR-0012 §D) does not need amendment for this ADR.
- Cormack, Clarke, Buettcher (2009). *Reciprocal Rank Fusion outperforms Condorcet and individual Rank Learning Methods.* SIGIR.
- Bruch, Gai, Ingber (2023). *An Analysis of Fusion Functions for Hybrid Retrieval.* ACM TOIS.
- Postgres docs — `unaccent` STABLE volatility; `to_tsvector` IMMUTABLE-with-literal-config; generated-column expression-immutability requirement.
- Postgres docs — `websearch_to_tsquery` syntax; `ts_rank_cd` cover-density ranking.
