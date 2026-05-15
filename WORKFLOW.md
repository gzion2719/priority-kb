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
Most chats are this. Pick one focus from the active ROADMAP milestone, do the planning self-critique, ship the narrowest E2E increment, close with the ritual.

**Starter prompt (paste):**
> Build session. Focus: <task from ROADMAP / BACKLOG>. Run opening ritual, then propose smallest E2E increment and wait for go.

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

Any farewell triggers the closing ritual (see `SESSION_PROTOCOL.md` Closing Ritual). Examples:
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

**Why Claude opens the PRs, not the user.** GitHub's compare UI defaults the PR title to the head-branch name — `Dev` for the `dev → main` release PR — which is *never* a valid conventional-commits title and *always* fails `.github/workflows/pr-title.yml`. Asking the user to manually paste the right title on every release is friction that mechanical automation eliminates. Claude already has `gh` authenticated (it pushed the branch); creating the PR is one extra command. Codified 2026-05-15 after the title failure recurred on PR #18 (`Pass 2b`) and PR #20 (the rule that was supposed to prevent PR #18) — proof that any rule which requires the user to click-paste-the-right-title on every release will eventually fail.

**Tooling-denial fallback (no compare URL for `dev → main`).** When `gh pr create --base main` is denied by the auto-mode classifier, blocked by sandbox permissions, or fails for any tooling reason, Claude does **not** hand the user a GitHub `/compare/main...dev` URL — that URL pre-fills the title from the head-branch name (`Dev`) and re-introduces the exact failure mode this rule exists to eliminate. The fallback is: (1) state the denial in one sentence; (2) write the intended PR body to a stable path (`/tmp/release-pr-body.md` or similar) and tell the user the path; (3) hand the user the **exact `gh` one-liner** to paste from their own shell: `gh pr create --base main --head dev --title "release: dev → main (<scope summary>)" --body-file <path>`. The compare URL must never appear in the handoff for the `dev → main` leg, denial or no denial. Cross-reference: `SESSION_PROTOCOL.md` Closing Step 5 "Tooling-denial fallback sub-rule." Codified 2026-05-15 after PR #25 fired the `Dev`-title failure for the *third* time — once on PR #18 (codified the "Claude proposes the title" rule), once on PR #20 (codified the "Claude opens the PR" rule), and once on PR #25 (`gh pr create` was denied, the handoff fell back to a compare URL, and the user dutifully clicked through to GitHub's UI default).

**Body source.** PR body comes from the describe-from-source rule above: `git --no-optional-locks log --oneline <base>..HEAD` + `git --no-optional-locks diff <base>...HEAD --stat`, written into a temp file passed to `gh pr create --body-file`. Don't hand-write the body from memory of intent.

Multi-line commit messages: always use `git commit -F -` with a heredoc on Claude's side. **Never give the user a heredoc** — if for some reason the user must drive the commit themselves (non-auto mode, or they explicitly ask), prefer either (a) `git commit -m "single short title"` plus a follow-up `git commit --amend`, or (b) write the message to a tracked temp file with the Write tool and tell them `git commit -F .git/COMMIT_MSG.tmp`.

This rule modifies — does not contradict — Closing Ritual Step 5: see the **Worktree-mode override** sub-rule there for how the handoff message reshapes when this rule fires.

(Ported 2026-05-15 from TradeBot's `WORKFLOW.md`, where two consecutive closing-ritual rounds wasted a multi-line `git commit -m "$(cat <<'EOF' ... EOF)"` handoff on PowerShell parse errors and a stale main-checkout branch.)

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

## Emergency protocol

If the KB is corrupted (bad data, schema drift, accidental admin mass-delete):

1. **Stop writes.** Flip the ingestion API to read-only mode.
2. **Snapshot current state** — `pg_dump` immediately even if you think the data is bad; you'll want the forensic snapshot.
3. **Restore from last good backup** (nightly `pg_dump` in M1+, S3-backed in M5+).
4. **Diff and re-ingest** the entries from the gap window.
5. **Postmortem** as ADR — what failed, what guardrail prevents recurrence.

If Claude or Voyage is down for >15 minutes: flip the Retrieval Agent to **degraded mode** (keyword-only search, no synthesis). Banner the UI. This is per non-negotiable #12.
