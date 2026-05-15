# CHATLOG.md — Priority Knowledge Base

Session memory, **newest-first**. Each entry: max 5 content bullets + `Process improvement` + `Next session`. See `SESSION_PROTOCOL.md` Closing Ritual Step 2 for the exact format and constraints.

This file is read every chat (last 3 entries, per opening Step 4). Every 10 sessions, the older entries get archived to `docs/CHATLOG_ARCHIVE.md`.

---

## 2026-05-15 — M1 first slice + third-strike autotitle floor

- Shipped first M1 DB-foundation slice (PR #24): `docker-compose.yml` + `db/init.sql` + `lib/db.ts` + `app/healthz/route.ts` + 3 vitest cases (mocked `pg`, non-negotiable #8). Independent plan review surfaced 3 BLOCKING + 7 MAJOR pre-implementation; all resolved before commit. Does NOT close M1.
- `Dev`-title bug fired a *third* time on PR #25 — `gh pr create --base main` denied by auto-mode, handoff fell back to a compare URL, GitHub's UI defaulted the title to `Dev`. PR #26 added the prose-layer fix (no compare URL for `dev → main`; paste-ready `gh` one-liner instead).
- Recognized the pattern across PR #18 → #20 → #25: every prose-layer fix patched the path that broke last time without preventing a new path. PR #27 adds `.github/workflows/release-pr-autotitle.yml` — server-side `gh pr edit` that rewrites any `dev → main` PR title not starting with `release:`. Mechanical floor, fires regardless of how the PR was opened.
- BACKLOG gained three deferred items: pin `pgvector/pgvector:pg16` by digest, ORM/query-builder ADR before any schema-touching route, Alembic-vs-node migration-runner cross-runtime decision.
- **Process improvement:** `.github/workflows/release-pr-autotitle.yml` + `WORKFLOW.md` "Server-side safety net" paragraph (commit `65435f8`). Defense-in-depth at the GitHub layer complementing the prose rules; the bug can no longer reach merge regardless of who opens the PR.
- **Next session:** next M1 item — pick between (a) structured JSON log helper (M1 acceptance line item; isolated, ~one session) and (b) Alembic baseline + ORM/query-builder ADR (unblocks schema work; bigger). Recommend (a) first to keep slices narrow.

---

## 2026-05-15 — Pass 2b + gh-pr-create automation (after PR-title rule failed live)

- Pass 2b: ported 3 sub-rules from TradeBot — stacked-PR + describe-from-source (WORKFLOW.md), verify-before-asking (SESSION_PROTOCOL.md Step 7). Deferred to Pass 2c: invisible Unicode, multi-session user-visible artifact, CI debugging, web research.
- PR-title gate failed on PR #18 (`Dev`); first attempted fix (a945e7f) added a "propose conventional title beside every PR link" rule — failed AGAIN on its own release PR #20. Mechanical fix replaced it: worktree mode now runs `gh pr create` itself for both legs of the pair, baking titles in at creation time (commit 1799b54).
- Dogfooding caught two own-foot bullets in real time: describe-from-source surfaced a false `.claude/settings.json` claim in the commit body that introduced the rule (amended out before push); gh-pr-create was used to open PR #21 itself.
- Key meta-lesson: prevention rules that require user behavior change ("paste the right title") will always fail eventually; mechanical automation ("Claude runs gh pr create") doesn't. Codified in WORKFLOW.md "Why Claude opens the PRs, not the user" rationale.
- **Process improvement:** WORKFLOW.md "Worktree commit-handoff rule" Step 4 (gh pr create for both legs) + SESSION_PROTOCOL.md Step 5 worktree-mode override (handoff uses `/pull/<N>` URLs, not `/compare/`); see commit 1799b54.
- **Next session:** M1 Foundation first slice — `create-next-app` scaffold in `.` with TypeScript + app router + ESLint; `styles/kramer-brand.css` imported in root layout; one branded landing page renders. Start a fresh chat (different archetype = code, not protocol).

---

## 2026-05-15 — Pass 2a: secret-redaction + worktree commit-handoff into WORKFLOW

- Ported 2 sub-rules from TradeBot's `WORKFLOW.md` into PriorityKB: **secret-redaction** (never quote the literal you claim to have redacted) and **worktree commit-handoff** (Claude runs gate + commit + push from inside the worktree; user gets only PR links).
- Step 7 critique caught the WORKFLOW-rule ↔ Closing Step 5 contradiction (the BLOCKING that Pass 1 deliberately deferred) and forced a same-pass resolution: Closing Step 5 gained a **Worktree-mode override** sub-rule so the gate-first user block is dropped when work lives in a worktree.
- Adapted: `make pre-push` → `npm run check`; VPS deploy line dropped (M5-deferred); secret-redaction example reframed to a `<voyage-api-key>`/`<entra-client-secret>` scenario rather than TradeBot's account-ID story.
- Pre-existing CRLF drift on `.claude/settings.json` surfaced and normalized via `prettier --write` to unblock the gate (line endings only, no logic change).
- This session dogfooded the new worktree commit-handoff rule on its own closing — Claude ran gate + commit + push, the user runs only PR-merge clicks.
- **Process improvement:** WORKFLOW.md gained two new top-level sections + SESSION_PROTOCOL.md Closing Step 5 gained the Worktree-mode override sub-rule (see `WORKFLOW.md` "Secret-redaction rule" / "Worktree commit-handoff rule" and `SESSION_PROTOCOL.md` Closing Step 5).
- **Next session:** Pass 2b — pick the next 1–2 WORKFLOW rules from the deferred bundle (stacked PR / describe-from-source / invisible Unicode / multi-session user-visible artifact / CI debugging / web research / verify-before-asking).

---

## 2026-05-15 — Protocol merge Pass 1: TradeBot patterns into opening ritual

- Ported 5 sub-rules from a TradeBot project's `SESSION_PROTOCOL.md` into PriorityKB's opening ritual: trigger-examples list + mechanical pre-response self-check + skip opt-out (`CLAUDE.md` header); `git fetch` before `git status` in Step 5; reconstruct-on-drift Step 5 sub-rule with `RECONSTRUCTED` marker; verify-before-recommending Step 6 sub-rule; verify-before-finalize Step 7 sub-rule.
- Unbiased plan reviewer caught 3 BLOCKING (`dev`-not-`develop` adaptation, pre-impl CR forward reference, worktree-handoff vs gate-first conflict) + 7 MAJOR that reshaped the plan from 4 passes to Pass 1 only; Passes 2/3/4 deferred to future sessions and M6/M7 (lock-reentrancy, sync-in-async) to `docs/BACKLOG.md` for M2b.
- Pass 1 deliberately excludes the pre-impl CR sub-rule (TradeBot Idea 7) to avoid forward-reference to a PriorityKB CR trigger surface — both land together in Pass 3.
- Worktree is on a `claude/cranky-...` branch off `main` lineage; per ADR-0002 the PR targets `dev` and content is docs-only, so the lineage doesn't affect mergeability.
- **Process improvement:** plan-review CR is mandatory before any multi-file protocol-merge edit; codification deferred to Pass 3 (alongside TradeBot's pre-impl CR rule) — landing it now would near-duplicate.
- **Next session:** Pass 2 — `WORKFLOW.md` current-relevance rules (worktree commit-handoff fork + secret redaction + stacked PR + describe-from-source + invisible Unicode + multi-session user-visible artifact + CI debugging + web research + verify-before-asking).

---

## 2026-05-14 — Bootstrap: scaffold, push, prereqs cleared

- Generated full protocol scaffold (18 files) at `C:\dev\PriorityKB` (deliberately off OneDrive per ADR-0001); pushed to private GitHub repo `gzion2719/priority-kb` on `main`; repo description + 5 topics set via `gh`.
- Independent Plan-subagent review surfaced and forced adoption of: OneDrive avoidance, Voyage `rerank-2` in M3 (not later), evals + observability + `pg_dump` cron land in M1, embedding abstraction with model+version per row, prompt files hashed and stored with every response, ≥2 admin accounts, degraded mode for outages.
- Stack locked: Next.js + Postgres+pgvector (HNSW), Voyage `voyage-3-large` embeddings + `rerank-2` reranker, Haiku/Sonnet/Opus model split (ingestion/retrieval/evals), Python FastAPI worker added in M2b only, Microsoft Entra ID deferred to M5 with `x-stub-user-role` header in dev. Brand: Kramer (`styles/kramer-brand.css`).
- Sequencing flipped: **M3 retrieval before M2b media** — text-only retrieval E2E is the viability proof.
- Prereqs swept: Node v24.14.1 ✓, Python 3.12.10 ✓, Docker + WSL2 working (after `wsl --install` recovered a corrupted state) ✓, `gh` authenticated ✓, CRLF auto-handling on ✓.
- **Process improvement:** SESSION_PROTOCOL.md Closing Ritual "When to run" gained a status-update-is-not-a-farewell clarification, after this session treated a GitHub URL share as a farewell signal (see `SESSION_PROTOCOL.md` Closing Ritual "What does NOT trigger the ritual").
- **Next session:** M1 Foundation first slice — `create-next-app` scaffold in `.` with TypeScript + app router + ESLint, `styles/kramer-brand.css` imported in root layout, one branded landing page renders. Docker-Compose Postgres+pgvector + Alembic baseline come the session after.

---

<!-- New entries go directly below the separator above, before this one. -->
