# BACKLOG.md — Priority Knowledge Base

Scope-creep capture. Anything out-of-scope for the current milestone but worth keeping lands here. Reviewed every 5 sessions (per `SESSION_PROTOCOL.md` hygiene cadence).

Categories chosen for this project's shape.

---

## Architecture & Infra

- Multi-tenant data isolation strategy (if M6 multi-tenant happens).
- Vector index re-tuning playbook: HNSW `ef_construction` / `m` sweep when corpus passes 50k chunks.
- Postgres → external vector store (Qdrant / Weaviate) cutover criteria — only if pgvector recall stops being acceptable.
- Cold storage tier for entries older than 2 years that are rarely retrieved.

## Ingestion

- **Stronger Hebrew OCR**: evaluate Google Document AI alongside Azure DI on a 30-image Hebrew Priority screenshot set; pick winner by accuracy + cost.
- Bulk import from existing sources: email threads, Teams export, old Confluence dump.
- Auto-suggest tags from existing taxonomy during ingestion chat.
- Inline duplicate detection: when admin starts an entry, retrieve top-3 similar existing entries and offer "edit existing" instead of "create new".
- Screenshot annotation extraction: arrows/circles/highlights in Priority screenshots often mark the relevant field — extract as structured hints.

## Retrieval

- **Stale-entry "is this still true?" agent** — periodic re-verification pass (M6 candidate).
- Multi-turn retrieval: clarifying questions when the query is ambiguous, instead of guessing.
- Personalized retrieval: user's recent queries weight the search slightly toward their working context.
- Cross-language retrieval audit: Hebrew query → English entry retrieval quality check (Voyage handles it in theory; measure in practice).
- Negative-result UX: when retrieval finds nothing relevant, say so explicitly — don't synthesize.

## Quality & Evals

- Expand `evals/golden_set.yaml` to 100+ pairs across all major Priority modules.
- Adversarial eval set: queries with subtle wording, mixed Hebrew/English, typos, outdated terminology.
- Citation-quality eval: does the cited entry actually support the answer? (LLM-as-judge with Opus.)
- Retrieval-vs-baseline tracking: keep a "no reranker / no hybrid" config running in CI for regression baseline.

## Tooling & DX

- Local seed data script: 20 realistic-shaped entries for new dev onboarding.
- Prompt diff viewer: when `prompts/*.md` changes, show the eval delta vs. previous prompt version.
- Cost dashboard: daily Claude + Voyage spend, broken down by ingestion vs. retrieval vs. evals.

## Protocol — pending merge passes (from 2026-05-15 Pass 1 session)

- **Pass 2 (`WORKFLOW.md`, current-relevance):** worktree commit-handoff fork (Claude commits/pushes itself when running from a worktree; B3 fix from the Pass 1 review), secret-redaction rule (never quote the literal in the description), stacked-PR rule (CHATLOG.md is the canonical collision file → default to Pattern 2 trailing chore PR), describe-from-source rule (merge into CLAUDE.md's existing "ground answers in repo docs" style rule, not a separate entry), invisible Unicode literal rule (escape sequences only), multi-session user-visible-artifact rule, CI debugging — prefer CLI to action, web research rule (`WebFetch` 403 → `WebSearch`), "verify before asking" rule.
- **Pass 3 (`WORKFLOW.md`, M2a+ relevance):** unbiased CR mandatory after production-code commit (define PriorityKB CR trigger surface: `app/api/ingest/**`, `app/api/retrieve/**`, `db/migrations/**`, `prompts/**`, `lib/embedding/**`, `lib/retrieval/**`), pre-impl CR sub-rule (Step 7 edit — TradeBot Idea 7, deferred from Pass 1 to avoid forward reference), CR-to-fix transition rule (Step 7 gains a second-gate clause: "if CR-fix pass, second 'go' on fix scope required"), schema migration durability rule, "pre-existing" deferral rule, CR-finding-to-BACKLOG grounding rule, pre-fixture wiring check rule, API endpoint verification (Next.js App Router pattern: grep `export async function (GET|POST|PUT|DELETE)` in `app/api/**/route.ts`), debugging-discipline rule, Python test rules under a `### Python — applies from M2b` subsection (test assertion + import-binding patch).
- **Pass 4 — Conflict sweep** with this enumerated checklist: (1) Step 5 `fetch` correctly uses `dev` not `develop` ✅ already landed; (2) closing Step 5 gate vs worktree-handoff fork — confirm only one path active per context; (3) verify-before-recommending (Step 6) vs "verify before asking" (WORKFLOW) — keep granular Step 6 ritual-bound rule, keep WORKFLOW broad rule, no dedup needed; (4) describe-from-source extends CLAUDE.md's "ground answers in repo docs" rule rather than standing alone; (5) CR-to-fix two-gate edits Step 7 itself, not just WORKFLOW append; (6) final grep sweep for duplicate phrasing across all three files.
- **M2b: lock-reentrancy audit rule** — adopt the TradeBot rule's audit checklist (callers that hold the lock; callers of the converted method) when the M2b FastAPI worker code lands. Applies to `asyncio.Lock` reuse + sync DB sessions reused across awaits.
- **M2b: sync-in-async kernel** — generalize TradeBot's `ib_insync` sync-vs-async rule: when wrapping a sync SDK call inside an async path (Voyage / Anthropic SDK inside FastAPI), audit every call inside the coroutine for blocking sync I/O. Adopt when M2b worker lands.

## Open Questions

- How do we handle entries that are **wrong but historically right** (Priority changed, fix no longer applies)? Soft-delete with `superseded_by`? Tombstone with retention?
- Do we want admin-vs-admin entry approval (4-eyes) for `restricted`-tagged entries? Adds friction but adds safety.
- Should the Retrieval Agent ever refuse to answer (no high-confidence citation found)? What's the threshold?
- Backup encryption at rest — required from M1 or M5?
