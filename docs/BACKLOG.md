# BACKLOG.md — Priority Knowledge Base

Scope-creep capture. Anything out-of-scope for the current milestone but worth keeping lands here. Reviewed every 5 sessions (per `SESSION_PROTOCOL.md` hygiene cadence).

Categories chosen for this project's shape.

---

## Architecture & Infra

- **Pin `pgvector/pgvector:pg16` image by digest** in `docker-compose.yml` (`@sha256:...`) — currently floating on the `pg16` tag, which is reproducibility debt.
- **Migration-runner cross-runtime decision** — Alembic (Python/SQLAlchemy) is the project-pinned migration tool per README, but the Next.js app uses `pg` directly. Decide ownership before any schema-touching code lands (likely co-located with the ORM/query-builder ADR). Affects whether Alembic runs from `api/` (M2b+) or earlier.
- **ORM / query-builder ADR** — `lib/db.ts` currently uses raw `pg.Pool` for `/healthz` only. Decide (raw `pg` / `postgres.js` / Drizzle / Prisma) before the first schema-touching route lands.
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

- **Fixture-recording hook on `logEvent`** — at M2a, when real Claude/Voyage call sites land, tee each `logEvent` call to a fixture file under test mode (env-gated). Lets test suites replay recorded API responses without re-hitting live APIs (non-negotiable #8). The injectable sink in `lib/log.ts` already supports this; just needs an env-gated tee wrapper. See ADR-0005.
- Expand `evals/golden_set.yaml` to 100+ pairs across all major Priority modules.
- Adversarial eval set: queries with subtle wording, mixed Hebrew/English, typos, outdated terminology.
- Citation-quality eval: does the cited entry actually support the answer? (LLM-as-judge with Opus.)
- Retrieval-vs-baseline tracking: keep a "no reranker / no hybrid" config running in CI for regression baseline.

## Tooling & DX

- Local seed data script: 20 realistic-shaped entries for new dev onboarding.
- Prompt diff viewer: when `prompts/*.md` changes, show the eval delta vs. previous prompt version.
- Cost dashboard: daily Claude + Voyage spend, broken down by ingestion vs. retrieval vs. evals.

## Protocol slimming — YELLOW items from 2026-05-16 mechanism audit

These are tightenings that would shrink the every-chat orientation read or remove ceremonial steps. Not urgent (the system works), but worth picking up when the protocol files are next touched.

- **Trivial-focus carve-out for Step 7 critique + Step 7b review.** When the chosen focus is a one-step task (e.g., "land this CHATLOG branch", "merge in dependabot bump"), the full 5-question self-critique + spawned unbiased review is overhead disproportionate to risk. Define a "trivial focus" predicate (single-file edit / no architectural surface / no migration / no prompt change) and allow a one-line critique + one-line reviewer ack instead. See SESSION_PROTOCOL.md Step 7 / Step 7b.
- **CHATLOG max-3-bullets carve-out for routine sessions.** Format currently caps at 5 content bullets; in practice every session uses all 5 and the orientation chain reads the last 3 → ~15 bullets per chat. Allow 3 bullets max for "routine execution" sessions (no decision, no new rule); reserve 5 for sessions that produce a decision or codified rule. See SESSION_PROTOCOL.md Closing Step 2.
- **Step 6 default-to-next-session carve-out.** When the previous CHATLOG's `Next session:` line is verified-still-pending and unambiguous, the `AskUserQuestion` round-trip is ceremony. Allow Claude to state "Continuing from the previous session's `Next session:` line — say 'go' or redirect" instead of presenting 2–3 options. The redirect path covers the user changing focus. See SESSION_PROTOCOL.md Opening Step 6.
- **Broader bug-history extraction pass.** ADR-0004 (2026-05-16) absorbed the PR-title saga's bug histories. Five to eight other rules in `SESSION_PROTOCOL.md` and `WORKFLOW.md` still carry inline "Codified DATE after PR #X" narrative paragraphs (e.g., the bootstrap CHATLOG status-update rule; the Pass 1 worktree-handoff resolution; the secret-redaction TradeBot port). Sweep all of them: imperative + one-sentence "why" stays inline, multi-paragraph history moves to an ADR.
- **Move `SESSION_PROTOCOL.md` "Worked example" to `docs/examples/`.** ~40 lines at the end of the protocol file, consulted rarely. Extract to `docs/examples/closing-ritual-example.md` with a one-line pointer.

## Tooling — follow-ups from ADR-0004 unbiased review (2026-05-16)

- **Narrower hook matcher for `gh pr create`.** The `PreToolUse` Bash hook in `.claude/settings.json` fires node on every Bash call and early-exits when the command isn't a `gh pr create` segment. Overhead ~50–150ms per call on Windows. Investigate whether Claude Code supports a command-content matcher pattern so the hook only invokes node when the command actually contains `gh pr create`. If so, narrow the matcher.
- **In-process commitlint for the test suite.** `tests/precheck-pr-title.test.ts` spawns `commitlint` per case (~2s cold each, ~40s suite total). Switch to `import { lint } from "@commitlint/lint"` to drop the suite to <1s. Only worth doing if the suite grows past ~20 cases or starts dominating CI time.
- **CI drift check between `pr-title.yml` allowlist and `commitlint.config.cjs` type-enum.** ADR-0004 documents these must match; nothing enforces it. Small workflow that parses both and fails if they diverge.
- **CI drift check between `.pre-commit-config.yaml`'s `@commitlint/config-conventional` version and `package.json`'s.** Same drift risk — currently pinned by hand to 19.8.1. Small script that greps both files and fails if they don't match.
- **Hook-script absolute path.** `.claude/settings.json` invokes `node scripts/hook-gh-pr-create-precheck.mjs` with a relative path. If Claude Code ever runs the hook from a subdirectory, the path breaks. Investigate `${CLAUDE_PROJECT_DIR}` or equivalent env var and switch when confirmed.

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
