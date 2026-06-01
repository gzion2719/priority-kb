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

---

## Amendment 2026-05-31 — PR-A reconciliation: sync `updateEntry`, async deferred

The PR-A implementation session surfaced a D1↔D2 contradiction that was not caught during the original ADR's Step 7b passes. This amendment resolves it ahead of PR-A code, plus folds the PR-A plan-CR's 3 BLOCKING + 6 MAJOR + 5 MINOR + 6 QUESTIONS findings into the design text so the implementation has a single authoritative source.

### A1 — The D1/D2 contradiction

**D1 said:** "Each affected entry gets a real `entries_versions` row, a **real chunk replacement**, a real audit row." (Implies the sync loop calls full `updateEntry`, which DELETEs + INSERTs chunks with fresh embeddings.)

**D2 said:** "the lock, the new `entries_versions` row, and the tsv recompute all happen before the HTTP response. The **chunk re-embed is decoupled**: the loop enqueues one `re_embed_entry` job per affected entry, and a Python worker handler POSTs back to Node `PUT /api/ingest/[id]` ... triggering the standard re-chunk + re-embed inside `updateEntry`."

These are contradictory. If both fire, every affected entry gets TWO `entries_versions` rows per rename — one from the sync loop, one from the worker's PUT. If only the sync loop fires, D2's async story is dead. If only the worker fires, D1's "real chunk replacement happens in the loop" is wrong.

### A2 — Resolution: sync full `updateEntry`, async deferred

**Decision: the sync loop calls full `updateEntry` per affected entry inline (lock + entries_versions + chunk DELETE+INSERT + re-embed + audit). The `re_embed_entry` worker handler is dropped from PR-A scope. D2's async posture moves to BACKLOG, gated on real corpus scale where a single rename exceeds the synchronous-loop tolerance (target: ~50 entries per rename at current Voyage latency budgets).**

This is the simplest reconciliation. It accepts N synchronous Voyage embedding calls per rename — at M4 scale (tens of affected entries per typical rename, target latency budget ~30s p95), the cost is bounded and observable as request latency. The asymmetric-lane window that D2's async design accepted no longer exists; keyword lane and embedding lane stay synchronously consistent.

**Sub-decisions that fall out of A2:**

- **D1 prose stays as written.** "Real chunk replacement, real entries_versions row, real audit row" — all happen synchronously inside the per-entry `updateEntry` call.
- **D2 is retired in its current form.** Its "async via M2b job queue" sentence, its idempotency-key shape, its degraded-mode TTL, its tx-posture invariant — all moot under A2. The `re_embed_entry` queue is never enqueued.
- **D3 (merge) keeps the outer-tx posture** but the inner work is N synchronous `updateEntry` calls (each self-transacted, nested as SAVEPOINTs under the merge's outer tx). The cross-entry atomicity guarantee that D3 names is preserved.
- **D4 payload shape changes (A3 below).**
- **D7 PR-A scope shrinks** — drops `re_embed_entry` worker handler; PR-B is unchanged (still merge + lock-ordering + dashboard "Active operations" section, now empty since no jobs are enqueued — the section retires); PR-C is unchanged.
- **Iron-rule #12 footprint changes.** The "asymmetric-lane window" / "24-hour queue-depth alert" framing in the Consequences section is retired. The new degraded-mode footprint: a Voyage outage during a rename causes the per-entry `updateEntry` call to throw mid-loop; the rename returns a partial-failure response. The retry-loop tolerance comes from D13's "observable retry, no data drift" — admin retries the same rename, the affected-set query re-finds entries not yet renamed, the second loop completes them. M4-scale ranges (tens of entries) make this acceptable; M5 production scale revisits.

### A3 — D4 payload shape — final form

The plan-CR's BLOCKING B2 caught that the original D4 payload shape (`re_embed_job_ids: string[]`) drifts under A2 (no jobs are enqueued). The replacement shape, locked here, is:

```ts
// audit_log payload for kind = "tag_rename"
type TagRenameAuditPayload = {
  from: string;
  to: string;
  affected_entry_ids: string[];      // first N capped at 1000 per the existing D4 cap rule
  affected_entry_count: number;       // unbounded — the true count, even when ids is capped
  truncated_count?: number;           // present iff affected_entry_count > 1000 (cap fired)
  partial_failure?: true;             // present iff the loop threw mid-execution
  partial_failure_reason?: string;    // present iff partial_failure; redacted error class
};

// audit_log payload for kind = "tag_delete"
type TagDeleteAuditPayload = {
  tag: string;
  affected_entry_ids: string[];
  affected_entry_count: number;
  truncated_count?: number;
  partial_failure?: true;
  partial_failure_reason?: string;
};

// audit_log payload for kind = "tag_management_view"
type TagManagementViewAuditPayload = {
  tag_count: number;                  // 0 on the unauthorized branch (mirrors stale_entries_view shape)
  outcome: "served" | "unauthorized";
  role: "admin" | "user" | null;      // M4 #5 parity — stale_entries_view carries the same field; null on unauthorized
};
```

**`re_embed_job_ids` is dropped.** Under A2 there are no jobs.

**`affected_entry_ids` stays as an array, capped at 1000 per the existing D4 cap rule.** The cap is unchanged.

**Cross-link to per-entry `ingest_update` rows** (plan-CR Q5 — the operator querying "what changed when?" sees N `ingest_update` + 1 `tag_rename` row per rename): the per-entry `updateEntry` calls inside `renameTag`/`deleteTag` thread `audit_extra: { triggered_by_audit_id: <tag_rename_or_tag_delete_row_id> }` through the existing `audit_extra` channel ([lib/ingest.ts](../../lib/ingest.ts) `updateEntry`). The `tag_rename` row is written FIRST (with empty `affected_entry_ids: []`), its `id` captured, then the per-entry loop runs, then the `tag_rename` row is UPDATEd at the end with the final `affected_entry_ids` array. This is the ONE place this ADR endorses an `UPDATE audit_log` write — `audit_log` is otherwise append-only.

The "write first, update at end" shape (alternative was "write at end only" or "write at start with empty array, never update") is chosen because:
- Capturing the `id` for `triggered_by_audit_id` threading requires the row to exist before the per-entry loop runs.
- A loop that throws mid-execution would otherwise lose the audit row entirely; the start-write guarantees the operation is observable even on partial failure.
- The final UPDATE is bounded (one row per operation) and `audit_log` does not currently have a `BEFORE UPDATE` trigger that would block it.

### A4 — Validation policy + audit-row distinction (plan-CR BLOCKING B3)

The plan-CR caught that the route's "Returns 400 on validation failure" rule conflicts with D13's "observable retry, no data drift" mandate. This amendment distinguishes the three cases:

1. **Zod malformed request body** (caller sent invalid JSON, wrong field types, missing fields) → **HTTP 400, no audit row.** This is a request-shape error, not a semantic operation. The caller has not requested anything meaningful to audit.

2. **D9 tag-validation failure at the lib boundary** (`to` contains niqqud, exceeds 64 chars, includes `,;`, is empty after NFC normalization) → **HTTP 400, no audit row.** The operation was invalid; the request never reached the data layer.

3. **No-op rename / `to===from` / `from` absent from catalog / `tag` absent from catalog** → **HTTP 200, audit row written with empty `affected_entry_ids: []` + `affected_entry_count: 0`.** This is D13's "observable retry, no data drift" case — the operation ran, the loop iterated zero entries, the audit row attests to the fact.

The distinction is "did the operation execute?" (write the audit row) vs "was the request shaped correctly?" (no audit row on shape failure). D13's framing in the original ADR is sharpened by this amendment.

### A5 — `from` validation: catalog pre-fill mechanical floor (plan-CR M1)

The original D9 said tag validation rules apply to all writes; the plan-CR's Q3 surfaced that strict D9 validation on `from` would block legitimate cleanup renames of pre-D9 tags (the catalog may contain Hebrew-niqqud-bearing tags written before D9 was enforced).

**Decision: `from` is NOT validated against D9; it accepts any non-empty string ≤64 chars. `to` is validated against D9 in full.** The mechanical floor that closes the manual-typing-typo failure mode: **the rename form on `/admin/tags` MUST pre-fill `from` from a catalog-row click — there is no free-text `from` input.** The catalog row's tag value is the exact byte sequence stored in `entries.tags`, so the pre-filled `from` matches the entry's tag bytes exactly. An admin who types `from` manually is using a bypass path (raw HTTP via curl); for the form-driven path the pre-fill closes the surface.

The catalog row-click pre-fill is implemented by passing the clicked tag's value through a form field that is read-only at the route boundary (server validates that `from` was not edited by checking it against the catalog before running `renameTag`). Implementation detail: hidden input + double-submit check, or session-bound CSRF-style token. PR-A picks the simpler "hidden input + server-side catalog membership check" — implementation lands in `app/admin/tags/RenameForm.tsx`.

### A6 — Lock-ordering for concurrent rename (plan-CR M5)

The plan-CR caught that D3 (merge) explicitly addresses lock-ordering for cross-row atomicity, but D1 (rename) does not address concurrent-rename-on-overlapping-tag-sets.

**Decision: PR-A accepts deadlock-as-retry. Concurrent `rename foo→bar` + `rename foo→baz` may interleave (or one may deadlock and Postgres-rollback); the route returns 500/503 on deadlock and the caller retries.** The mitigation cost (lock-ordering by entry id across renames, advisory lock per `from`-tag) is disproportionate at M4 admin scale where two simultaneous tag-management operations from different admins is rare. M5 hosting revisits if real concurrency surfaces. This is an explicit deferred decision per the Deferred-decision-audit sub-rule.

### A7 — Q1-Q5 from the plan-CR — answers

- **Q1 (`to===from`):** HTTP 200, audit row with empty `affected_entry_ids`. The route does NOT short-circuit before calling `renameTag` — the lib function is the no-op-detection boundary.
- **Q2 (`tag` not in catalog for delete):** HTTP 200, audit row with empty `affected_entry_ids`.
- **Q3 (`affected_entry_ids` shape):** stays as an array per A3 above. The cap is 1000 (unchanged).
- **Q4 (concurrent rename pair, contradictory audit rows):** each rename's audit row reflects what THAT call actually changed. If admin1's `rename foo→bar` updates entries 1-50 and admin2's `rename foo→baz` updates entries 51-100 (Postgres-serialized via the per-row FOR UPDATE), each audit row carries its actual affected entries. The audit pair is honest about the interleaving — not contradictory.
- **Q5 (cross-link `tag_rename` ↔ per-entry `ingest_update`):** threaded via `audit_extra.triggered_by_audit_id` per A3 above.

### A8 — `renameTag` / `deleteTag` no-throw contract (plan-CR M4)

The original plan implied `renameTag` could throw mid-loop on Voyage 5xx, leaving the route's `try/finally` audit-write with an undefined affected count.

**Decision: `renameTag` and `deleteTag` are no-throw at the operation level.** They always return:

```ts
type TagOperationResult = {
  affected_entry_ids: string[];       // entries actually updated this call
  partial_failure: boolean;            // true iff some entries failed mid-loop
  partial_failure_reason?: string;     // present iff partial_failure
};
```

Internal `updateEntry` throws are caught per-iteration; the loop continues to the next entry on transient failures (Voyage 5xx, lock-wait timeout). Permanent failures (DB connection lost) short-circuit the loop and return whatever was completed before the catastrophic error. The route writes the `tag_rename`/`tag_delete` audit row from the returned object unconditionally.

The exception: if the operation has not yet written the start-of-loop `tag_rename` audit row (i.e., `renameTag` throws BEFORE the audit row write), the route's `try/finally` writes a fallback `tag_rename` row with `partial_failure: true` + `partial_failure_reason: "<error class>"` + `affected_entry_ids: []`. This is the only "no audit row at all" escape, and it is a real catastrophe (DB unreachable before the first INSERT) — observability falls back to the application's stderr log.

### A9 — Tx posture for `lib/tags.ts` (plan-CR M3)

The original D2 §"Tx posture for the enqueue" mandated `enqueueJob` lives inside the same tx as the `updateEntry` write. Under A2 there is no enqueue.

**Decision: `lib/tags.ts::renameTag` and `deleteTag` call `updateEntry` directly per affected entry, with NO outer-tx wrapper.** `updateEntry` self-transacts; wrapping it in `db.transaction(...)` from the caller would just open a SAVEPOINT around the existing tx, adding no atomicity guarantee. The per-entry `updateEntry` calls are N independent tx; that is the correct shape for rename per D1 (which does NOT require cross-entry atomicity).

Merge (PR-B) is different — its outer-tx wrapper is load-bearing per D3 and stays.

### A10 — Plan-CR coverage summary

- **B1 (bundling protocol)** — Disagree+why. SESSION_PROTOCOL.md §"ADR Discipline" §ADR-prose-vs-code-reconciliation sub-rule (2026-05-27) explicitly presupposes amendment + impl shipping in one PR with a grep floor at code-CR time. ADR-0022 PR #324 is the cited precedent. The reviewer's protocol claim was incorrect; the bundle is the codified pattern.
- **B2 (D4 payload reshape)** — Folded into A3 above.
- **B3 (validation-vs-no-op-rename audit distinction)** — Folded into A4 above.
- **M1 (from-validation surface)** — Folded into A5 above.
- **M2 (admin-tags SQL subquery alias + bigint cast)** — Implementation detail; folded into `lib/admin-tags.ts` write.
- **M3 (redundant outer-tx wrapper)** — Folded into A9 above.
- **M4 (try/finally audit shape)** — Folded into A8 above.
- **M5 (lock-ordering for concurrent rename)** — Folded into A6 above.
- **M6 (tag_management_view payload on unauth branch)** — Folded into A3's `TagManagementViewAuditPayload` shape (outcome field + `tag_count: 0` on unauth).
- **MINORs (m1-m5)** — Folded into A3 or noted in implementation.
- **QUESTIONS (Q1-Q5)** — Answered in A7 above.

### A11 — Implementation-PR scope under A2 (PR-A revised)

PR-A bundles:
- This amendment (A1-A11).
- `lib/tags.ts` — `renameTag` + `deleteTag` per A8/A9.
- `lib/admin-tags.ts` — `listAdminTagsForRole` for the dashboard catalog read.
- `app/api/admin/tags/rename/route.ts` + `app/api/admin/tags/delete/route.ts` — withAdmin + Zod + lib call + audit write per A3/A4.
- `app/admin/tags/page.tsx` + `RenameForm.tsx` + `DeleteForm.tsx` — dashboard with catalog-pre-fill mechanical floor per A5.
- 3 new `audit_log.kind` values: `tag_rename`, `tag_delete`, `tag_management_view` (no migration needed; CHECK constraint unaffected).
- Test surface: lib unit + DB-integration + route + page (precedent: M4 #5 admin-stale-entries surface).
- One-line ROADMAP M4 #4 update noting PR-A landed; box stays `[ ]` until PR-C.

PR-B / PR-C unchanged from the original D7 split, except the D6 dashboard's "Active operations" section is retired under A2 (no jobs).

---

## Amendment 2026-06-01 — PR-B reconciliation: atomic-or-bust + outer-tx mechanics

The PR-B implementation session ran its Step 7b plan-CR against the planned PR-B shape; the reviewer surfaced three BLOCKING + five MAJOR findings that fold into the design text below ahead of PR-B's code-CR. Two locked design decisions also need to be captured at the ADR level so they survive into PR-C and beyond.

### B1 — Atomic-or-bust failure semantics (DP1(a))

**Decision: mergeTags is atomic-or-bust.** The per-entry loop runs inside ONE outer `db.transaction(...)`. Any per-iteration `updateEntry` throw propagates out of the callback; drizzle rolls back the outer tx (and every nested savepoint) → zero entries changed. mergeTags then throws `MergeRollbackError` carrying the audit_id captured at start.

This was empirically verified before code-CR via a TDD-first integration test (`tests/tags.integration.test.ts` "ATOMIC-OR-BUST GATE (B1)"): seeds 5 entries, poisons the embedder on the 3rd call, asserts that NO `entries_versions` v2 rows + NO `ingest_update` audit rows exist for ANY iteration after the merge throws. The test passed first-try against local docker Postgres — drizzle's nested savepoint chain unwinds to the outermost transaction callback as designed.

The alternative — mirror PR-A's A8 partial-failure (skip-on-transient + commit) — was considered and rejected because under outer-tx atomicity, "continue past a Voyage 5xx" would either (a) commit the merge with one entry silently unmerged, breaking D3's "single atomic event" claim, or (b) become decorative (the outer-tx wrapper adds nothing PR-A's per-iteration scoping doesn't already provide). DP1(a) honors D3 strictly.

The `TagOperationResult.partial_failure` flag is therefore always `false` on a successful merge response; the merge route omits it from the 200 JSON body (Q1 decision below). A rollback never reaches the success path — it raises `MergeRollbackError` instead.

### B2 — FOR-UPDATE lock-hold cost: stop-the-world for affected rows

**Accepted cost (documented, not engineered around): each affected row's `FOR UPDATE` lock is held for the duration of the entire outer tx.** A 500-entry merge holds 500 row locks simultaneously, blocking every concurrent `updateEntry` on any of those rows for the merge's wall-clock duration.

PR-A's renameTag/deleteTag deliberately scope per-iteration (each row lock releases at the per-iteration commit). PR-B's atomic-or-bust contract precludes that scoping — outer-tx atomicity requires holding locks until the outer commit. The two refactor-paths (give up atomicity to get per-iteration lock release; or accept the lock-hold cost) are mutually exclusive; PR-B picks the second.

At M4 admin scale (one operator, low-tens to low-hundreds of entries per typical merge), the lock-hold cost is acceptable. M5 hosting decision (multiple concurrent admins, real production scale, possible long-running merges) will revisit; BACKLOG entry queued for the M5 concurrency-posture review.

The lib's `applyTagTransformToEntry` helper gained an optional `outerTx?` parameter to support both modes — PR-A callers omit it (per-iteration scoping path); mergeTags provides it (atomic-or-bust path). The dual-mode helper is documented in-line.

### B3 — MergeRollbackError + route finalize for forensic rollback shape

**Decision: a rollback writes `partial_failure: true` + `partial_failure_reason` on the existing start-of-op `tag_merge` audit row.** Without this, a rolled-back merge's audit row is byte-identical to a no-op merge's audit row (both have empty `affected_entry_ids`), and the forensic trail cannot distinguish "rollback failure" from "no entries matched."

Implementation contract:
- `mergeTags` writes the start audit row BEFORE opening the outer tx (auto-tx INSERT). The row survives the outer-tx rollback.
- On rollback, `mergeTags` throws `MergeRollbackError` carrying the audit_id + the redacted error class.
- The merge route catches `MergeRollbackError`, reads the existing audit row's payload, splices in `partial_failure: true` + `partial_failure_reason: "rollback: <class>"`, writes it back via UPDATE. Wrapped in its own try/catch (a finalize failure shouldn't mask the 500).
- `MergeRollbackError` is a distinct class from `TagValidationError` and from generic `Error`; the route's catch chain orders [TagValidationError → 400, MergeRollbackError → 500+finalize, other Error → 500+fallback INSERT].

This is the ONE place beyond the lib's own end-of-op UPDATE that ADR-0025 endorses an `UPDATE audit_log` write. `audit_log` is otherwise append-only.

### Q2 — Finalize-inside-outer-tx for the lib's end-of-op UPDATE

**Decision: the lib's operation-level `tag_merge` audit-row UPDATE (the end-of-loop finalize that records the actual `affected_entry_ids`) lives INSIDE the outer tx, after the per-entry loop completes.** If the finalize UPDATE throws, the outer tx rolls back along with every per-entry change — atomic-or-bust extends to the finalize step.

The alternative (finalize OUTSIDE the outer tx, like PR-A's `renameTag`/`deleteTag` do) was considered: a finalize failure would leave the database with entries changed but the audit row showing empty `affected_entry_ids` — strictly worse forensic state than the rollback case. PR-A's outside-tx finalize is correct for PR-A because there's no outer tx to be inside of; PR-B's inside-tx finalize is correct for PR-B because there is.

### A4-extension — `to ∈ from` rejection (DP2)

The original A4 distinguished three cases (Zod malformed → 400 no audit / D9 validation failure → 400 no audit / no-op operation → 200 audit with empty array). PR-B adds a fourth surface: `to ∈ from` at the validation boundary.

**Decision: `to ∈ from` (after NFC normalization) joins A4 case 2** — HTTP 400, no audit row. Rationale: a merge with `to` in the source list is a request-shape error (the operation cannot coherently execute — what would the "merge target" mean if the target is also a source?). It's not a no-op the way "merge a non-existent tag" is; it's a malformed request. The lib's `mergeTags` throws `TagValidationError(field: "to", reason: "to_in_from")` BEFORE any DB write, so the no-audit-on-shape-failure invariant from A4 case 1 / case 2 extends to it naturally.

The form's UI guards the same condition client-side (the `MergeForm` "Target tag is also in the source list" warning + disabled submit button), so legitimate UI requests never hit the server-side rejection.

### D6 prose update — single-section MergeForm, retire per-row "Merge into…"

The original D6 section 1 said per-row affordances "Rename", "Merge into…", "Delete." PR-A landed Rename + Delete as standalone forms (catalog dropdown for `from`/`tag`), not per-row affordances. PR-B mirrors that pattern: a single `MergeForm` section with checkbox multi-select for `from[]` + a dropdown for `to`. The per-row "Merge into…" framing is retired.

Rationale: multi-source merge is the common case (the admin discovers three typo variants of "supplier" and merges them in one operation), and a multi-select UI is the natural shape. A per-row "Merge into…" would still need the multi-select to be useful, just promoted via a different entry point.

### D7 prose update — PR-B's "Active operations" dashboard section is retired

The original D7 said PR-B "lands the in-flight queue-depth section of D6, which becomes meaningful once merge can enqueue 100+ jobs at once." Amendment 2026-05-31 §A2 retired the `re_embed_entry` job queue (sync `updateEntry` instead). Amendment 2026-06-01 confirms: the D6 "Active operations" section is dropped from PR-B scope entirely; the lib's atomic-or-bust contract means there are no in-flight jobs to surface. PR-B ships the `MergeForm` + the `tag_merge` rendering branch in the existing audit-trail section; that's the dashboard delta.

### M2 — Reconciliation grep for `tag_merge` audit kind

The new `tag_merge` discriminator extends every existing surface that switches on `audit_log.kind` for tag operations:
- `lib/admin-tags.ts` `TagAuditRow.kind` union (rename + delete → rename + delete + merge).
- `lib/admin-tags.ts` `listRecentTagAuditRows` WHERE clause (adds `'tag_merge'`).
- `app/admin/tags/page.tsx` `summarizeAuditPayload` switch (new `tag_merge` branch rendering `merge [a, b] → "c" — N entries`).
- `tests/tags.integration.test.ts` audit-trail test assertion (new `expect(kinds).toContain("tag_merge")`).

Each surface was reconciled in the PR-B implementation; the audit-trail teardown's `kind LIKE 'tag\_%'` LIKE pattern already covers `tag_merge` by construction (no test-side surface drift).

### Q1 — Merge route response shape: omit `partial_failure` when false

The PR-A rename/delete routes always include `partial_failure: boolean` in the 200 JSON body. The merge route omits the field entirely on a 200 response — under DP1(a), `partial_failure` is always `false` on success (any non-success throws `MergeRollbackError` and returns 500). The PR-A field is preserved on its routes for backward compatibility.

The audit-row payload shape (`partial_failure?: true`) is unchanged across all three operations.

### Plan-CR coverage summary

- **B1 (savepoint-nesting atomicity)** — Agreed + verified via TDD-first integration test before code (above).
- **B2 (FOR-UPDATE scope-broadening)** — Agreed + documented as accepted cost; BACKLOG entry queued for M5 revisit.
- **B3 (forensic rollback gap)** — Agreed + implemented via `MergeRollbackError` + route finalize.
- **M1 (D6 UX collision)** — Agreed + retired per-row "Merge into…" (D6 prose updated above).
- **M2 (page.tsx switch + lib type union enumeration)** — Agreed + reconciled across every consumer.
- **M3 (outerTx-provided code path needs concurrent-edit race coverage)** — Deferred — the atomic-or-bust gate test exercises the new path under the only race that matters (mid-loop throw); a "two concurrent admins merging the same tag set" scenario adds disproportionate test complexity for a scale (M4 single-operator) where the race is rare. BACKLOG entry queued with the M5 concurrency-posture review.
- **M4 (atomic-rollback test under-specified)** — Agreed + implemented as count-based throwing embedder + per-iteration `entries_versions` count assertion.
- **M5 (Drizzle text[] binding)** — Agreed + smoke-tested first. Empirical correction folded into code: drizzle's `sql\`${jsArray}\`` template binds via toString(); workaround is to serialize the array to a Postgres array literal string ourselves and bind it as a single text param cast to text[].
- **m1 (iron-rule #6 docstring line)** — Agreed + added to `lib/tags.ts::mergeTags` docstring.
- **m2 (TagValidationError reason union extension)** — Agreed + extended (`to_in_from` / `empty_array` / `duplicate_in_from`) — no new error class.
- **m3 (server-side catalog membership re-check)** — Agreed + implemented in the merge route (divergence from PR-A's UI-only floor noted in the route comment; merge's multi-source failure mode is more severe).
- **m4 (409 vs 500)** — Disagreed + documented: 500 is correct for outer-tx rollback because the rollback covers both transient (Voyage 5xx) and catastrophic (DB lost) causes; 409 implies a retriable client conflict which is misleading. Forensic surface lives in `partial_failure_reason`, not HTTP status.
- **m5 (teardown assertion `expect(remaining).toBe(0)`)** — Agreed + added to `tests/tags.integration.test.ts` `beforeEach`.
- **Q1 (partial_failure: false in 200 response)** — Decided: omit (above).
- **Q2 (finalize UPDATE inside or outside outer tx)** — Decided: inside (above).
- **Q3 (lock-ordering hold-all-locks as deferred concurrency cost)** — Agreed + documented in lib docstring + BACKLOG.
- **Q4 (`to ∈ from` validation vs no-op audit row)** — Decided: 400 no audit (above, A4 extension).
- **Q5 (D7 prose stale "Active operations" reference)** — Agreed + retired (D7 prose update above).

---

## Amendment 2026-06-01 (PR-C) — final implementation slice, M4 #4 closed

PR-C ships the last leg of the D7 implementation split per ADR-0025 D5 + D14: the `GET /api/admin/tags?prefix=<>` admin endpoint and the `list_tags()` Ingestion Agent tool. Both surfaces share `lib/admin-tags.ts::listAdminTagsForRole`, now extended with an optional `{ prefix?: string }` filter. With PR-C live, **M4 #4 ROADMAP closes (box flips to `[x]`)**.

### Implementation footprint (no new design decisions; D5 remains the contract)

- `lib/admin-tags.ts` — `listAdminTagsForRole(pool, role, opts?)` gains optional ILIKE prefix per D5. Conditional WHERE expressed as `$2::text IS NULL OR LOWER(t.tag) LIKE LOWER($2) || '%'` (single SQL string handles both modes; m3 plan-CR fix).
- `app/api/admin/tags/route.ts` (new) — `GET` withAdmin handler. **No prefix length cap** (B1 plan-CR fix: D5 doesn't specify one + a defensive UTF-16 .length cap would conflate with D9's NFC code-point measurement). Empty-string / whitespace-only prefix normalizes to undefined → full catalog (M3 plan-CR fix).
- `lib/agents-tools.ts` — `LIST_TAGS_TOOL` + `LIST_TAGS_INPUT_SCHEMA` (optional `prefix`, no required[], `additionalProperties: false` as LLM coaching hint per existing pattern); `AGENT_TOOLS.length` 3 → 4.
- `app/api/agent/ingest/route.ts` — new `case "list_tags":` in `dispatchTool`. **Role plumbed from the request through to the lib call** (B2 plan-CR fix: D5 says "the agent tool inherits the calling agent's role context" — today always admin via withAdmin gate, but making the coupling visible via the explicit `role` parameter prevents silent future drift). Tool input Zod-parsed via `LIST_TAGS_INPUT = z.object({ prefix: z.string().optional() })` at the dispatch boundary (M6 plan-CR fix: agent passing `{prefix: 12345}` now produces a clean `tool_result.ok: false` rather than coercing through to the lib).
- `prompts/ingestion-agent.md` — version 0.2.0 → 0.3.0; the `tags[]` collection paragraph rewritten to instruct the agent to always call `list_tags({prefix: ...})` before proposing a tag value and prefer canonical bytes from the catalog. The hash sealed at boot (`lib/prompts.ts`) changes accordingly; every post-ship `agent_ingest`/`agent_ingest_update` audit row carries the new hash. Iron-rule #10 invariant unchanged — the byte-roundtrip assertion in `lib/prompts.ts` still fires and `lib/prompts.test.ts` pins both presence of v0.3.0 strings and absence of v0.2.0/v0.1.0 strings (m1 plan-CR fix).
- **Mechanical floor: registry-vs-dispatch drift gate** — `app/api/agent/ingest/route.test.ts` adds a test that iterates `AGENT_TOOLS` and asserts every entry resolves through `dispatchTool` to a real handler (no `unknown_tool:` fallthrough). A future tool added to the registry without wiring its dispatch case will now fail loudly at test time (M4 plan-CR fix).

### Plan-CR coverage summary (PR-C)

- **B1** (prefix cap mismatch) — Agreed + dropped the cap entirely.
- **B2** (hardcoded "admin" violates D5 role-context inheritance) — Agreed + plumbed role from request through `dispatchTool(name, input, role)` and into the lib call.
- **B3** (Reconciliation-grep 1-hop transitives) — Agreed + extended the existing D5 `describe` block in the integration test rather than adding a parallel one; `Awaited<ReturnType<typeof listAdminTagsForRole>>` derivation in `merge/route.ts:96` survives unchanged (only added an optional `opts` parameter).
- **M1** (audit-log tool-call ledger) — Deferred to BACKLOG: pre-existing gap, not introduced by PR-C; D5's "prompt_hash + tool-call log reproduces the run" is aspirational against the current audit-row shape.
- **M2** (ILIKE no-index posture) — Agreed + documented in `lib/admin-tags.ts` docstring; BACKLOG entry queued for M5 production scale.
- **M3** (empty/null/missing prefix semantics) — Agreed + locked: trim → if empty, undefined → full catalog. Route AND lib both normalize (belt-and-suspenders); test pinned.
- **M4** (registry-vs-dispatch drift floor) — Agreed + implemented.
- **M5** (catalog-pre-fill mechanical floor for agent) — Disagreed + documented: agent has no "free-text bypass" surface like the UI; legitimate "new tag" creations are indistinguishable from "typo of existing tag" server-side. Prose floor in v0.3.0 prompt is the right level for PR-C.
- **M6** (tool input not Zod-parsed in dispatch) — Agreed + added `LIST_TAGS_INPUT` schema in route + `safeParse` at the dispatch boundary.
- **m1** (v0.2.0→v0.3.0 negative-assertion) — Agreed + `lib/prompts.test.ts` content tests assert v0.3.0 strings + v0.2.0/v0.1.0 absence.
- **m2** (Amendment wording locked) — Agreed; this section IS the locked confirmatory amendment.
- **m3** (conditional WHERE via SQL coalescence) — Agreed + implemented.
- **Q1** (audit-log tool-call ledger) — Covered by M1 BACKLOG.
- **Q2** (verify-roadmap-tickboxes accepts PR-C flip) — Agreed + run as part of pre-push gate.
- **Q3** (Hebrew prefix URL encoding) — Agreed + Hebrew prefix integration test added (`prefix: "ספ"` matches `ספק` + `ספר`, excludes `לקוח`).
- **Q4** (prompt update LAST) — Agreed + order followed: lib + route + dispatch + tests gates green → THEN prompt v0.3.0 bump.
- **Q5** (ADR-0010 v0.2.0→v0.3.0 transition prose) — Agreed; recorded in ADR-0010 alongside this amendment.

### Reversibility

The prompt v0.2.0 → v0.3.0 transition is reversible at the cost of a follow-up prompt edit + hash regen + test update; no audit-log row migration is required (rows carry whichever hash was sealed at write time — that's the whole point of iron-rule #10's hash field). The `list_tags` tool can be retired by deleting the registry entry + dispatch case; existing audit rows referencing the tool name remain valid as historical records.
