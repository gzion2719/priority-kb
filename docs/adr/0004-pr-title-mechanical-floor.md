# ADR-0004 — PR-title mechanical floor

**Status:** Accepted (2026-05-16)
**Supersedes:** N/A
**Related:** ADR-0002 (branching policy / type allowlist), ADR-0003 (CI security gates)

## Context

Between 2026-05-15 and 2026-05-16 the PR-title gate (`.github/workflows/pr-title.yml`) failed on four PRs of the same class:

| PR | Failing title | Failure surface |
| --- | --- | --- |
| #18 | `Dev` | Release leg of the Pass-2b session. Handoff included a `/compare/main...dev` URL; GitHub's UI defaulted the title to the head-branch name `Dev`, which fails `subjectPattern: ^(?![A-Z]).+$` |
| #20 | `Dev` | Same UI-default mechanism as #18, on the release PR for the rule fix that #18 birthed — the rule that was supposed to prevent #18 |
| #25 | `Dev` | `gh pr create --base main` was denied by the auto-mode classifier → handoff fell back to a compare URL → UI default. Third instance |
| #31 | `docs(protocol): Step 7b — always run unbiased review before "go"` | Claude typed a title with an uppercase first char of subject — passed commitlint at the time (which only forbade `upper-case`/`pascal-case`/`start-case`) but failed `pr-title.yml`'s `^(?![A-Z]).+$` regex |

Each incident produced a new **prose rule** in `SESSION_PROTOCOL.md` or `WORKFLOW.md`:

- After #18 → "Title-allowlist sub-rule" requiring conventional-commits-compliant `title:` proposals beside every PR link.
- After #20 → "Worktree-mode override" making Claude run `gh pr create` itself for both legs of the pair, baking titles in at creation time.
- After #25 → "Tooling-denial fallback" prohibiting `/compare/main...dev` URLs and replacing them with a paste-ready `gh` one-liner.
- After #25 (defense-in-depth) → `.github/workflows/release-pr-autotitle.yml` rewriting any `dev → main` PR title not starting with `release:`.
- After #31 → (this ADR).

The pattern: every prose rule patched the path that broke last time without preventing the next path. The Title-allowlist sub-rule listed allowed *types* but never said "subject must start lowercase" — the rule it would have needed to prevent #31. By the fourth incident the protocol files had accumulated ~30 sub-rules with embedded bug histories, and the rule-creation rate exceeded the feature-shipping rate.

## Decision

Stop patching with prose. Build a three-layer mechanical floor.

### Layer 1 — Local precheck (`scripts/precheck-pr-title.mjs`)

Node script that pipes a proposed title through `npx commitlint` against `commitlint.config.cjs`. Returns exit 0 on accept, exit 1 with stderr context on reject. Cross-shell (runs identically from Claude's Bash and the user's PowerShell).

Wired in:

- **Claude Code PreToolUse Bash hook** (`scripts/hook-gh-pr-create-precheck.mjs`, declared in `.claude/settings.json`) — intercepts any `Bash` tool call whose command contains `gh pr create`, extracts the `--title` argument, runs the precheck, and blocks the tool call with exit 2 if the title would fail. Fires automatically; Claude does not have to remember anything.
- **Vitest fixture** (`tests/precheck-pr-title.test.ts`) — golden set of historically-failing titles (`Dev`, `Pass 2b`, `release: Dev → main`, the literal #31 title) asserted as rejected; the autotitle workflow's `release: dev → main` output asserted as accepted. Wired into `npm run check` so the precheck rots loudly, not silently.

### Layer 2 — Server-side normalizer (`.github/workflows/pr-title-normalize.yml`)

Runs on every `pull_request: opened | reopened | edited` from this-repo branches (any source — Claude, GitHub UI, dependabot, future agents). Strips the `type(scope)?: ` prefix; if the subject's first char is `[A-Z]`, lowercases it via `gh pr edit`. Sibling to `release-pr-autotitle.yml`, which handles the special `dev → main` rewrite. Together they cover the GitHub-UI path that defeated #18 / #20 / #25 — a path the local precheck cannot reach because the title was never typed locally.

### Layer 3 — Commit-message hook (already existed)

`.pre-commit-config.yaml` has `commitlint-pre-commit-hook` at the `commit-msg` stage. It reads the same `commitlint.config.cjs` the new precheck reads — single source of truth. When `gh pr create` is invoked without `--title`, GitHub pulls the title from the head commit's message, which has already been validated by this hook.

### Source-of-truth alignment

`commitlint.config.cjs` is now THE source of truth for both commit messages and PR titles. To match `pr-title.yml`'s `subjectPattern: ^(?![A-Z]).+$` exactly, the config adds `"sentence-case"` to the `subject-case` "never" list (previously only forbade `upper-case`, `pascal-case`, `start-case`). This change is what catches the `Step 7b — ...` shape — commitlint's `sentence-case` rule rejects "First letter uppercase, rest lowercase" subjects, which matches the regex's first-char restriction at the level of granularity that actually fires in practice.

`.github/workflows/pr-title.yml`'s type allowlist remains the canonical reference in CI; the new layers all derive from `commitlint.config.cjs`, which is kept in sync with the workflow's allowlist manually (the two lists are 8 items each — drift here is visible).

## Consequences

**Positive:**
- The four historical failure shapes can no longer reach `git push` (Layer 1 blocks Claude's `gh pr create`) and can no longer reach CI red (Layer 2 normalizes server-side before `pr-title.yml` runs).
- Future agents, dependabot, and GitHub-UI flows all benefit from Layer 2 with no prose changes required.
- `SESSION_PROTOCOL.md` and `WORKFLOW.md` shed ~20–30 lines of bug histories that previously lived inline; the rule paragraphs now point at this ADR for the *why*.
- The Title-allowlist sub-rule in `SESSION_PROTOCOL.md` collapses to a one-line pointer at `commitlint.config.cjs` + the precheck script.

**Negative:**
- Layer 2 silently mutates titles, **but only when the subject matches `^[A-Z][a-z]`** — i.e., true sentence-case. Acronym-led subjects like `release: API redesign` are left alone so they fail `pr-title.yml` loudly rather than getting a silent `release: aPI redesign` mutation. The narrower trigger was added in response to a code-review finding before merge.
- The precheck test suite spawns `commitlint` per case (~2s cold start each, ~40s for the suite as of this writing). Acceptable for CI; not run on every developer save. Future optimization (BACKLOG): switch to `import { lint } from "@commitlint/lint"` for in-process execution.
- Adds two npm devDependencies (`@commitlint/cli`, `@commitlint/config-conventional`). Already present transitively via the pre-commit hook; now explicit for local invocation. **Version pinned in lockstep**: `.pre-commit-config.yaml`'s `additional_dependencies` and `package.json`'s devDeps must reference the same `@commitlint/config-conventional` version, or the two layers drift in rule semantics.
- **Fork-PR gap.** The server-side normalizer is gated on `head.repo.full_name == github.repository` because `secrets.GITHUB_TOKEN` is read-only on fork-PR workflow runs. Fork PRs and any future actor running outside the repo's trust boundary therefore reach `pr-title.yml` unnormalized — they'll fail CI on a bad title rather than getting auto-fixed. Acceptable: this repo is private and the dependabot path runs from in-repo branches with full token scope. Revisit if external contributors materialize.
- **Hook fires on every Bash tool call**, then early-exits when the command doesn't match a `gh pr create` segment. Node-startup overhead per call is in the ~50–150ms range on Windows. Tolerable today; BACKLOG item to investigate a narrower matcher if a future Claude Code version supports command-content patterns.

## Implementation pointers

- Hook script: `scripts/hook-gh-pr-create-precheck.mjs`
- Precheck script: `scripts/precheck-pr-title.mjs`
- Test fixture: `tests/precheck-pr-title.test.ts`
- Server normalizer: `.github/workflows/pr-title-normalize.yml`
- SoT config: `commitlint.config.cjs`
- Hook registration: `.claude/settings.json` (`hooks.PreToolUse.matcher: "Bash"`)

## Revisit triggers

- A fifth PR-title failure of any shape → re-open this ADR; do not patch with prose.
- `pr-title.yml` allowlist changes without `commitlint.config.cjs` matching → add a CI check that diffs the two.
- The Layer 2 normalizer makes an unintended rewrite → narrow its scope rather than disable it.

## Amendment 2026-05-25 — `gh pr merge` sibling floor

A second `PreToolUse` Bash hook ships alongside the title precheck: `scripts/hook-gh-pr-merge-block.mjs` blocks any `gh pr merge` invocation — including `--auto` — with exit 2. Same architecture as the create-side floor (segment isolation via duplicated `splitShellSegments` + anchored `^gh ... pr ... merge` regex after env-var stripping), tested via the same vitest stdin-payload pattern at `tests/hook-gh-pr-merge-block.test.ts`.

Why a sibling rather than an extension of this ADR's three-layer model: the merge-side rule has no server-side or normalizer counterpart — it's purely a client-side discipline gate (the user's Merge click is the gate; GitHub doesn't need help enforcing it). Only Layer 1 (the `PreToolUse` hook) applies. Codifying the recurrence (PR #35 auto-merge, 2026-05-16) and the prose rule (`WORKFLOW.md` "Claude never merges its own PRs") here keeps the architectural breadcrumb in one place rather than splintering into a fresh ADR for one hook.

Known bypass classes (consistent with the create-side hook): `bash -c "gh pr merge ..."`, `$(gh pr merge ...)`, backtick command substitution. These are out of scope; the floor is best-effort against accidental direct invocation.

If a 3rd `PreToolUse` hook consumer arrives, extract `splitShellSegments` + `stripCommentSegment` to a shared module (currently inline-duplicated with a "keep in sync" comment in both hook scripts).

## Amendment 2026-05-25 — Why `pr-title.yml` and `pr-title-normalize.yml` stay as 2 workflows

Considered (and rejected) during the post-revert CI cost-trim wave 2 evaluation: merging `pr-title.yml` (Layer 3 validate) + `pr-title-normalize.yml` (Layer 2 normalize) into a single workflow with two sequential steps to halve PR-edit runner spawns.

**Not viable. Reason: event-replay dependency.** `amannn/action-semantic-pull-request@v6` reads the title from `github.event.pull_request.title` — the event payload as it was at workflow-start. In the current 2-workflow design, when `pr-title-normalize.yml` calls `gh pr edit --title "..."`, GitHub fires a fresh `pull_request: edited` event that re-fires `pr-title.yml` against the **post-normalize** title. In a hypothetical single-job flow, the validate step would still see the **pre-normalize** title from the workflow-start payload — defeating the entire normalize→validate chain.

**Concrete failure mode** the merge would re-introduce: a PR opened via the GitHub UI with title `Dev` (the canonical PR #18/#20/#25 failure) would normalize to `dev` correctly via `gh pr edit`, but the validate step in the same job would still see `Dev` and fail — putting us back at the four-incident pattern this ADR exists to prevent.

The 2-workflow design is therefore load-bearing for Layer 2 + Layer 3 separability. Keep both files; document the constraint here so a future cost-trim session doesn't re-attempt the merge.

**If a single-workflow design ever becomes viable** (e.g., `amannn/action-semantic-pull-request` accepts a custom title input, OR we switch validate to a custom step that re-fetches the title from the API), revisit. Until then: 2 files, 1 runner per workflow, no merging.
