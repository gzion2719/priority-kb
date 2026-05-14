# ADR-0003 — CI security gates baseline

- **Date:** 2026-05-14
- **Status:** Accepted
- **Deciders:** Gal Zilberman + Claude (with independent Plan-subagent review)

## Context

ADR-0002 establishes the branching model and the *shape* of branch protection. This ADR pins **which gates run, where they run, and which are required vs. advisory**. The intent is to lock in a known-good baseline that catches the things humans most reliably get wrong (committed secrets, unsafe code patterns, vulnerable deps, untyped/unformatted code) without producing the kind of routine red-CI noise that trains the team to ignore CI.

## Decision

### Required checks (block merge to `dev` and `main`)

1. **`Node — lint, format, types, tests`** (from `ci.yml`) — ESLint, Prettier `--check`, `tsc --noEmit`, Vitest. Already in place. Mirrors `npm run check`.
2. **`gitleaks`** (from `security.yml`) — secret scan on every push + PR. Pre-commit hook catches most leaks locally; CI is the backstop. Enforces non-negotiable #1 (credentials never committed).
3. **`Validate PR title`** (from `pr-title.yml`) — `amannn/action-semantic-pull-request` with explicit type allowlist matching ADR-0002.

### Advisory checks (run, surface findings, do NOT block merge)

1. **CodeQL JS/TS** (from `security.yml`) — **DEFERRED**: the workflow job is committed but commented out. Code Scanning must first be enabled in repo settings (Settings → Code security → Code scanning); the first run failed with "Code scanning is not enabled for this repository". Re-enable the job once that's done. When live: runs on PRs + weekly schedule, surfaces SAST findings via GitHub Code Scanning UI. **Must stay advisory** — NOT in required status checks because (a) it uses path filters, and required + path-filtered = "pending forever" trap, and (b) acting on findings is a deliberate review, not a merge-blocker. Python lane added when M2b lands. Reviewer already flagged CodeQL would produce zero findings on the M1 scaffold; the value compounds as routes and DB-touching code land — fine to bring online at M2a alongside the ingestion API.
2. **`npm audit --audit-level=high`** in the Node lane, run as `|| true` — annotates the job log with high/critical advisories but does NOT fail the build. Dependabot (below) does the actual patching; making `audit` a hard fail blocks unrelated PRs every time a transitive CVE drops.

### Dependabot (no PR check, just opens PRs)

`.github/dependabot.yml` enabled for:
- `npm` ecosystem (weekly, max 5 open PRs, groups patch+minor)
- `github-actions` ecosystem (weekly, max 5 open PRs)
- `pip` ecosystem — **deferred to M2b** when the Python project gains a real lockfile (`uv.lock` or `requirements.txt`). Without a lockfile, Dependabot scans PEP 621 deps but produces noisy/looser updates; not worth enabling early.

### Local guardrails (pre-commit + pre-push)

The CI gates have a local sibling so most failures are caught before push:

- **`.pre-commit-config.yaml`** runs on `git commit`:
  - `gitleaks` (same engine as CI)
  - `prettier --check`
  - `commitlint` (Conventional Commits — `commit-msg` stage)
- **`npm run pre-push`** (already present) runs the full `npm run check` — the CI mirror.
- Once `pre-commit install` is run locally (one-time setup), the secret scan + prettier + commitlint hooks fire on every commit automatically. The pre-commit framework manages the git hooks; the `package.json` `pre-push` script is intentionally kept narrow (CI mirror only) so it works without the Python toolchain.

### Repo policy files

- **`.github/CODEOWNERS`** = `* @gzion2719`. Reviewer policy lives here; expands when admins #2+ are added (non-negotiable #11).
- **`.gitattributes`** = `* text=auto eol=lf`. Eliminates the CRLF/LF warnings on every Windows commit; matches Linux CI runners.
- **`.nvmrc`** = `20`. Pins local Node to match CI (`actions/setup-node@v4` with `node-version: 20`).

### What's deferred

The reviewer suggested a longer list; these are explicit deferrals with the conditions for revisiting:
- **TruffleHog, Semgrep** — `gitleaks` + CodeQL cover the same surface; revisit if a finding slips through both.
- **License compliance check** — revisit at **M5** when shipping to customers.
- **Coverage delta (Codecov), bundle size (size-limit), Lighthouse CI** — revisit at **M2a** when real tests exist and there's a UI worth measuring.
- **Type-coverage gate, mutation testing** — overkill at M1; `tsc --strict` is already on.
- **Preview deploys, IaC plan check, container scan** — **M5** when deploys exist.
- **DB migration dry-run** — the **next session** (Postgres+pgvector + Alembic) bakes this into its PR.
- **Eval regression / token-budget / golden-set diff** — **M3** when `evals/golden_set.yaml` is populated. The eval lane in `ci.yml` already stubs the detect-then-skip pattern for this.
- **Signed commits / DCO** — overkill for a solo private repo; revisit if the repo goes public.

## Consequences

**Positive.**
- Secrets caught at commit time (pre-commit) and again in CI (gitleaks) — non-negotiable #1 enforced twice.
- CodeQL gives baseline SAST coverage for free, without false-positive merge-blocking.
- Dependabot keeps the dependency tree fresh without manual audit triage.
- Local guardrails mean most CI failures are caught before push, keeping the CI signal trustworthy.

**Negative / accepted.**
- Adding `pre-commit` adds a Python toolchain expectation locally (the framework is Python-based even when hooks are not). Accepted because M2b adds Python anyway.
- CodeQL on Next.js with one smoke test will produce zero findings for a while; the value compounds as routes and DB-touching code land. Accepted.
- `npm audit` as advisory means a vulnerable transitive dep could sit unfixed if Dependabot is slow. Mitigation: monthly manual review until automation tightens.

## Alternatives considered

- **Hard-fail `npm audit`.** Rejected — see context; routine red CI trains teams to ignore the signal.
- **Required-status-check on CodeQL.** Rejected — path filters + required = pending-forever block.
- **No local guardrails, CI-only.** Rejected — failing-CI iteration is a 2-3 minute round trip; failing pre-commit is instant.
- **Husky instead of pre-commit framework.** Considered. Pre-commit framework chosen because (a) it's the de facto standard for multi-language repos (Node + Python from M2b), (b) it manages hook versions in one config file, (c) the `gitleaks` and `commitlint` hooks are both first-class in the pre-commit ecosystem.
