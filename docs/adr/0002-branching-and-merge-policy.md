# ADR-0002 — Branching and merge policy

- **Date:** 2026-05-14
- **Status:** Accepted
- **Deciders:** Gal Zilberman + Claude (with independent Plan-subagent review)

## Context

The project has one developer today, expects to grow into a small admin pool by M5, and ships no production deploy until M5. The bootstrap session pushed directly to `main`; the auto-mode classifier blocked a subsequent direct push, and the discussion crystallized two requirements:

1. **Code lands via PR + CI.** No direct push to long-lived branches. The CI signal on each PR is the source of truth.
2. **`main` is the deployable line.** Integration work lives one step removed so partial / regression-prone changes never sit on `main` waiting for the next slice.

An independent reviewer argued that for a solo pre-deploy repo, a `dev` branch is ceremony without protection — trunk-based (`feat/* → main`) gives identical safety. That argument is acknowledged and rejected for this project: the integration-line discipline pays off when M5 introduces deploys, and adopting it pre-M5 means the workflow is already muscle memory by then.

## Decision

### Branches

- **`main`** — long-lived, protected. Deployable line. Source of release tags from M5 onwards. Only `dev` merges into it via a `release: dev → main` PR; **hotfixes are the sole exception** (see below). Direct push blocked.
- **`dev`** — long-lived, protected. Integration branch. Feature branches merge in via PR + green CI. Source of all promotion to `main`. Direct push blocked.
- **Feature branches** — short-lived. Named `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`, `refactor/<slug>`, `test/<slug>`, `ci/<slug>`. Cut from `dev`. PR target = `dev`. Deleted on merge.
- **Hotfix branches** — short-lived. Named `hotfix/<slug>`. Cut from `main`. PR target = `main`. Trigger criteria (the ONLY valid reasons to use this lane):
  - Production is broken in a user-visible way, OR
  - A security-critical vulnerability needs to land before the next normal `dev → main` cycle.
  After merge into `main`, the same commit MUST be back-merged into `dev` in the same session — otherwise `dev` drifts behind `main` and the next promotion PR will conflict.

### Merge mechanics

- **PR `feat/* → dev`** — merge commit (preserves feature-branch history; `dev` is the integration log).
- **PR `release: dev → main`** — merge commit titled `release: dev → main` containing the integrated slice; tagged from M5 onwards.
- **PR `hotfix/* → main`** — merge commit. Immediately followed by `git checkout dev && git merge --no-ff main` and push, with a commit message `chore: back-merge hotfix <slug> into dev`.

### Required PR title format

Conventional Commits with an explicit type allowlist: `feat, fix, chore, docs, refactor, test, ci, release`. Enforced by `pr-title.yml` workflow. The `release` type is reserved for `dev → main` promotion PRs.

### Branch protection (applied via `gh api` — see ADR-0003)

Two-pass rollout to avoid the chicken-and-egg of required-checks referencing workflows that have never run green:

- **Pass 1** (apply on day one, both `main` and `dev`): `allow_force_pushes: false`, `allow_deletions: false`, `required_pull_request_reviews: null` (no required approvals — would self-lock a solo repo since GitHub blocks self-approval), `required_linear_history: false`, `enforce_admins: false`, `restrictions: null`.
- **Pass 2** (apply after the first ci-hardening PR merges green, both `main` and `dev`): add `required_status_checks` with contexts `Node — lint, format, types, tests`, `gitleaks`, `Validate PR title`. CodeQL and `npm audit` are advisory — NOT in required-checks (they're path-filtered or non-blocking by design).

### Required-checks `strict` policy (amended 2026-05-20)

`required_status_checks.strict` is **`false`** on both `main` and `dev` — i.e., a PR does NOT need to be merged against the tip of the target branch before merging; it just needs the required checks (Node CI, gitleaks, PR-title) green.

**Why:** the project's merge-commit-on-all-PRs policy (above) means every `dev → main` release leaves a merge commit on `main` that isn't on `dev`. With `strict: true`, the *next* release PR would surface as "branch out-of-date" and require an "Update branch" click to merge `main`'s merge commit back into `dev` before each release. Per-release ceremony with zero protective value in a single-developer repo: the up-to-date requirement defends against multi-developer races that don't exist here, and the required-checks gate (CI green, gitleaks clean, PR title valid) already enforces "this diff was tested at this commit."

**When to revisit:** if a second admin joins the repo and concurrent PRs against `dev` become a real possibility, flip `strict` back to `true` on `main` (race-free guarantee on the deployable line). `dev`'s `strict` can stay `false` indefinitely — integration races on `dev` are caught by the per-PR CI signal, not by linearization.

Applied via:
```
gh api -X PATCH repos/<owner>/<repo>/branches/main/protection/required_status_checks -F strict=false
```
(Initial `gh api -X PUT .../protection` payload from ADR-0011's branch-protection execution did not pin `strict`; GitHub's default at protection-application time was `true`, which is what produced the friction this amendment removes.)

### What this is NOT

- **Not GitFlow.** No `release/*` branches, no `support/*` branches. The `dev → main` promotion PR plays the role of GitFlow's release branch without the long-lived overhead.
- **Not GitHub Flow.** GitHub Flow is trunk-based (`feat/* → main`); this policy adds the `dev` integration line.
- **Not strict.** Hotfixes are intentionally allowed to skip `dev`; the criteria are written down to keep that lane narrow.

## Consequences

**Positive.**
- `main` is always deployable from M5 onward without needing to cherry-pick.
- Required-check gates (security + lint + tests) run on every PR — secrets, type errors, lint regressions never reach `main`.
- The hotfix lane has a written-down trigger, so future-Gal doesn't expand it to "I'm in a hurry".
- The two-pass branch-protection rollout closes the unprotected window without locking us out of the first PR that introduces the required workflows.

**Negative / accepted.**
- Every change is 2 PRs (feature → `dev`, then `release: dev → main`). For a solo dev pre-M5 this is mild ceremony with low protective value; accepted because the muscle memory pays off at M5.
- The back-merge-hotfix-into-dev step is a human discipline; if it's skipped, `dev` falls behind `main`. Mitigation: codified in this ADR and in `WORKFLOW.md`'s "Branching & merging" section.
- Required-status-checks lock in the workflow names. Renaming `Node — lint, format, types, tests` later means a coordinated branch-protection update. Mitigation: workflow names are pinned in this ADR.

## Alternatives considered

- **Trunk-based (`feat/* → main`).** Industry default for small teams. Rejected because the `dev` integration line is the muscle-memory we want by M5, and the cost pre-M5 is just one extra merge per slice.
- **GitFlow.** Rejected — `release/*` and `support/*` branches are overhead for a single-line product.
- **Required reviewers via CODEOWNERS.** Rejected — GitHub blocks self-approval, so requiring 1 approval on a solo repo self-locks. Required checks alone enforce quality; reviewers become required once a second admin joins.
- **Hotfix-only direct push to `main`.** Rejected — hotfixes still go through PR + CI, just from `hotfix/*` instead of `feat/*`. The PR gate is the value; the branching is just bookkeeping.
