# CHATLOG.md — Priority Knowledge Base

Session memory, **newest-first**. Each entry: max 5 content bullets + `Process improvement` + `Next session`. See `SESSION_PROTOCOL.md` Closing Ritual Step 2 for the exact format and constraints.

This file is read every chat (last 3 entries, per opening Step 4). Every 10 sessions, the older entries get archived to `docs/CHATLOG_ARCHIVE.md`.

---

## 2026-05-18 — M2a item 4-7 ROADMAP tick + ADR-0010 admin chat UI (2 PR pairs)

- ROADMAP M2a items 4-7 ticked via [#85](https://github.com/gzion2719/priority-kb/pull/85)/[#86](https://github.com/gzion2719/priority-kb/pull/86) (on `main`): POST /api/ingest (items 4+6), PUT version history (item 5), fixture-embedding tests (item 7), all with describe-from-source PR + file pointers in the shape of already-ticked items 1+2. Plan-CR caught 3 describe-from-source slips (`lib/ingest-schema.ts` birth PR, missing `app/api/ingest/route.test.ts`, item 7 needed the `lib/embedding.test.ts:161-175` mechanical-floor citation) verified via `gh pr view` before applying.
- ADR-0010 admin ingestion agent chat UI shipped via [#87](https://github.com/gzion2719/priority-kb/pull/87)/[#88](https://github.com/gzion2719/priority-kb/pull/88) (on `main`): SSE transport over Next.js Route Handlers, tool-use loop on server with concrete caps (8 iterations / 60s wall-clock / 20 turns / 10s keepalive), `lib/agents.ts` abstraction parallel to `lib/embedding.ts`, `submitEntryFromAgent` + `updateEntryFromAgent` wrappers as the mechanical floor for iron rule #10 (the `source: { kind: "agent" } as const` discriminator).
- Iron-rule footprint covers 11 of 13 non-negotiables explicitly (#1, #2, #4, #6, #7, #8, #9, #10, #11, #12, #13). LogEvent extension pre-decided as additive optional fields on existing `LogEventClaude` (`tool_iterations?`, `streaming?`) — not a new `kind` variant — to keep `prompt_hash` requirement intact for every Anthropic call site.
- Two-pass Step 7b on the ADR was load-bearing: plan-CR (2 BLOCKING + 7 MAJOR) added wrapper helpers + the four concrete caps + iron-rule #1 env-var handling + Vercel-cap claim correction; code-CR on the written ADR (3 BLOCKING + 6 MAJOR + 5 MINOR) caught PR title case (`ADR-0010` → `adr-0010`), missing README index row, missing Zod-parse step in tool-use loop driver, and iron-rule table gaps (#2 / #9 / #13 / #11).
- **Session Score 9/10.** Code 4/4, Protocol 3/3, Efficiency 2/3 (−1 for the `/tmp`-Windows-path retry on `gh pr create --body-file` + commitlint footer-line-length retry on the ROADMAP commit). Ceiling: PR body files as repo-local `.pr-body-*.md` from the start; commit bodies pre-wrapped under 100 chars.
- **Process improvement:** `docs/adr/README.md` gained a "Context-section discipline" sub-rule — ADR Context describes the world the ADR addresses, not the session-process meta (see `docs/adr/README.md`).
- **Next session:** ADR-0010 impl step 1 — `lib/agents.ts` abstraction + `AgentClient` interface + `AgentEvent` discriminated union + `AgentUnavailableError` + `createStubAgent` + `getAgent` env-gated factory + tests including the source-file-no-import floor mirroring `lib/embedding.test.ts:161-175`. Recommend fresh chat (chat archetype shift: code, not protocol).

---

## 2026-05-18 — M2a item 2: ingestion-agent prompt hash plumbing (mechanical floor for iron rule #10)

- Shipped via [#82](https://github.com/gzion2719/priority-kb/pull/82) → [#83](https://github.com/gzion2719/priority-kb/pull/83) (on `main`): `lib/prompts.ts` exposing `INGESTION_AGENT_PROMPT_HASH` (lowercase hex SHA-256 of `prompts/ingestion-agent.md` raw bytes, sealed at process boot via `import.meta.url`-relative `readFileSync`); `createEntry`/`updateEntry` take a **required** `source: {kind:"direct"} | {kind:"agent"}` discriminator; agent branch reads the constant directly so callers never inject a hash. Audit `payload.source` field added on both branches.
- **Required vs optional was the load-bearing CR catch.** Plan-CR (M2) flagged the original `prompt_hash` caller-arg as defeating the mechanical floor → refactored to no-hash-arg design. Code-CR (M2) then flagged my optional-with-default implementation as silently degrading a forgetful future agent caller → flipped to required + updated ~25 call sites. Both passes were load-bearing exactly as the Step 7b "amplified" sub-rule predicts.
- Negative-assertion integration test proves the DB CHECK `audit_log_prompt_hash_required_for_agent` rejects raw `INSERT (kind:'agent_ingest', prompt_hash:NULL)` by constraint name; new file-sealing unit test ties `INGESTION_AGENT_PROMPT_HASH` to the actual on-disk file bytes (rules out "constant is any 64-hex string"). BACKLOG: strikes M2a item 2 deferral, adds three forward-looking entries (Next.js standalone tracing for M5, agent-rejected audit rows for item 3, retrieval-side `lib/prompts` extension for M3).
- **Session Score 9/10.** Code 4/4, Protocol 3/3, Efficiency 2/3 (−1: bash-script bulk-insert of `source:{kind:"direct"}` mis-targeted a closing brace inside `await expect(createEntry(...))`, cost one manual unwind). Ceiling: for ≤30-count bulk edits inside nested call/await/expect blocks, prefer N hand-Edits over regex scripts.
- **Process improvement:** none this session (habit observation, not codifiable — see Ceiling).
- **Next session:** M2a item 3 — admin chat UI scaffold + Claude streaming client. Now unblocked: route handler passes `source:{kind:"agent"}` and gets the canonical `prompt_hash` for free. Likely needs an ADR for streaming-route shape + a fresh session (substantial new surface).

---

## 2026-05-18 — M2a items 4+5: POST + PUT /api/ingest E2E (2 PR pairs)

- Shipped M2a item 4 via [#76](https://github.com/gzion2719/priority-kb/pull/76) → [#77](https://github.com/gzion2719/priority-kb/pull/77) (on `main`): `POST /api/ingest` create-only scaffold — `withAdmin` HOF + Zod boundary, PII scrub → NFC → chunk → `embedBatch` (stub) → single tx into entries / entries_versions (version_no=1) / chunks (composite-FK sensitivity propagated) / audit_log (`kind:"ingest"`). New `lib/scrub.ts` + `lib/ingest.ts` + `tests/ingest.integration.test.ts` (real-Postgres FK + mid-tx ROLLBACK coverage).
- Shipped M2a item 5 via [#78](https://github.com/gzion2719/priority-kb/pull/78) → [#79](https://github.com/gzion2719/priority-kb/pull/79) (on `main`): `PUT /api/ingest/[id]` update path — append version_no=MAX+1, DELETE-before-UPDATE for cascade-avoidance, `SELECT ... FOR UPDATE` serializes concurrent updaters under READ COMMITTED (real two-connection lock-contention test with ROLLBACK-in-finally so a failed assert doesn't poison the pool). Extracted shared `lib/ingest-schema.ts` (Zod) + private `deriveChunksAndEmbeddings` helper used by both create and update. ROADMAP "version history" ticked.
- **Two-pass Step 7b on both slices was load-bearing every time.** Yesterday's `verify-before-implementing-CR-claim` sub-rule paid for itself on the second code-CR: 3 BLOCKINGs disagreed-and-verified-false (write-skew safe under READ COMMITTED, mock fit-for-purpose, trigger test correctly distinguishes), saving a real rewrite round. Plan-CRs caught PII-scrub missing, NFC/offset mismatch, mocked-db hollowness, and the original tautological "concurrent" test → real two-connection contention.
- **Session Score 9/10.** Code 4/4, Protocol 3/3, Efficiency 2/3 (−1 for the mock-db refactor sed dance — getter destructure snapshots at destructure time, not assertion time). Ceiling: think through eager-vs-lazy access semantics before refactoring shared test helpers.
- BACKLOG queued: `kind:"agent_ingest"` rename + prompt-hash plumbing for M2a item 2; `LogEvent` `kind:"route"` variant (route-500 path currently logs under `kind:"voyage"`); `.claude/settings.json` line-endings now ignored by prettier.
- **Process improvement:** `.prettierignore` adds `.claude/settings.json` — pre-existing Windows CRLF was failing `format:check` every session and forcing a caveat line on every handoff (see `.prettierignore`).
- **Next session:** M2a item 2 — `prompts/ingestion-agent.md` (versioned content) + SHA-256 hash plumbing + rename `audit_log.kind` from `"ingest"` to `"agent_ingest"` (BACKLOG queued). Lighter slice; mostly prompt content + audit-row wiring + 1 test that the CHECK constraint enforces non-null hash.

---

## 2026-05-18 — M2a item 1: withAdmin HOF (stub auth) — 2 PR pairs

- Shipped `withAdmin<C>(handler)` via [#70](https://github.com/gzion2719/priority-kb/pull/70) → [#71](https://github.com/gzion2719/priority-kb/pull/71) (on `main`): generic over App Router context (preserves `[id]/route.ts` `{params}`), strict 401-vs-403 split (401 = missing/invalid identity, 403 = recognized role + insufficient permission), RFC 7235-correct `WWW-Authenticate: Bearer realm="stub"` so M5 Entra swap is a value change not a shape change. 12 vitest cases including paired positive/negative (spy invoked on admin, not invoked on user), `it.each`-uniformized 401 assertions (status + body + WWW-Authenticate together), context pass-through (identity-equal), handler-throw propagation.
- Ticked ROADMAP M2a item 1 via [#72](https://github.com/gzion2719/priority-kb/pull/72) → [#73](https://github.com/gzion2719/priority-kb/pull/73) (on `main`): one-line tick with file pointers to `lib/auth.ts` + `lib/auth.test.ts`.
- Two-pass Step 7b on the HOF slice was load-bearing on both legs: plan-CR caught 3 BLOCKING (drop unused `getStubRole` export, replace tautological admin-only test with paired spy-invocation assertions, switch `NextResponse | null` → HOF wrapper); code-CR caught 2 MAJOR (App Router `NextRequest` + context generic missing — would have silently broken dynamic routes; missing pass-through test). All BLOCKING+MAJOR applied; n11 subsumed, n12 deferred as premature factoring.
- **Session Score 8/10.** Code 3/4 (−1 avoidable test rewrite on whitespace claim). Protocol 3/3 (clean two-pass Step 7b, both PR pairs handed off correctly). Efficiency 2/3 (−1 same whitespace cycle — believed reviewer's spec claim about `Headers.get` trimming without a `Read` of the Fetch spec). Ceiling: verify external-fact CR claims before implementing against them.
- **Process improvement:** `SESSION_PROTOCOL.md` Step 7b gained a "Verify-before-implementing-CR-claim" sub-rule — when a CR finding asserts factual external behavior, verify before implementing the fix (see `SESSION_PROTOCOL.md` Step 7b).
- **Next session:** M2a item 4 — `POST /api/ingest` as the first real `withAdmin` consumer. Touches Drizzle entries/entries_versions/chunks schema, Voyage wire-in via `lib/embedding.ts`, body validation, version-history append. Substantial — fresh session.

---

## 2026-05-17 — M1 housekeeping + L20 backup stub + L21 spike scaffold (4 PR pairs)

- Shipped 4 PR pairs to `main`: ROADMAP M1 tickbox housekeeping [#61](https://github.com/gzion2719/priority-kb/pull/61)/[#62](https://github.com/gzion2719/priority-kb/pull/62) (7 boxes ticked with PR/ADR/file references); pg_dump local-dev backup stub L20 [#63](https://github.com/gzion2719/priority-kb/pull/63)/[#65](https://github.com/gzion2719/priority-kb/pull/65) (script + Task Scheduler runbook with OneDrive-path quote-escaping + pre-existing `.gitignore` parent-exclusion bug fixed inline); BACKLOG park for release-PR-autocreate [#64](https://github.com/gzion2719/priority-kb/pull/64) (rode #65 release); Hebrew OCR spike scaffold L21 [#66](https://github.com/gzion2719/priority-kb/pull/66)/[#67](https://github.com/gzion2719/priority-kb/pull/67) (dual-model script + 5-strata sample + 4 pre-committed quantitative decision criteria; Phase 2 = user runs).
- Step 7b ran 5 times with significant catches each: golden_set 5+5 scope ratchet against ROADMAP/M3 boundary (dropped, collapsed 2 PR pairs → 1); silent-failure exit-code checks + OneDrive-path schtasks quoting on the backup stub; `GITHUB_TOKEN`-can't-trigger-workflows BLOCKING on release-PR-autocreate (workflow parked, BACKLOG entry instead); reviewer's BLOCKING on `prebuilt-read` Hebrew support refuted by a WebFetch against Microsoft's docs (both `prebuilt-read` + `prebuilt-layout` support printed Hebrew on api-version 2024-11-30); L21 code-pass added 120s timeout, endpoint-subdomain redaction in summary, `requireEnv`/`normalizeEndpoint` split (was stripping trailing slash from the API key too), pipe-escape in error notes.
- Phase 2 of L21 is user-side: provision Azure DI free F0 → 5 stratified Priority screenshots → run script → score 4 criteria → paste `_summary.md` back; Claude opens tiny `docs(backlog)` PR with results + L21 tick.
- **Session Score 8/10.** −1 protocol: describe-from-source slip in PR #61 commit body (false `.claude/settings.json` normalization claim — caught + amended pre-push, but written from memory not diff). −1 efficiency: full Step 7 + plan-CR + AskUserQuestion on release-PR-autocreate when the GITHUB_TOKEN BLOCKING was knowable from training data alone. Ceiling: surface external-state dependencies in Step 6 itself, not in Step 7 critique.
- **Process improvement:** `SESSION_PROTOCOL.md` Step 6 gained an "External-state dependency surface" sub-rule — when a focus needs user-only credentials / data / admin actions, the dependency goes in the Step 6 option's description so the user agrees to "scaffold + queue Phase 2" at focus-selection time (see `SESSION_PROTOCOL.md` Step 6).
- **Next session:** L21 Phase 2 once you've run the spike (paste `_summary.md` + per-image criterion scoring → I open the tiny `docs(backlog)` PR + tick L21). OR next M1/M2a item — only L21 + L20-style polish remain in M1.

---

## 2026-05-17 — M1 closure run: baseline migration + chunker + embedding abstraction (3 PR pairs)

- Shipped baseline-migration via [#49](https://github.com/gzion2719/priority-kb/pull/49) → [#50](https://github.com/gzion2719/priority-kb/pull/50) (on `main`): Drizzle wire-in (`drizzle-orm@0.36.4` / `drizzle-kit@0.28.1` exact pins), `drizzle/schema.ts` with composite FK `chunks(entry_id, sensitivity) → entries(id, sensitivity)`, HNSW index, CHECK + UNIQUE constraints, `0001_updated_at_triggers.sql` companion migration, CI postgres service container, `tests/migration.test.ts` via `pg_catalog` introspection. Plan-CR caught 5 BLOCKING; code-CR caught 1 BLOCKING (FK introspection joined by column-name equality — rewrote with `unnest WITH ORDINALITY`).
- Shipped chunker via [#52](https://github.com/gzion2719/priority-kb/pull/52) → [#53](https://github.com/gzion2719/priority-kb/pull/53) (on `main`): `lib/chunk.ts` deterministic 500/60 per ADR-0009, `js-tiktoken@1.0.20` `o200k_base`, NFC normalization, forbidden-range detection (unclosed fence ignored, table-row unit not table), `buildEmbedInput`/`getRawSlice` greppable separation. Code-CR caught 3 MAJOR — per-token UTF-8 decode drift (cumulative fallback), zero-token chunk guard, tautological paragraph-vs-sentence test rewritten to prove rank beats distance.
- Shipped embedding abstraction via [#55](https://github.com/gzion2719/priority-kb/pull/55) → [#56](https://github.com/gzion2719/priority-kb/pull/56) (on `main`): `lib/embedding.ts` with `embedBatch` as the primary surface (Voyage is batch-shaped per ADR-0009 §2), `tokens_used` on batch results, fixed-1024 dimensions readonly, `EmbeddingUnavailableError` typed for #12 degraded-mode handoff, SHA-256-seeded stub namespaced as `stub-sha256`/v1. Plan-CR caught 3 BLOCKING (interface-shape decisions made 10× cheaper now than at M2a).
- **Session Score 9/10.** −1 efficiency for the paragraph-vs-sentence test rewrite. Ceiling: codify negative-assertion test discipline.
- **Process improvement:** `WORKFLOW.md` gained a "Negative-assertion tests distinguish from the regression" rule (see `WORKFLOW.md`). Codified after 3 successive code-CRs caught weak negative-assertion tests this session (composite-FK rejection, paragraph-vs-sentence preference, `embedBatch` order).
- **Next session:** stale-ROADMAP-box housekeeping `docs(roadmap)` PR (M1 lines 14/15/16/19/23/25 done but not ticked) + next M1 item — recommend `evals/golden_set.yaml` skeleton (5 Hebrew + 5 English Q/A pairs, ~15 min) before opening M2a `/api/ingest`.

---

## 2026-05-17 — ADR-0008 (Drizzle replaces Alembic) + ADR-0009 (chunking strategy) — baseline migration unblocked

- Shipped [ADR-0008](docs/adr/0008-orm-and-migration-ownership.md) via [PR #43](https://github.com/gzion2719/priority-kb/pull/43) → [PR #44](https://github.com/gzion2719/priority-kb/pull/44) (now on `main`): Drizzle ORM + Drizzle-Kit SQL-first migrations override ROADMAP M1's Alembic commitment. `audit_log` mechanically enforces #10 via `kind` discriminator + `CHECK`. Python's M2b worker is a downstream SQLAlchemy consumer kept honest by an integration test.
- Shipped [ADR-0009](docs/adr/0009-chunking-strategy.md) via [PR #45](https://github.com/gzion2719/priority-kb/pull/45) (on `dev`) + [PR #46](https://github.com/gzion2719/priority-kb/pull/46) (release open): 500/60 chunks with trailing-merge, `o200k_base` proxy, embed-prefix bounded to embed-time only, post-scrub canonical `entries.body`, composite-FK `chunks(entry_id, sensitivity) → entries(id, sensitivity) ON UPDATE CASCADE` as the chunks-layer twin of ADR-0008's `audit_log` CHECK. Baseline-migration PR is now fully unblocked.
- **Four Step 7b passes ran** (plan + code on each ADR). Code-CR on ADR-0009 caught a factual error: I'd claimed Voyage's embeddings endpoint returns per-input token counts; it returns only aggregate `usage.total_tokens`. Fix: `chunks.token_count` is the local `o200k_base` proxy, not Voyage-authoritative. The "Amplified" sub-rule fired exactly as intended both times.
- **Session Score 9/10.** −1 for efficiency (avoidable Voyage-response factual error). Ceiling: web-verify uncertain external-API facts before baking them into ADR prose.
- **Process improvement:** `WORKFLOW.md` "Worktree commit-handoff rule" gained a *No empty-diff `dev → main` release PR* sub-rule — open the release PR only when `git log origin/main..origin/dev` is non-empty; see `WORKFLOW.md` "Worktree commit-handoff rule". Origin: PR #44 visibly looked empty after creation until #43 merged, and the user pinged on it.
- **Next session:** baseline-migration PR — Drizzle wire-in (`package.json` deps, `drizzle/schema.ts` with entries/entries_versions/chunks/audit_log, `drizzle/migrations/0001_baseline.sql`, `lib/db.ts` switches to Drizzle, healthz keeps passing, integration test against a Postgres service container). Code-bearing, likely a full session.

---

## 2026-05-16 — Audit-import process additions + language policy → English (ADR-0006/0007)

- Imported 5 operationally-tight rules from external YuTom audit into SESSION_PROTOCOL.md: Pre-flight step-completeness check, Closing Step 1 Session Score (3-axis 10/10), Goal-delivery verification, Goal-quantification extension under Step 7 Verify-before-finalize, Context-exhaustion early-close. Language policy flipped to always-English (operating scope only — Retrieval/Ingestion Agents stay on mirror; explicit scope in CLAUDE.md + ADR-0007).
- Two Step 7b passes ran: plan review caught 4 BLOCKING + 8 MAJOR (shrunk 5-commit plan to 1); code review on diffs caught 2 BLOCKING + 6 MAJOR propagation gaps (Step 1 still said mirror; .claude/settings.json hook still said mirror); all fixed pre-commit. Step 7b "amplified" sub-rule worked exactly as intended — second pass was load-bearing.
- ~40 YuTom Python sub-rules parked verbatim in docs/PYTHON_RULES_DRAFT.md with three-bucket sort discipline (adopt / adapt / reject) wired into ROADMAP M2b checklist as the first item. 12 YuTom rules skipped because already-present (e.g. Step 7b ≈ Rule 11); 6 rejected as YuTom-codebase-specific (e.g. VPS sudo, IndicatorSnapshot schema sweep).
- Released via [PR #40](https://github.com/gzion2719/priority-kb/pull/40) (feature → dev, merge `9bbb791`) + [PR #39](https://github.com/gzion2719/priority-kb/pull/39) (release dev → main, merge `0daaf38`); 13 files +374 lines on main. PR #39 was created prematurely with stale dev state but auto-grew after PR #40 merge — Path A worked.
- **Process improvement:** `SESSION_PROTOCOL.md` Step 5 gained the "Behind-origin blocks planning" sub-rule — when `git status` reports local-behind-origin by N>0 commits, block file-content-dependent planning until user-side `git pull --ff-only` lands (see `SESSION_PROTOCOL.md` Step 5). Origin: this session's 34-commits-behind opening that wasted one planning round.
- **Next session:** Resume the M1 path from the prior CHATLOG — Alembic baseline + ORM/query-builder ADR (recommended; unblocks schema work), OR a bite-sized `pg_dump` cron stub. Both still open per ROADMAP M1 checklist.

---

## 2026-05-16 — M1 log helper landed (after second-pass code-CR caught BLOCKING fixes I almost shipped)

- M1 observability log helper shipped via PRs [#35](https://github.com/gzion2719/priority-kb/pull/35) (merged), [#36](https://github.com/gzion2719/priority-kb/pull/36) (merged), and [#37](https://github.com/gzion2719/priority-kb/pull/37) (release open): `lib/log.ts` discriminated union (`prompt_hash` required for Claude at the type level, `ts?: never` blocks input-shape collision), runtime guards on `cost_usd` and `latency_ms`, best-effort secret redaction on the `error` field, sink+stringify try/catch so observability never breaks the call path. [ADR-0005](docs/adr/0005-log-event-schema.md) captures the schema.
- **Two Step 7b passes fired this session — the first on the plan (3 BLOCKING + 5 MAJOR caught), the second on the implementation (2 BLOCKING + 5 MAJOR caught).** I shipped after only the first pass and the user had to call it out before I ran the second. Plan-CR transformed the plan substantively (flat interface → discriminated union; new ADR; runtime mechanisms added) but I read "amplified plan" narrowly as "user-added scope" only. Same class of mistake as the previous session's *Step 7b dogfood failure* — different surface, same root.
- **`gh pr merge --auto` is what turned the second-pass code-CR into a 2-PR slice instead of 1.** Set `--auto` on #35 immediately after opening; CI passed in 90s and the merge fired before I'd thought about whether the implementation deserved its own review. By the time the code-CR found 2 BLOCKING + 5 MAJOR, the unfixed code was already on `dev` and I had to open #36 to fix what should have been one cleaner commit. User flagged both this and the two-PR-rule slip explicitly.
- **Process improvement:** `SESSION_PROTOCOL.md` Step 7b gained an "Amplified covers review-induced plan changes" sub-rule (plan-CR BLOCKING that changes types / schema / enforcement-mechanism triggers a fresh code-CR before commit); `WORKFLOW.md` worktree-commit-handoff gained *"Claude never merges its own PRs / no `--auto` ever"* + BACKLOG carries the PreToolUse-hook mechanical-floor follow-up — see `SESSION_PROTOCOL.md` Step 7b + `WORKFLOW.md` "Worktree commit-handoff rule".
- **Next session:** next M1 item — Alembic baseline + ORM/query-builder ADR (bigger, unblocks schema work), or a bite-sized line like `pg_dump` cron stub. Recommend Alembic + ORM ADR first.

---

## 2026-05-16 — PR-title mechanical floor (ADR-0004) + Step 7b dogfood failure

- PR #31's title failed the gate with a capital `S` in the subject — fourth instance of the same class across PRs #18/#20/#25/#31. Root cause: prose rules describe what a regex enforces and always drift; every prior fix patched the path that broke last time without preventing the next.
- Built the three-layer mechanical floor ([ADR-0004](docs/adr/0004-pr-title-mechanical-floor.md)): (1) `scripts/precheck-pr-title.mjs` wrapping `commitlint` against `commitlint.config.cjs` (now the single source of truth for both commit messages and PR titles, with `subject-case: never sentence-case` added to match `pr-title.yml`'s `^(?![A-Z]).+$`); (2) Claude Code `PreToolUse` Bash hook intercepting `gh pr create` and blocking bad titles before the call fires; (3) `pr-title-normalize.yml` server-side rewriting `^[A-Z][a-z]` subjects, leaving acronyms alone.
- **Step 7b dogfood failure:** I codified the unbiased-review-after-Step-7 rule earlier in the session and then immediately rationalized a skip on a scope-amplified plan ("ship + fix red"). User called it out. Post-hoc review caught 4 BLOCKING + 6 MAJOR — including hook false-positives on `echo "gh pr create ..."` text, silent acronym mutation in the normalizer, and a version drift between `package.json` and `.pre-commit-config.yaml` for `@commitlint/config-conventional`. All fixed before merge; 11 new regression tests pin the findings (29 total now, was 14).
- RED-bucket cleanup from the mechanism audit: PR #18/#20/#25/#31 bug histories moved to ADR-0004; Plain-English-recap Closing Step 7 dropped; Title-allowlist sub-rule collapsed to a one-line pointer. YELLOW items parked in `docs/BACKLOG.md` under "Protocol slimming" + "Tooling — follow-ups from ADR-0004 unbiased review".
- **Process improvement:** SESSION_PROTOCOL.md Step 7b opt-out tightened — only phrases that NAME the review skip the gate; approval phrases ("go", "ship it") don't, and added-scope-after-review = new Step 7 (see `SESSION_PROTOCOL.md` Step 7b).
- **Next session:** **Product, not protocol.** M1 structured JSON log helper (`lib/log.ts` emitting one JSON line per Claude/Voyage call with `tokens, latency, cost, prompt_hash, model, model_version`). Isolated, ~one session.

---

## 2026-05-16 — Step 7b unbiased-review codification + release PR #30

- Opened PR #30 (`release: dev → main`) to promote the 2026-05-15 M1+autotitle CHATLOG entry from `dev` to `main` — the orientation chain was missing that close entry because `main` (the lineage every worktree starts on) hadn't caught up. Docs-only diff, no `npm run check` needed (CI already green on dev via PR #29).
- Codified the user's new durable rule into `SESSION_PROTOCOL.md` Step 7 as **Unbiased-review sub-rule (Step 7b)**: every Step 7 spawns the `review-loop` skill before "Wait for go"; reviewer sees plan + rule paths only, never reasoning; user-explicit opt-out is the only skip path.
- Dogfooded the new rule on its own introduction — the review caught the two-PR-rule hazard (handoff must include PR #29's `/pull/29` link even though it was already merged) and the CHATLOG-on-dev-not-on-main asymmetry, both reshaping the plan before any file touched.
- **Process improvement:** SESSION_PROTOCOL.md Step 7 gained the Unbiased-review sub-rule (see `SESSION_PROTOCOL.md` Step 7, "Unbiased-review sub-rule (Step 7b)").
- **Next session:** next M1 item — pick between (a) structured JSON log helper (isolated, ~one session, recommended) and (b) Alembic baseline + ORM/query-builder ADR (bigger, unblocks schema work).

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
