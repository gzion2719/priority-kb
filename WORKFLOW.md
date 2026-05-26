# WORKFLOW.md — Priority Knowledge Base

How chats work across the project. Read on the first message of every chat (per `SESSION_PROTOCOL.md` opening Step 3).

---

## How to start a new session

Fresh Claude has no memory of past chats. Two paths to bootstrap a session correctly:

### Path A — Claude Code (recommended for this project)
1. Open a terminal at the project root: `cd "C:\dev\PriorityKB"`.
2. Launch Claude Code (`claude`).
3. Claude Code auto-loads `CLAUDE.md` as system context — it sees the language pair, non-negotiables, and the "always read first" instruction.
4. Type any first message (`hi`, `שלום חבר`, or your actual focus). The opening ritual fires.

### Path B — Cowork / Claude web / any other client
The client may not auto-load `CLAUDE.md`. Paste this as your **first message** verbatim:

```
You are in the Priority Knowledge Base project at C:\dev\PriorityKB. Before responding, read CLAUDE.md, then SESSION_PROTOCOL.md, then WORKFLOW.md, then the last 3 entries of CHATLOG.md, then docs/ROADMAP.md — in that order. Then run the Opening Ritual defined in SESSION_PROTOCOL.md starting at Step 1. Do not skip steps. Do not generate code before Step 7 confirmation.
```

Either path lands in the same place: Step 1 greeting → Step 2 folder confirm → … → Step 6 focus choice → Step 7 critique + wait for "go".

---

## Chat archetypes

### Build — implementing a milestone task
Most chats are this. Pick one focus from the active ROADMAP milestone (the lowest-numbered milestone with unstarted, unblocked items — see `SESSION_PROTOCOL.md` Step 6 Roadmap-first focus sub-rule), do the planning self-critique, ship the narrowest E2E increment, close with the ritual.

**Starter prompt (paste):**
> Build session. Focus: <task from active ROADMAP milestone>. Run opening ritual, then propose smallest E2E increment and wait for go.

BACKLOG entries are side-slices, never the primary build target — they appear in Step 6 only as secondary options, and only when the user explicitly picks one over the surfaced ROADMAP item.

### Research — investigating a tool / pattern / dataset
For when the path forward is unclear and we need to look at options or read existing code before committing. Outputs an ADR draft or a BACKLOG entry, not production code.

**Starter prompt:**
> Research session. Question: <question>. No production code; output is either an ADR draft or a BACKLOG entry. Constrain to <time/scope>.

### Unrelated — out-of-scope work
For one-off Q&A or tasks that don't touch the KB. Skip the opening ritual's deeper reads (Step 4); do not append a CHATLOG entry unless the work produces a project-affecting decision.

**Starter prompt:**
> Unrelated to PriorityKB. <ask>. Skip ROADMAP/CHATLOG reads.

---

## Fresh-chat triggers

Open a new chat when any of these hit:
- ~30 exchanges deep (context is starting to compact).
- Topic switch — different milestone or different chat archetype.
- Phase / milestone boundary (M1 → M2a, etc.).
- Claude forgetting or contradicting an earlier decision in the same chat.
- Approaching a sensitive operation (DB migration, schema change, prompt overhaul) — start fresh with full attention.

---

## End-of-session phrase

Any farewell triggers the closing ritual (see `CLOSE_SESSION_PROTOCOL.md` Closing Ritual). Examples:
- "thanks for today"
- "see you tomorrow"
- "we're done"
- "תודה על היום"
- "let's call it"
- 👋 / 🙏

---

## Branching & merging

See **ADR-0002** for the full decision; the short version:

- **`main`** = deployable line, protected. Only `dev` merges in via `release: dev → main` PR (or a hotfix — see below).
- **`dev`** = integration line, protected. Feature branches merge in via PR + green CI.
- **Feature branches** = `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`, `refactor/<slug>`, `test/<slug>`, `ci/<slug>`. Cut from `dev`. PR target = `dev`. Deleted after merge.
- **Hotfix branches** = `hotfix/<slug>`. Cut from `main`. PR target = `main`. ONLY for production-broken or security-critical fixes. **Immediately back-merge `main` → `dev`** in the same session.

PR title format: Conventional Commits with type allowlist `feat, fix, chore, docs, refactor, test, ci, release`. Enforced by `.github/workflows/pr-title.yml`.

Merge mechanics: merge commit on all PRs (no squash, no rebase). `dev` carries the integration log; `main` carries the release log.

### Handoff command examples

Feature → dev:
```
cd "C:\dev\PriorityKB"
git checkout dev && git pull
git checkout -b feat/<slug>
# ... work, commits ...
npm run check
git push -u origin feat/<slug>
gh pr create --base dev --title "feat(scope): subject" --body "..."
```

Release → main (when `dev` has an integrated slice ready):
```
cd "C:\dev\PriorityKB"
git checkout dev && git pull
gh pr create --base main --head dev --title "release: dev → main" --body "..."
```

Hotfix → main:
```
cd "C:\dev\PriorityKB"
git checkout main && git pull
git checkout -b hotfix/<slug>
# ... fix + tests + npm run check ...
git push -u origin hotfix/<slug>
gh pr create --base main --title "fix(scope): subject" --body "..."
# After merge:
git checkout dev && git pull && git merge --no-ff origin/main -m "chore: back-merge hotfix <slug> into dev" && git push
```

---

## Stacked-PR rule

When a feature **depends on another feature branch that isn't merged yet**, do NOT wait for the parent PR to merge before starting the child — and do NOT cut the child from `dev`. **Cut the child from the parent branch**, and set the child PR's `--base` to the parent branch, not to `dev`. After the parent merges to `dev`, retarget the child PR (`gh pr edit <num> --base dev`) and rebase/merge `dev` into the child to drop the now-redundant parent commits.

Why: cutting the child from `dev` while the parent is still open means the child's diff falsely contains every commit from the parent — the PR diff becomes unreviewable, CI runs the parent's tests twice, and merging the child to `dev` before the parent re-introduces the parent's commits as if they were the child's work. Stacking keeps each PR's diff scoped to exactly what that PR adds.

Mechanics:

```
# Parent already exists as feat/A with an open PR → dev.
git --no-optional-locks fetch origin
git checkout feat/A && git pull
git checkout -b feat/B          # cut child from parent, NOT from dev
# ... work, commits ...
npm run check
git push -u origin feat/B
gh pr create --base feat/A --title "feat(scope): B (stacked on feat/A)" --body "..."

# After feat/A merges to dev:
git --no-optional-locks fetch origin
gh pr edit <B-PR-number> --base dev
git checkout feat/B
git merge origin/dev            # drop A's commits from B's diff
git push
```

Naming: title the child PR with `(stacked on feat/A)` so reviewers know not to merge it before the parent. The first line of the PR body should restate the dependency and link the parent PR.

**Limit stack depth to 2.** Three-deep stacks (`C` on `B` on `A`) almost always mean the work should have been split differently — pause and re-scope rather than stacking deeper.

**Child-retarget-before-merge sub-rule (codified 2026-05-21).** When the stacked parent (`feat/A`) merges to `dev`, retarget the child (`feat/B`) via `gh pr edit <B> --base dev` AND rebase `feat/B` onto `origin/dev` BEFORE the child's merge UI is allowed to fire. If the child merges while its `baseRefName` still points at the (now-deleted) parent branch, GitHub merges the child into the *stale parent ref* — the child's diff never reaches `dev`, and recovery requires opening a fresh child-to-dev PR plus a follow-up `dev → main` release PR. **Trigger:** parent's merge notification (PR state → MERGED, branch deleted). Claude's handoff after a parent merge MUST surface the retarget command line as the first user-facing action, before any "ready to merge child" framing. **Origin:** 2026-05-21 M3 item 2 session — #158 merged to `dev`; #159 (stacked) was merged into the parent branch's now-stale state instead of being retargeted first; #159's content ended up orphaned and required #160 (re-target) + #161 (release for #158-only) + #162 (release for #160) — three PRs where one combined release would have sufficed.

(Ported 2026-05-15 from TradeBot's `WORKFLOW.md`; adapted to PriorityKB's `dev` integration branch in place of TradeBot's `develop`.)

---

## Describe-from-source rule

PR descriptions, commit bodies, CHATLOG bullets, and ADR prose describe **what the diff actually contains**, not what you remember intending to do. Before writing any of these, run the source-of-truth command for that artifact and write *from* its output:

| Artifact | Source-of-truth command |
| --- | --- |
| Commit body | `git --no-optional-locks diff --staged --stat` then `git --no-optional-locks diff --staged` for the parts that need detail |
| PR description | `git --no-optional-locks log --oneline <base>..HEAD` + `git --no-optional-locks diff <base>...HEAD --stat` |
| CHATLOG bullet | the actual edits made this session — re-read the changed files or `git diff` if already staged |
| ADR "Consequences" section | the implementation diff that motivated the ADR, not the original plan |

Memory drifts within a single session: a refactor gets renamed mid-edit, a function gets dropped because a simpler approach emerged, a test gets added that wasn't in the plan. A description written from memory tells the *plan's* story; a description written from source tells the *code's* story. The code is what reviewers will read, what `git log -S` will search, and what future-Claude will orient against — so that's what the prose must match.

Concrete failure mode this prevents: a PR body that confidently claims "removed the `<old-name>` helper" when the diff actually renamed it, OR a CHATLOG bullet that lists a sub-rule by the name it had in the planning critique rather than the name it has in the committed file. Both leak as soon as someone clicks the compare link.

(Ported 2026-05-15 from TradeBot's `WORKFLOW.md`.)

---

## Pre-push gate

Mirrors `.github/workflows/ci.yml` exactly. The gate command lives in `package.json` and (eventually) `pyproject.toml`.

**Node side (M1+):**
```
npm run check
```
Which runs:
- `npm run lint`     → ESLint
- `npm run format:check` → Prettier --check
- `npm run typecheck` → `tsc --noEmit`
- `npm test`         → Vitest

**Python side (M2b+, when the FastAPI worker lands):**
```
make py-check
```
Which runs:
- `ruff check api/`
- `black --check api/`
- `mypy --strict api/`
- `pytest api/ --cov`

If either gate is red, **do not push**. Fix locally; the gate is the contract.

---

## Secret-redaction rule

When writing CHATLOG bullets, commit messages, ADR prose, or comments that describe the *removal* of a secret or sensitive literal, **never quote the actual literal** — write `<voyage-api-key>`, `<entra-client-secret>`, `<token>`, or `[redacted]` instead. Quoting the real value in the description re-introduces exactly the leak the redaction was meant to close, and any future grep-based gate (or a casual `git log -S` by a human) will surface it just as fast as the original commit would have.

This is the symmetric pair to non-negotiable #1 ("credentials never committed"): #1 keeps secrets out of code; this rule keeps them out of the prose *describing* the cleanup.

Example: a CHATLOG bullet for a hypothetical "rotated leaked Voyage key" session must read `redacted <voyage-api-key> from styles/kramer-brand.css comment`, not `redacted pa-XXXX...XXXX from styles/kramer-brand.css comment`. The latter re-commits the live key into `CHATLOG.md` — the very file we read on every session start.

(Ported 2026-05-15 from TradeBot's `WORKFLOW.md`, where a CR-cleanup CHATLOG entry quoted the real account-ID literal it claimed to have redacted, and the project's `DUE[0-9]{6,9}` grep gate failed the develop→main PR.)

---

## Worktree commit-handoff rule

When Claude's edits live in a worktree (`.claude/worktrees/<name>/`) and the user's shell is in the main checkout — the default Claude Code setup on this project — **Claude commits and pushes from the worktree itself** instead of giving the user a gate-first command block. The user runs only the steps that require their hands: clicking "Merge PR" in the browser, and (eventually, post-M5) the deploy one-liner.

Why: the user's shell is PowerShell on Windows + the main checkout, which differs from Claude's Bash + worktree environment in two ways:
1. **Shell language.** PowerShell can't run bash heredoc (`<<'EOF'`), `$(cat <<...)`, or `cmd | git commit -F -` reliably for multi-line commit messages.
2. **Working directory.** Claude's file edits aren't in the user's `pwd`; the user must `cd` into the worktree first or git will say "nothing to commit, working tree clean" on whatever branch the main checkout last had.

Default flow when the session ran in a worktree:
1. Claude runs `npm run check` (and eventually `make py-check`) inside the worktree via Bash tool.
2. Claude runs `git add ... && git commit -F -` (Bash heredoc works because Claude IS in bash) inside the worktree.
3. Claude runs `git push -u origin <worktree-branch>` inside the worktree.
4. **Claude opens the PRs via `gh pr create`**, not the user. Both legs of the pair:
   - Feature → dev: `gh pr create --base dev --head <branch> --title "<type>(<scope>): <subject>" --body "<body from describe-from-source>"`
   - Release dev → main: after the feature PR is merged, `gh pr create --base main --head dev --title "release: dev → main (<scope summary>)" --body "<body>"`. If a release PR is already open against `main`, Claude **does not** open a duplicate — it edits the existing one's title/body if needed via `gh pr edit <num>` and notes the existing PR number in the handoff.
5. Claude hands the user **only**: the URLs of the now-already-open PRs (clickable links to `/pull/<N>`, not `/compare/...`), the merge instruction, and (post-M5) the deploy one-liner. The gate-first bash block is omitted because Claude already ran it.

**Why Claude opens the PRs, not the user.** GitHub's compare UI defaults the PR title to the head-branch name (`Dev` for the `dev → main` release PR), which fails `.github/workflows/pr-title.yml`. Asking the user to paste the right title on every release is friction that mechanical automation eliminates. Claude already has `gh` authenticated; creating the PR is one extra command. See ADR-0004 for the full bug history (PRs #18 / #20 / #25 / #31).

**Parallel `dev → main` release PR sub-rule.** When opening a feature PR pair, open the `dev → main` release PR **in the same handoff** *if and only if* `git --no-optional-locks log origin/main..origin/dev` is non-empty at handoff time — i.e., a prior feature has already merged to `dev` but not yet promoted to `main` (batched-release flow). When `dev == main`, GitHub's API rejects `gh pr create --base main --head dev` with "No commits between main and dev"; the release PR has to wait until *some* feature merges to `dev` first. There is no way around this — the parallel-open is a property of batched releases, not a workflow choice.

Trigger: about to send a handoff with a `feat/* → dev` PR link.
- Run `git --no-optional-locks log --oneline origin/main..origin/dev`.
- **Non-empty AND no open release PR** → open both PRs in parallel; the release PR's diff already contains the prior feature(s) and will auto-grow when this one merges.
- **Non-empty AND release PR already open** → reuse it (`gh pr view <num>`); do not open a duplicate. Note the existing PR number in the handoff.
- **Empty (`dev == main`)** → only the feature PR can be opened now. State explicitly in the handoff that the release PR will open after the feature merges; do not promise parallel.

If a release PR was opened in parallel and the user has merged the feature in the meantime, verify with `gh pr view <num> --json additions,deletions,changedFiles` that auto-grow worked before declaring the pair complete.

History: this rule was previously *no empty-diff `dev → main` release PR* (codified 2026-05-17 after release PR #44 looked empty until feature PR #43 merged). Briefly amended the same day to a permissive parallel-open default; that amendment was wrong about GitHub's API (no commits between base and head is a hard reject). Re-amended later 2026-05-17 to the current shape: parallel-open is real but gated on `dev` already being ahead of `main` at handoff time. In a one-feature-per-release flow (`dev == main` after every release merge) the gate is never satisfied; in a batched flow (multiple features merge to `dev` before a release is cut) it usually is.

**Claude never merges its own PRs.** `gh pr merge` (with or without `--auto`) is the user's click, not Claude's command. Claude runs the commit + push + `gh pr create`; the user clicks Merge in the GitHub UI (or runs the merge themselves). The wait between PR creation and merge is the **gate that forces second-look discipline** — it is the window in which Claude is supposed to think about whether another review fires (cross-ref `SESSION_PROTOCOL.md` Step 7b "Amplified covers review-induced plan changes"). Codified 2026-05-16 after Claude set `gh pr merge 35 --merge --auto`, CI passed in 90s, the auto-merge fired **before** Claude had pushed the code-CR fixes that the second Step 7b pass eventually surfaced — yielding a 2-PR fix slice (PR #36) where one cleaner PR would have sufficed. **Mechanical floor backing this rule:** `scripts/hook-gh-pr-merge-block.mjs` (declared in `.claude/settings.json` alongside the `gh pr create` precheck) intercepts any `gh pr merge` Bash invocation — including `--auto` — and blocks with exit 2. See ADR-0004 Amendment 2026-05-25.

**Tooling-denial fallback (no compare URL for `dev → main`).** When `gh pr create --base main` is denied or fails for any tooling reason, Claude does **not** hand the user a `/compare/main...dev` URL. The fallback: (1) state the denial in one sentence; (2) write the PR body to a stable path (`/tmp/release-pr-body.md` or similar) and tell the user the path; (3) hand the user the exact `gh` one-liner to paste: `gh pr create --base main --head dev --title "release: dev → main (<scope summary>)" --body-file <path>`. Compare URLs never appear in the handoff for the `dev → main` leg. Cross-ref: `CLOSE_SESSION_PROTOCOL.md` Step 5 "Tooling-denial fallback sub-rule"; design rationale in ADR-0004.

**Mechanical floor — runs before Claude even gets to call `gh pr create`.** The Claude Code `PreToolUse` hook (`scripts/hook-gh-pr-create-precheck.mjs`, declared in `.claude/settings.json`) intercepts any `gh pr create` Bash invocation, extracts the `--title`, and runs `scripts/precheck-pr-title.mjs` against `commitlint.config.cjs`. If the title would fail, the tool call is blocked with exit 2. Server-side: `.github/workflows/release-pr-autotitle.yml` rewrites `dev → main` PRs missing the `release:` prefix; `.github/workflows/pr-title-normalize.yml` lowercases leading-uppercase subjects on any PR. Together these are the three-layer mechanical floor in ADR-0004. **If you find yourself manually fixing a title after the hook fires, the precheck did its job — fix the title and retry.**

**Body source.** PR body comes from describe-from-source: `git --no-optional-locks log --oneline <base>..HEAD` + `git --no-optional-locks diff <base>...HEAD --stat`, written into a temp file passed to `gh pr create --body-file`. Don't hand-write the body from memory.

Multi-line commit messages: use `git commit -F -` with a heredoc on Claude's side. **Never give the user a heredoc** — PowerShell parses it as a syntax error.

This rule modifies — does not contradict — `CLOSE_SESSION_PROTOCOL.md` Step 5: see the **Worktree-mode override** sub-rule there for how the handoff message reshapes.

---

## Negative-assertion tests distinguish from the regression

When a test exists to prove that a constraint *rejects* something — a CHECK rejects an invalid row, a composite FK rejects a mismatched tuple, a boundary search prefers paragraph over sentence, a batch result preserves input order — the test must construct a scenario where the **constraint's absence would produce a different result**, and assert on the result that distinguishes the two worlds. "Does X work in the happy path?" is not a negative-assertion test; "Would the failing case pass if X were dropped?" is.

Concrete failure modes this prevents:
- A composite-FK rejection test that just inserts the matching row — passes even if the FK is dropped.
- A boundary-preference test that puts the higher-rank boundary AT the natural target offset — passes even if rank is ignored, because the rank-3 winner is also the closest candidate.
- An order-preservation test that asserts `result.length === inputs.length` — passes for any permutation.
- A CHECK-rejection test that uses `rejects.toThrow()` with no regex — passes when a different constraint throws too.

The fix is mechanical: before writing the test body, sketch the failure case ("if the FK were dropped, this insert would succeed") and assert on the property that *only* the constraint produces ("the error message names this exact constraint", "this exact char offset is in the boundaries list", "vectors[i] equals embed(texts[i]) for each i"). When the constraint's *absence* would produce an indistinguishable test pass, the test is tautological — rewrite before commit.

Codified 2026-05-17 after three successive code-CRs in the M1-closure session caught weak negative-assertion tests (composite-FK rejection asserted only `rejects.toThrow()`; paragraph-vs-sentence test placed `\n\n` at the natural cut so rank was untested; `embedBatch` test asserted `vectors.length === texts.length` only). Each case was a code-CR-driven rewrite round that the discipline above would have eliminated up front.

**Production-tokenization-mirror sub-rule (codified 2026-05-22).** When a DB-integration test seeds an entry and submits a query expecting the keyword lane to match, the query token MUST appear verbatim in the body **after** mentally applying the production tokenizer — `websearch_to_tsquery('simple', unaccent(regexp_replace(q, '[֑-ׇ]', '', 'g')))` for this project's keyword lane. Postgres' `simple` tokenizer splits on every non-alphanumeric (hyphens, underscores, slashes, colons, …), so a body word like `both-fail` tokenizes to `{both, fail}` and a query `bothfail` will NOT match. **Mechanical floor:** for any keyword-lane test, the seed body must contain at least one of the query's tokens as a standalone bare-alphanumeric run (no surrounding punctuation that would alter its tokenization on either side). Pick a single-token query that is already in the body verbatim — `"test"`, `"invoice"`, `"body"` — rather than a clever portmanteau or hyphen-joined construct. **Trigger:** about to write `keywordCandidates`-driven test seed/query pair, or any test where `entries.tsv @@ q` is the production code path under test. **Origin:** 2026-05-22 2c-i session — `query:"bothfail"` against body `"...both-fail test"` returned zero candidates so the route short-circuited to `no_content`, the retry path it claimed to assert was never exercised, and the bug surfaced only at the CI gate. This is the 3rd recurrence of self-written-test-data-doesn't-match-production-tokenization-or-cardinality (prior: 2026-05-21 stage-D 36-vs-37-char regex; 2026-05-22 2a `toHaveLength(10)` actual 9). Per `feedback_prefer_mechanical_over_prose`, a script-level floor is also queued — see `docs/BACKLOG.md` "Keyword-lane test seed/query tokenizer-mirror lint."

**Source-file-scan literal self-trigger sub-rule (codified 2026-05-21).** A specialization of the negative-assertion discipline for source-file content scans — tests of the shape `expect(srcFileText).not.toMatch(/forbidden-literal/)` (e.g., `/process\.env/`, `/@anthropic-ai/`, `/voyageai/`). The literal under test MUST NOT appear in the source under test, **including in comments, JSDoc prose, and string literals**. If your own prose contains the literal, the test fails vacuously and you pay a gate cycle to discover what a 5-second `Grep` would have caught at design time. **Mechanical floor:** before writing a forbidden-literal source-file scan (or before writing prose in a file that already has one), run `Grep` on the target file for the literal you're about to forbid. If found in your own comments or docs, rephrase using a non-matching paraphrase (e.g., "the env namespace" instead of `process.env`, "the Anthropic SDK bare-package-name" instead of `@anthropic-ai/sdk`) **before** the gate runs. **Trigger:** about to add or modify a source-file-content scan test, OR about to write a comment in a file that already has one. **Origin:** 2026-05-21 stage-D session — `lib/retrieval-anthropic-synth.ts` header comment contained `process.env.ANTHROPIC_API_KEY ?? ""` (footnote describing the factory's behavior) and `@anthropic-ai/sdk` (footnote on the SDK choice); both my own no-literal scans then failed on my own prose. Two avoidable gate cycles; the rule prevents recurrence.

---

## Main-checkout commit-body handoff (PowerShell)

When the user's shell is PowerShell and the session ran in the main checkout (not a `.claude/worktrees/<name>/` worktree), Claude writes multi-line commit bodies to `.commit-msg.tmp` in the repo root and hands the user `git commit -F .commit-msg.tmp` — never chained `-m` flags.

Why: PowerShell can't run bash heredoc (`<<'EOF'`). Chained `-m "subject" -m "body"` flags collapse each value into a single line; a 700-char body paragraph becomes one 700-char line that commitlint hard-rejects via `body-max-line-length` / `footer-max-line-length` (both capped at 100). PowerShell 5.1 also has no `&&` short-circuit operator, so when commit fails the chained `git push` runs anyway — pushing the parent commit ref as an empty branch — followed by `gh pr create` opening an empty PR that has to be backfilled.

Mechanics:
1. Claude writes the wrapped message (lines ≤ 100 chars, paragraphs separated by blank lines, `Co-Authored-By:` trailer on its own line) to `.commit-msg.tmp` via the Write tool.
2. Claude hands the user three commands: `git commit -F .commit-msg.tmp` → `git push -u origin <branch>` → `Remove-Item .commit-msg.tmp`.

This is the main-checkout twin of the Worktree commit-handoff rule above: that rule has Claude running git itself in Bash with heredoc; this rule has Claude pre-writing the body so PowerShell only needs `-F`. Codified 2026-05-18 after a chained-`-m` handoff dropped a 700-char body line into commitlint, commit failed, push ran anyway, PR #96 opened empty against `dev` and required `git commit -F .commit-msg.tmp` to backfill.

**Active-runner sub-rule (codified 2026-05-19).** When Claude has Bash tool access — the default on this project — Claude SHOULD run the commit + push + `gh pr create` sequence itself from Bash, mirroring the worktree-mode override, rather than hand the user a PowerShell command block. The `.commit-msg.tmp` pre-write is still the right intermediate (`git commit -F .commit-msg.tmp` from Bash is identical in behavior to PowerShell's `-F` invocation, just authored by Claude). The user-facing handoff then leads with a one-line confirmation that Claude ran gate + commit + push + PR creation (commit SHA + branch + PR number), then the PR pair as clickable `/pull/<N>` links, then session summary. User retains the merge click (per the existing "Claude never merges its own PRs" rule). **Trigger:** any main-checkout session where Claude has Bash AND the user has not explicitly asked to run the commands themselves. **Origin:** 2026-05-19 ADR-0010 step 3b session — initial close handoff gave a PowerShell command block per this section's prior wording; the user replied "where is the pr?" expecting Claude to have opened it. The PowerShell-friendly command shape was unnecessary friction; Bash availability makes the worktree-mode pattern apply to main checkout too. The rule's original motivation (avoid PowerShell heredoc / chained-`-m` commitlint failures) is still satisfied — the `.commit-msg.tmp` + `-F` pattern is the same; only who runs the command moves from user to Claude.

---

## Red flags — stop and resync

If any of these happen, pause and re-orient before continuing:
- Claude repeats a corrected mistake within the same chat.
- Claude contradicts a decision from an earlier message of the same chat.
- Claude generates content that contradicts `CLAUDE.md`, an ADR, a prompt file, or a recent CHATLOG entry.
- Tests pass but the manual smoke-check fails (means the test isn't testing what we think).
- Embedding/Claude API call appears in a test file (violates non-negotiable #8).
- Raw SQL insert / direct DB write appears outside a migration (violates non-negotiable #2).

Resync = re-read the relevant rule file, restate the constraint, then continue.

---

## Operating discipline (imported 2026-05-26)

Rules ported from `docs/PYTHON_RULES_DRAFT.md` §"Migrated WORKFLOW.md sections" per [ADR-0016](docs/adr/0016-python-rules-adoption.md) §7. These are operating-discipline rules (not Python pre-push gates), already-relevant to PriorityKB today regardless of M2b status.

- **External version lookups: prefer `WebSearch` over `WebFetch`.** When checking a third-party library's current version, latest changelog, or upstream behaviour, prefer `WebSearch` (returns summary + multiple sources) over a single `WebFetch` of a guessed URL. `WebFetch` against a guessed `/changelog`, `/releases`, or `/docs` path frequently 404s or returns stale-cached content; `WebSearch` surfaces the canonical URL first. *Imported 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016 §7).*
- **Egress allowlist awareness.** Cowork sandbox blocks `WebFetch` on non-allowlisted domains; if a fetch unexpectedly fails with a network-style error rather than a 4xx/5xx response, suspect the allowlist before debugging the URL or the tool. Fall back to `WebSearch` (which has a broader effective allowlist) or surface the missing domain to the user for an allowlist addition. *Imported 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016 §7).*
- **Never keyword-filter output when assessing process health.** When checking whether a long-running process is healthy (server log, CI run, background job), read the raw output; do not `grep` for `error` / `fail` / `success` first. Keyword filters silently miss the actual failure shape (a panic without `error` in the message; a "succeeded" line that's followed by a fatal three lines later). Read the bottom of the log first; keyword-grep is a second-pass tool, not a first-pass health check. *Imported 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016 §7).*
- **Platform-status check FIRST on repo-wide CI silence.** When CI workflows fail to schedule and the silence spans the whole repo (zero `queued` + zero `in_progress` + zero recent runs across any branch via `gh api 'repos/<owner>/<repo>/actions/runs?per_page=10'`), check `https://www.githubstatus.com/api/v2/components.json` BEFORE applying any repo-side recovery action (close+reopen PR, empty commit + push, branch protection edits, workflow file diffs). A single 1-second platform check distinguishes "GitHub Actions is in a major outage" from "something on our side is misconfigured" and eliminates the class of diagnostic loops that chase a repo bug which is actually a platform outage. **Trigger:** CI silence with all-zero scheduling counters via the API → status check is the first move, repo-side kicks are downstream of it. **Origin:** 2026-05-26 M4 #6 close-out — PR #288 opened during a GitHub-wide Actions `major_outage` (incident "Actions and Pages" 10:57Z); I chased permissions / repo settings / billing scopes / branch SHA / workflow approvals for ~4 round-trips before checking the platform status page. *Codified 2026-05-26.*
- **Sequenced-instruction confirmation discipline.** When the user issues a multi-step sequenced instruction ("first do X, then Y, then Z"), confirm completion of step N before starting step N+1 — don't bundle the whole sequence into a single tool call. The user's mental model of "where you are" relies on the step boundary surfacing as a checkpoint; collapsing the steps into one action removes the redirect window if step 2 turns out to need a different shape than step 1 implied. *Imported 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016 §7).*
- **Verify-pasted-output-line-number-against-current-SHA.** When the user pastes a CI / test failure log naming a line number, before any re-investigation of the failing code, `grep -n` for the failing assertion pattern in the current working-tree file and confirm the reported line number matches. If it doesn't, the pasted log is from an older commit and the fix may already be on the branch — confirm via `gh run list --branch <branch> --limit 5 --json headSha,name,conclusion,createdAt` that the latest run on the current HEAD SHA exists and check its conclusion before re-investigating. **Trigger:** the user pastes a multi-line CI/test log containing a `<file>:<line>` or `line N` reference → first action is the line-number cross-check, NOT re-reading the cited code path. **Origin:** 2026-05-26 — pasted CI failure for #288 showed `tests/retrieval-pipeline.integration.test.ts:516` failing `expect(candidates.some((c) => c.tags.length > 0))`; my seed fix in commit c03cd1e had shifted the assertion to line 534, but I re-investigated the orchestrator's `tags` projection path (lib/retrieval-pipeline.ts:478-549) for ~10 minutes before noticing the pasted log was from the previous SHA cbf7319. A 5-second `grep -n "candidates.some" tests/retrieval-pipeline.integration.test.ts` would have surfaced the mismatch immediately; the `gh run list` cross-check would have confirmed the latest CI run was cancelled, not failed, separately. *Codified 2026-05-26.*

---

## Emergency protocol

If the KB is corrupted (bad data, schema drift, accidental admin mass-delete):

1. **Stop writes.** Flip the ingestion API to read-only mode.
2. **Snapshot current state** — `pg_dump` immediately even if you think the data is bad; you'll want the forensic snapshot.
3. **Restore from last good backup** (nightly `pg_dump` in M1+, S3-backed in M5+).
4. **Diff and re-ingest** the entries from the gap window.
5. **Postmortem** as ADR — what failed, what guardrail prevents recurrence.

If Claude or Voyage is down for >15 minutes: flip the Retrieval Agent to **degraded mode** (keyword-only search, no synthesis). Banner the UI. This is per non-negotiable #12.
