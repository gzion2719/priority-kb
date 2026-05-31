# ADR-0025 — Tag management: rename + merge + delete + suggest (M4 #4)

- **Date:** 2026-05-31
- **Status:** Accepted
- **Deciders:** Gal Zilberman + Claude (with independent plan-reviewer subagent)
- **Related:** [ADR-0008](0008-orm-and-migration-ownership.md) (Drizzle-owned schema), [ADR-0009](0009-chunking-strategy.md) §6 (tags prefixed at embed time) + §7 (DELETE+INSERT chunk lifecycle), [ADR-0011](0011-repo-visibility.md) Amendment 2026-05-27 (synthetic-fixture data during dev stage), [ADR-0019](0019-job-queue.md) §D3 (idempotency-key contract) + §D7 (`audit_log.kind` discriminators), [ADR-0021](0021-worker-http-callback-architecture.md) Option Y (worker has no embed surface — PUTs back to Node), [ADR-0023](0023-image-processing-caption-region-contract.md) D5 (`entries.caption` is body-derived, untouched by this ADR)

## Context

[ROADMAP.md](../ROADMAP.md) M4 #4 reads: *"Tag management: rename, merge, suggest from existing entries."* It is the last unstarted M4 item; #1/#2/#3/#5/#6 have all shipped. This ADR records the design of the four operations (rename, merge, delete, suggest) before the implementation PRs land — the M4 #4 work is research-archetype in this session, code lands in three follow-up PRs (see D7 / D14 below).

Six facts constrain the design.

1. **`entries.tags` is a `text[] NOT NULL DEFAULT '{}'` column** on both `entries` and `entries_versions`. No separate `tags` table exists; the catalog is derivable as `SELECT DISTINCT unnest(tags) FROM entries`.

2. **Tags participate in the keyword lane.** Migration 0002's `entries_tsv_refresh` trigger is column-scoped to `(title, tags, body)` and recomputes `entries.tsv` as `to_tsvector('simple', unaccent(regexp_replace(<title|tags|body>, '<niqqud-class>', '', 'g')))`. Any tag write — single-row or bulk — refreshes the GIN-indexed lexeme set for that row synchronously.

3. **Tags are prefixed at embed time.** Per [ADR-0009 §6](0009-chunking-strategy.md), `buildEmbedInput(chunk, entry)` produces `"Title: …\nTags: <comma-separated>\n\n<chunk-body>"`; only the embedding model sees the augmented form. Rerank and Sonnet receive raw chunk content. A tag rename therefore changes the **embedding** of every affected chunk, but does not change the **chunk text** or the rerank/synth inputs.

4. **The `chunks` lifecycle is DELETE+INSERT, not in-place update.** Per [ADR-0009 §7](0009-chunking-strategy.md) and [lib/ingest.ts](../../lib/ingest.ts) `updateEntry`: every entry edit (i) acquires `SELECT ... FOR UPDATE` on the entry row, (ii) appends a new `entries_versions` row, (iii) DELETEs the existing chunks and INSERTs fresh ones with new `embedding_model` / `embedding_version`. There is no path that touches `entries.tags` without going through this lock-version-rechunk pipeline today.

5. **The `audit_log_prompt_hash_required_for_agent` CHECK fires only on `kind LIKE 'agent_%'`**. New non-agent audit kinds (e.g. `tag_rename`) do not need `prompt_hash` and do not require a migration to widen the CHECK.

6. **Under [ADR-0021 Option Y](0021-worker-http-callback-architecture.md), the Python worker has no embed/write surface.** All embedding flows through Node's `PUT /api/ingest/[id]` (`updateEntry`). Any async re-embed strategy must therefore POST back to Node, mirroring the M2b #5 media-ingest pattern — not introduce a Python-side embed primitive.

## Decision

ADR-with-new-types: applies (new `audit_log.kind` discriminators + new HTTP request/response shapes). Type skeleton inline below; full Zod schemas land with the implementation PRs.

```ts
// New audit_log.kind discriminators (no prompt_hash required; non-agent kinds)
type TagAuditKind =
  | "tag_rename"           // payload: { from: string; to: string; affected_entry_ids: string[]; re_embed_job_ids: string[] }
  | "tag_merge"            // payload: { from: string[]; to: string; affected_entry_ids: string[]; re_embed_job_ids: string[] }
  | "tag_delete"           // payload: { tag: string; affected_entry_ids: string[]; re_embed_job_ids: string[] }
  | "tag_management_view"; // payload: { tag_count: number } — read-only dashboard view

// New job-queue handler (lives in the Python worker, dispatches back to Node)
type ReEmbedEntryJob = {
  queue_name: "re_embed_entry";
  payload: { entry_id: string; reason: "tag_rename" | "tag_merge" | "tag_delete"; trigger_audit_id: string };
  idempotency_key: string; // sha256(`re_embed:${entry_id}:${post_op_tags_canonical}`)
};

// Audit payload field re_embed_job_ids carries one id per affected entry.
// Under a retry that hits the D2 ON CONFLICT DO NOTHING branch, the id may
// be a pre-existing queued/in-flight job's id (the existing dedupe wins).

// New admin endpoint shapes
//   entry_count is computed over the caller-role-visible entries only — see
//   D5 sensitivity-filter note. The count is intentionally role-relative.
type GetAdminTagsResponse = { tags: Array<{ name: string; entry_count: number }> };
type PostAdminTagsRenameRequest = { from: string; to: string };
type PostAdminTagsMergeRequest = { from: string[]; to: string };
type PostAdminTagsDeleteRequest = { tag: string };
```

### D1 — Rename mechanism: loop N `updateEntry`-equivalent calls, NOT bulk SQL

**Decision: rename = a server-side loop over affected entries, each going through the existing `lib/ingest.ts::updateEntry` lock-version-rechunk path with the new tags array.** Not `UPDATE entries SET tags = array_replace(tags, $1, $2) WHERE $1 = ANY(tags)`.

Plan-CR (Step 7b) reframed this decision. The initial "in-place vs versioned" framing was wrong: a bulk SQL `UPDATE` on `entries.tags` (a) bypasses the per-row `SELECT ... FOR UPDATE` lock (races with concurrent `updateEntry` on the same rows), (b) does NOT append `entries_versions` rows (so the M4 #3 history viewer sees a body-tags drift between two snapshots that didn't appear to change anything), (c) does NOT DELETE+INSERT chunks (so `chunks.embedding` is stale relative to `buildEmbedInput`'s tag-prefixed string — fact #3 above), and (d) violates fact #4's "no path touches `entries.tags` without the lock-version-rechunk pipeline" invariant.

Looping N `updateEntry` calls — one per affected entry — preserves all four invariants for free. Each affected entry gets a real `entries_versions` row, a real chunk replacement, a real audit row. The cost is N transactions instead of one bulk statement; at M4 corpus scale (tens to low-hundreds of affected entries per typical rename) this is bounded.

The bulk variant is rejected. If a future scale concern surfaces (thousands of affected entries per rename), the right reply is a `bulkUpdateEntryTags(rename)` primitive that internally still loops the lock-version-rechunk pipeline per row — never a single SQL `UPDATE`.

### D2 — Re-embed posture: async via M2b job queue, POST back to Node

**Decision: each `updateEntry` call inside the D1 loop is in the *synchronous* request path** — the lock, the new `entries_versions` row, and the tsv recompute all happen before the HTTP response. The **chunk re-embed** is decoupled: the loop enqueues one `re_embed_entry` job per affected entry (one row per affected entry in the existing `jobs` table from [ADR-0019](0019-job-queue.md)), and a Python worker handler POSTs back to Node `PUT /api/ingest/[id]` with the entry's current body, triggering the standard re-chunk + re-embed inside `updateEntry`. This mirrors the M2b #5 media-ingest worker→Node round-trip; no new Python embed surface is introduced (fact #6).

**Idempotency key shape** (per [ADR-0019 §D3](0019-job-queue.md)): `sha256("re_embed:" + entry_id + ":" + canonical(post_op_tags))`, where `canonical(tags)` is the post-rename tag set sorted lexically and joined with `\x1f`. Same entry + same post-op tag set → same key → second enqueue is a no-op (`INSERT ... ON CONFLICT DO NOTHING`). A rename followed by a merge that produces the same final tag set re-enqueues only if a worker already drained the first job.

**Tx posture for the enqueue:** the `enqueueJob` call lives **inside** the same DB tx as the `updateEntry` writes (per [ADR-0019 §D](0019-job-queue.md) tx-handle pattern). If the enqueue fails after `updateEntry` commits, the re-embed never fires and `chunks.embedding` drifts permanently relative to the new tag prefix. Inside the tx, either both commit or neither does. The N entries are not atomic with each other (N separate tx) — D3 below addresses cross-row atomicity for merge.

**Degraded-mode bound (iron rule #12):** if Voyage is down, queued `re_embed_entry` jobs sit in `state='queued'` until Voyage recovers; per [ADR-0019 §D12](0019-job-queue.md) `failed` (not `dead`) rows are not pruned, so no work is lost. During the outage window, the keyword lane is fresh (tsv updates synchronously per fact #2) and the embedding lane is stale relative to the new tag prefix — an **asymmetric-lane window** that is the accepted cost of D2. The admin dashboard surfaces queue depth (m5 below); an operator-facing alert fires when `count(*) WHERE queue_name='re_embed_entry' AND state='queued' AND created_at < now() - interval '24 hours' > 0`. The 24h threshold is the soft TTL; persistent backlog escalates to manual triage. No automatic cancellation — drift is preferable to silently dropping the re-embed.

### D3 — Merge: N `updateEntry`-equivalent calls, one outer tx, dedupe-on-collision

**Decision: a merge of `[from_1, from_2, ...] → to` is the same loop primitive as D1, just with `array_replace` applied to multiple source tags + a post-replace dedupe.** For each affected entry the loop calls the `updateEntry`-equivalent path (lock → append `entries_versions` → DELETE+INSERT chunks → audit row), passing the new tags array. The single difference from D1 is that all N per-entry calls are bound to **one outer transaction via the [ADR-0019 §D](0019-job-queue.md) tx-handle pattern** — `db.transaction(async (tx) => { for (const id of affected) await updateEntryWithTx(tx, id, …) })` — so the merge is observable as a single atomic event rather than N separate edits.

Bypassing the `updateEntry` pipeline with raw `UPDATE entries SET tags = …` SQL would re-introduce the exact four-invariant violation D1 rules out (no per-row lock, no `entries_versions` row, no chunk re-derive, no audit row). D3's atomicity requirement (cross-row) does not require giving up D1's per-row invariants; the tx-handle pattern delivers both.

The re-embed enqueue for each affected entry is inside the same outer tx as its `updateEntry` call (per D2's tx posture). One merge = N affected entries = N atomic `updateEntry`+enqueue pairs, all bound to one outer BEGIN.

**Collision dedupe (Q4 answer):** when entry E has tags `["foo", "bar"]` and the merge is `foo → bar`, the result is `["bar"]` — not `["bar", "bar"]`. Dedupe runs in the loop *before* the tags array is handed to `updateEntry`. The tsv trigger sees a deduplicated array, so the keyword lane sees `"bar"` once.

**Lock-ordering note for concurrency:** the merge loop acquires per-row locks in `ORDER BY id` (the loop iterates the affected set in id order) to prevent a deadlock with concurrent `updateEntry` calls on the same row set. Each iteration's lock is held until the outer tx commits.

### D4 — New `audit_log.kind` discriminators

Four new kinds, none of which match `kind LIKE 'agent_%'` so the existing CHECK constraint does not fire (fact #5):

- `tag_rename` — payload: `{ from: string; to: string; affected_entry_ids: string[]; re_embed_job_ids: string[] }`
- `tag_merge` — payload: `{ from: string[]; to: string; affected_entry_ids: string[]; re_embed_job_ids: string[] }`
- `tag_delete` — payload: `{ tag: string; affected_entry_ids: string[]; re_embed_job_ids: string[] }`
- `tag_management_view` — payload: `{ tag_count: number }` — emitted on every load of the admin dashboard, mirrors the M4 #5 `stale_entries_view` discriminator for parity.

One audit row per operation, written in the same tx as the entry updates. The per-entry `entries_versions` rows from D1's loop are the per-row forensic surface; the tag-operation audit row is the *event-level* forensic surface — "this rename happened at this timestamp, touched these N entries, enqueued these N re-embed jobs."

**`affected_entry_ids` cardinality cap:** if a rename affects more than 1,000 entries, the payload stores the first 1,000 + a `truncated_count` field — keeps the audit row bounded in size. At M4 corpus scale this cap is theoretical, but pinning it now means a future runaway operation cannot blow up the audit table.

### D5 — Suggestion mechanism: endpoint + agent tool, NOT prompt injection

**Decision: two surfaces, one shared backend.**

- **Admin UI surface:** `GET /api/admin/tags?prefix=<string>` returns `{ tags: Array<{ name, entry_count }> }`, sorted by `entry_count DESC` then alphabetical. The optional `prefix` parameter does an SQL `WHERE tag ILIKE $1 || '%'` on the unnested catalog (Q2). No prefix → full catalog. Gated by `withAdmin` from [lib/auth.ts](../../lib/auth.ts); rejects `user` role with 403. The `ILIKE` (case-insensitive) match is intentionally inconsistent with D10's case-sensitive byte-identity for tags — case-variants are the most common merge target the admin is searching for ("`Priority` vs `priority` vs `PRIORITY` — which is the canonical one?"), so suggest-time prefix matching surfaces all three as merge candidates from a single typed prefix. The actual rename/merge operations remain case-sensitive per D10.
- **Ingestion Agent surface:** new tool `list_tags()` on the agent's tool surface (see [docs/AGENTS.md](../AGENTS.md) for the existing tool pattern). Tool implementation calls the same backend; tool response is the same JSON shape minus `last_used_at` (the agent doesn't need it).

**Why not prompt injection of the tag list?** Plan-CR (Step 7b B3) corrected the framing. Injecting per-session content into the agent's system prompt does not change the **prompt bytes** or **the `RETRIEVAL_AGENT_PROMPT_HASH` constant** ([lib/prompts.ts](../../lib/prompts.ts)) — so iron rule #10's "every agent response carries a `prompt_hash`" is technically satisfied. But the recorded `prompt_hash` would no longer reproduce the model's behavior on a replay: same hash, different effective context, different completions. The tool path closes this gap: tool calls are recorded in `audit_log.payload` as part of the agent turn that called them (per the existing `agent_ingest` / `agent_retrieval` patterns), so the tool's response is part of the replay record — `prompt_hash` + tool-call log reproduces the run.

**Causally dependent ordering (M7 from plan-CR):** the suggest leg ships **last** of the three implementation PRs (D14). The suggestion endpoint reads the current tags catalog; if rename and merge haven't shipped yet, the catalog still contains typos the admin is trying to fix, and the suggester will autocomplete the typo back into new entries. The dependency is causal, not just ordering — the suggest leg is value-negative until rename + merge are in production.

**Sensitivity filter on the tag list (M8 from plan-CR, iron rule #6):** the `list_tags()` backend filters the catalog by `entries.sensitivity = ANY(sensitivityAllowedForRole(role))` from [lib/auth.ts](../../lib/auth.ts) — otherwise listing tag names leaks the existence of tags that exist *only* on `restricted` entries to a `user`-role caller. Admin role sees everything; user role sees tags present on at least one `public` or `internal` entry. The admin UI surface uses admin role, so the filter is a no-op there; the agent tool inherits the calling agent's role context.

**`entry_count` is computed over the same filtered set, making the count role-relative by design.** A tag present on 10 `internal` + 50 `restricted` entries surfaces as `entry_count: 10` to a user-role caller and `entry_count: 60` to an admin-role caller. This is the intentional shape — iron rule #6 forbids leaking the existence of restricted content, so the count delta between roles must not be observable to the lower-privilege caller (and is not, since a user-role caller never sees the admin-role count). The implementer must NOT add a "total" field that exposes the unfiltered count.

### D6 — Dashboard surface: `/admin/tags`

New admin route under `app/admin/tags/page.tsx` (Server Component, `withAdmin` HOF). Three sections:

1. **Tag list with counts.** Default ordering by `entry_count DESC` then alphabetical; optional `?prefix=` query param uses the D5 endpoint. Per-row affordances: "Rename", "Merge into…", "Delete" (D8 below).
2. **Active operations.** Read of `jobs` table filtered to `queue_name = 're_embed_entry' AND state IN ('queued', 'in_progress')` grouped by `payload.trigger_audit_id` — shows "Rename `foo → bar`: 23 of 47 entries re-embedded (24 pending)" per recent operation. m5 from plan-CR; surfaces the asymmetric-lane window from D2 so the admin can see consistency state.
3. **Audit trail.** Last 50 `audit_log` rows with `kind IN ('tag_rename', 'tag_merge', 'tag_delete')`, newest first. Click-through to the per-row payload.

Each load of the page emits a `tag_management_view` audit row per D4. Read-only sections need no concurrency control; the action affordances POST to the corresponding D5/D8 endpoints, each of which takes its own tx-bounded lock.

### D7 — Implementation split: ADR → 3 follow-up PRs, sequenced

ADR ships first (this PR). The four operations split into three implementation PRs, in order:

1. **PR-A: Rename + Delete + audit trail + minimal dashboard read + `re_embed_entry` worker handler.** Rename (D1) and Delete (D8) share the loop-of-`updateEntry`-calls primitive; ship them together so the `re_embed_entry` Python worker handler is authored once. Includes the read-only audit-trail section of D6.
2. **PR-B: Merge + lock-ordering + the dashboard's "Active operations" section.** Merge (D3) is a strict superset of rename's mechanics (multi-row outer tx via tx-handle + dedupe + lock-ordering); cleaner as its own slice. **Reuses PR-A's `re_embed_entry` worker handler unchanged.** Also lands the in-flight queue-depth section of D6, which becomes meaningful once merge can enqueue 100+ jobs at once.
3. **PR-C: Suggest endpoint + Ingestion Agent tool.** Suggest (D5) is causally dependent on PR-A and PR-B being in production (see D5's last paragraph). Includes both the `GET /api/admin/tags` endpoint and the `list_tags()` tool on the Ingestion Agent.

Each PR has its own Step 7 + Step 7b cycle and ships with its own ROADMAP-line update. M4 #4 flips to `[x]` after PR-C lands.

### D8 — Delete operation (M1 from plan-CR)

**Decision: delete is its own operation, not `merge(T, null)`.** Same lock-version-rechunk loop primitive as D1 (just `array_remove(tags, target)` instead of `array_replace`), same tx-wrapped re-embed enqueue, new `tag_delete` audit kind from D4. Ships with PR-A (D7).

The `merge(T, null)` overload was considered and rejected: nullable-tag semantics complicate the merge endpoint's request validation (`to` becomes `string | null`) and conflate two operations with different audit shapes ("this tag was renamed to that one" vs "this tag was removed everywhere"). Two endpoints, two audit kinds, two clean shapes.

### D9 — Tag normalization + validation (M2 from plan-CR)

**Decision: validation rules enforced at the `updateEntry` boundary and at the `POST /api/admin/tags/{rename,merge,delete}` boundary — not retroactively migrated.**

- **Max length:** 64 characters per tag (NFC code-point count, not byte count). Rejected at validation with HTTP 400.
- **Charset:** any Unicode code-point except: ASCII control chars (`U+0000`–`U+001F`, `U+007F`), the Hebrew niqqud range (`U+0591`–`U+05BD`, `U+05BF`, `U+05C1`–`U+05C2`, `U+05C4`–`U+05C5`, `U+05C7` — same non-contiguous class as migration 0002's stripper), and any of `, ;`. The `,;` ban is keyword-lane-driven: `to_tsvector('simple', …)` (fact #2) treats `,` and `;` as token separators, so a tag `"a,b"` would tokenize as two lexemes `{a, b}` in the GIN index — breaking single-tag identity in the keyword lane (a search for `"a,b"` would hit any entry tagged `a` OR `b`, not just entries tagged `"a,b"`). The embed-time prefix from ADR-0009 §6 is rendered as a comma-separated string; an interior `,` in a tag value would visually collide with the renderer's separator, but the embedder sees raw text and would not mis-tokenize — the keyword lane is the real reason.
- **Case-sensitivity:** tags are case-sensitive at the byte level (D10 below). `Priority`, `priority`, and `PRIORITY` are three distinct tags. The admin dashboard surfaces case-variants of "looks-like-same-tag" as a suggested merge target.
- **Whitespace:** leading/trailing whitespace trimmed (NFC normalization runs first, then `String.prototype.trim`). Interior whitespace collapsed to single ASCII space. Empty result after trim is rejected.
- **NFC normalization:** all tag inputs pass through `String.prototype.normalize("NFC")` at the validation boundary. Closes the Hebrew composed-vs-decomposed equality trap (D10 below).
- **Empty rejection:** empty string after normalization is HTTP 400.

Existing tags written before this ADR are NOT retroactively migrated to the new validation rules. A one-shot data-quality pass (script in `scripts/`) can be run if the rules surface real bad data; not bundled into this ADR's implementation PRs. Validation applies prospectively at every write surface.

### D10 — Hebrew tag identity: byte-equality, with tsv-lane asymmetry called out

**Decision: tag identity is byte-equality (after D9 normalization) — `entries.tags` is a `text[]` and Postgres `=` on text is byte-comparison.** This is the existing semantics; D10 just makes it explicit.

The asymmetry called out by plan-CR M3: the tsv trigger (fact #2) strips Hebrew niqqud via the regex class in migration 0002, so `עדיפות` and `עְדִיפוּת` are **byte-distinct** (D10's identity) but **tsv-equivalent** (keyword-lane match). After D9 strips niqqud from the input at validation time, the byte-distinct case no longer arises through the admin flow — niqqud-bearing tags are rejected. Tags written before D9's rule (or via a bypassed path) keep the asymmetry: byte-distinct in `entries.tags`, tsv-equivalent in the keyword lane.

The embedding lane sees the raw byte form via `buildEmbedInput` (ADR-0009 §6) — so embedding identity matches D10's byte-equality, not tsv's normalized form. Embedding and tsv lanes disagree on identity for the (now-rejected, prospectively impossible) niqqud-bearing tag case. Documented here so a future reader does not re-derive the contradiction.

### D11 — M4 #3 revert interaction: snapshot tags restored as-is

**Decision: revert (M4 #3) restores `entries.tags` from the snapshot as-is. A resurrected dead tag re-appears in the catalog. No rename map is applied during revert.**

The alternative (revert applies the current rename map) was considered and rejected: revert is the *historical replay* primitive ("show me what this entry looked like on date X"); rewriting the snapshot to match today's taxonomy makes revert lie about history. The alternative (revert is blocked when snapshot tags don't exist in the current catalog) was also rejected: it makes revert a brittle operation that fails based on unrelated taxonomy changes, defeating its forensic purpose.

The accepted consequence: after a rename `foo → bar`, reverting an entry to a pre-rename version resurrects `foo` on that one entry. The catalog now contains both `foo` (one entry) and `bar` (the rest). The admin's recovery path is either (a) edit the reverted entry to update the tag, or (b) re-run the rename — the rename is idempotent on entries that already have `bar`, since `array_replace([bar], foo, bar)` leaves `[bar]` unchanged.

### D12 — `entries_versions.tags` snapshots stay frozen

**Decision: `entries_versions` is append-only and is not rewritten on tag rename/merge/delete.** This is the existing invariant ([ADR-0009 §7](0009-chunking-strategy.md) implies it; codified explicitly here for the tag case).

The accepted consequence (called out by plan-CR M6): the M4 #3 history viewer will sometimes show a "tag changed: foo → bar" diff between v_n (pre-rename) and v_n+1 (post-rename), even though the admin's edit at v_n+1 didn't touch tags — the difference came from the global rename. The viewer's diff is honest about what the snapshots contain; it just doesn't have context about *why* the tags differ. The dashboard's tag audit trail (D6 section 3) is the cross-reference: a tag diff between two versions whose `created_at` brackets a `tag_rename` audit row is the explained case.

### D13 — Duplicate HTTP retries: observable retry, no data drift (m6 from plan-CR)

**Decision: the rename/merge/delete endpoints have no data-drift on duplicate calls, but each call is observable in the audit trail.** A second `POST /api/admin/tags/rename {from: "foo", to: "bar"}` after the first one succeeded does:

- Tag-array level: `array_replace(["bar"], "foo", "bar")` is a no-op per entry. The loop completes with zero `entries_versions` rows written and zero `re_embed_entry` jobs enqueued (the loop only acts on rows where `from = ANY(tags)`; after the first rename, that set is empty).
- Audit level: a `tag_rename` row is still written, with `affected_entry_ids: []`. This makes the duplicate observable in the audit trail and distinguishes "rename ran on zero entries because nothing matched" from "rename never ran".
- Re-embed enqueue level: zero jobs because zero affected entries. The D2 idempotency key would have made it a no-op anyway.

The "observable retry, no data drift" framing is intentional — true HTTP-level idempotency (second call returns the first call's response without writing anything) would hide the retry from the audit trail, which is a forensic regression. The zero-affected-entries audit row is the right shape.

If the admin wants to re-trigger re-embedding without a real rename (operator recovery scenario), the path is a dedicated "rebuild embeddings for entries with tag X" maintenance endpoint, not the rename endpoint. Out of scope for M4 #4; queued in BACKLOG if a real need surfaces.

### D14 — Out of scope for this ADR

The following are explicitly NOT decided here. Each follows the Deferred-decision-audit shape (alternatives + chosen + 1-line rationale):

- **Bulk tag-list import/export** (CSV upload of "old → new" rename pairs). Alternatives: (a) bundle into PR-A; (b) defer to BACKLOG; (c) reject permanently. **Chosen: (b) BACKLOG** — no current operator need; one-at-a-time renames cover the foreseeable taxonomy churn.
- **Auto-suggest tag for a *new* entry based on its body content** (NER-style "this entry looks like it should be tagged `pricing`"). Alternatives: (a) ship in PR-C alongside the existing-tag suggester; (b) defer to a future ADR; (c) reject. **Chosen: (b)** — distinct from D5's "list existing tags"; requires either embeddings-over-tags or a Claude-assisted classification pass + a new iron-rule-#10 prompt seal. Out of M4 #4 scope.
- **Tag taxonomies / parent-child / aliases.** Alternatives: (a) extend D5 to hierarchical tags now; (b) defer to a future ADR; (c) reject permanently. **Chosen: (b)** — D5 ships flat tags; hierarchy is a structural change to `entries.tags` itself, warrants its own ADR if/when it becomes a real need.
- **Migrating existing tags through D9's validation rules.** Alternatives: (a) bundle a one-shot migration into PR-A; (b) ship a `scripts/audit-tag-validity.ts` standalone script that surfaces violations for manual cleanup; (c) leave existing tags as-is, enforce D9 only on new writes. **Chosen: (c) + a BACKLOG entry for (b) if real bad data surfaces** — retroactive migration risks rewriting tags the admin actively chose; surfacing violations is cheaper than fixing them silently.
- **`entries.caption` interaction.** Caption is body-derived per [ADR-0023 D5](0023-image-processing-caption-region-contract.md); a tag rename does NOT trigger caption re-derivation. Confirmed here so the implementer doesn't wonder.

## Consequences

- **No schema migration.** All four operations use existing tables (`entries`, `entries_versions`, `chunks`, `jobs`, `audit_log`). No new columns, no widened CHECK constraints.
- **New code surfaces:** one Python worker handler (`re_embed_entry` queue), three Node admin endpoints (rename, merge, delete), one Node admin endpoint (suggest), one Ingestion Agent tool (`list_tags()`), one admin route (`/admin/tags`). All gated by `withAdmin` (writes) or sensitivity-filtered (reads). Implementation lands across PR-A / PR-B / PR-C per D7.
- **Iron-rule footprint:**
  - **#2 (writes via Ingestion Agent):** tag operations are admin-direct writes, same exception class as M4 #2/#3/#5 admin surfaces. The rule is interpreted as "admin-initiated content writes" — taxonomy mutation is a metadata operation parallel to the editor / revert / dashboard surfaces.
  - **#6 (sensitivity tier propagation):** D5's sensitivity filter on the tag list closes the existence-leak side channel. Tag operations themselves do not change `entries.sensitivity`; the existing composite-FK from chunks to entries cascades sensitivity unchanged through re-embed.
  - **#8 (no live API in tests):** D2's `re_embed_entry` handler uses the same `getEmbedder()` stub-by-default factory as M2a — no new live-API surface.
  - **#9 (embedding_model + version per chunk):** preserved by re-using `updateEntry`'s existing DELETE+INSERT pipeline — every re-embedded chunk lands with the current embedder's model + version.
  - **#10 (prompt hash per agent response):** D5's tool path preserves the seal — `RETRIEVAL_AGENT_PROMPT_HASH` is unchanged, tool-call response is recorded in `audit_log.payload` for replay.
  - **#12 (degraded mode):** D2's asymmetric-lane window is the explicit cost — keyword lane stays fresh, embedding lane drifts during a Voyage outage. The 24-hour queue-depth alert is the operator escalation path; no automatic cancellation.
- **Plan-CR coverage (Step 7b on this ADR's plan):** all 3 BLOCKING + 8 MAJOR + 6 MINOR + 6 QUESTIONS from the unbiased plan review are folded into D1-D14. The Amplified rule fires for the implementation PRs — each PR-A/-B/-C will run its own Step 7b on the implemented code.
- **Reversibility:** every decision in D1-D14 is reversible at the cost of a follow-up ADR. The D7 implementation split is the riskiest reversibility commitment — once PR-A ships the rename/delete primitive, changing D1 from "loop N updateEntry" to "bulk SQL" is a partial rewrite of an already-deployed code path.
