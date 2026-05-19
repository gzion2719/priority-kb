# ADR-0011 — Repo visibility: public until first real KB content lands

- **Date:** 2026-05-19
- **Status:** Accepted (retroactive — executed 2026-05-19 ~18:30Z, documented same session)
- **Deciders:** Gal Zilberman + Claude (with independent plan reviewer)

## Context

- GitHub Actions free tier on personal-account private repositories caps at 2,000 runner-minutes per month.
- This project shipped ~30 PR pairs in its first 5 days (created 2026-05-14), each running ~5-7 minutes of CI across the Node lane, gitleaks, Python skip path, retrieval-evals skip path, pr-title, and pr-title-normalize workflows. Nine in-flight dependabot PRs added re-run pressure on top. Estimated consumption breached the 2,000-minute cap on 2026-05-19.
- GitHub Actions began rejecting all runs with: "The job was not started because recent account payments have failed or your spending limit needs to be increased."
- Payment was rejected as a remediation path.
- The next free-tier reset is 2026-06-01 — ~12 days of full paralysis on all CI-gated work.
- Repository audit at flip time: no real committed secrets (only labelled test fixtures in `lib/log.test.ts` exercise the log-helper's redaction); `.env.example` holds only the docker-compose default `DATABASE_URL`; zero `pull_request_target` workflows (the only fork-PR secret-exposure mechanism); single collaborator (`gzion2719`); iron rule #1 in effect.

## Decision

Flip the repository to **public** on 2026-05-19 ~18:30Z. Apply ADR-0002 branch protection (Pass 1 + Pass 2) to `main` and `dev` in parallel with the visibility flip, with `enforce_admins: true` toggled on immediately after — minimizes the "admin can bypass" window on a public repository.

**Supersedes ADR-0002 §"Branch protection" `enforce_admins: false` for the duration of the public window.** When the repository reverts to private, `enforce_admins` reverts to `false` at the same moment (matching ADR-0002's solo-repo rationale that GitHub blocks self-approval).

### Exact branch-protection payload applied (both `main` and `dev`)

```json
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Node — lint, format, types, tests",
      "gitleaks",
      "Validate PR title"
    ]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "required_linear_history": false,
  "allow_force_pushes": false,
  "allow_deletions": false
}
```

Applied via `gh api -X PUT repos/gzion2719/priority-kb/branches/{main,dev}/protection --input <payload>`. `enforce_admins: true` was set in a follow-up `gh api -X POST .../protection/enforce_admins` call.

### Revert trigger

Revert to private **BEFORE EITHER**:

- **(a)** M2a item 8 (Manual smoke: log 3 real Priority Q&A entries end-to-end) is started, **OR**
- **(b)** Any non-fixture real Priority ERP content is committed, ingested, or seeded into a non-test database via any ingestion path (chat UI at `app/admin/ingest/page.tsx`, direct form at `app/admin/ingest/direct/page.tsx`, raw `POST /api/ingest`, or `PUT /api/ingest/[id]`), **OR**
- **(c) Hard date floor:** 2026-06-15 — whichever first.

If (c) fires before (a) or (b), re-affirm the public status in an ADR-0011 amendment (or revert and accept the cost-trim path described in Consequences).

### Mechanical reminder

`scripts/check-repo-public-banner.mjs` is invoked from `npm run check`. When `gh repo view --json visibility` returns `PUBLIC` and the script is running locally (silent under `CI=true`), it prints a loud banner naming this ADR and the revert trigger. Warn-only; never fails the gate. Local-only by design — CI-side noise isn't actionable, and the rule's purpose is to nudge the developer at gate-time.

## Consequences

**Positive.**

- Unlimited free GitHub Actions for the duration of the public window. No further billing blockers from CI volume.
- ADR-0002 branch protection (deferred since 2026-05-14, evidence in the `docs/adr-0002-protection-deferred` branch name) finally executed. First protected-branches PR cycle dogfooded on PRs #4 → #124.
- Dependabot PRs continue running on the public repo; they still need green required checks for merge, and dependabot itself does not auto-merge — the user's merge click remains the gate.

**Negative.**

- Discipline-gated revert. Mitigations: `scripts/check-repo-public-banner.mjs` local reminder; ROADMAP M2a section header + item 8 PRE-STEP amendments; 2026-06-15 hard date floor; this ADR as the named trigger.
- Once forked, forks cannot be un-forked. Anyone who clones during the public window keeps a copy forever; reverting to private blocks future reads only. Accepted given the flip-time audit's "no real secrets, no real data" finding.

**Accepted.**

- Code globally visible during the public window. Current codebase is scaffold + ADRs + prompts + tests — no real Priority ERP data, no real customer information, no production secrets. Normal OSS shape.
- Post-revert, a separate cost-trim PR is queued in BACKLOG (skip Python lane in CI until M2b actually activates the FastAPI worker; drop the retrieval-evals job until M3 wires the golden set; tighten dependabot grouping cadence). Without it, an identical exhaustion will recur on the next post-revert billing cycle.

## Alternatives considered

- **Pay for additional GitHub Actions minutes.** Rejected by the project owner. Cost would have been ~$5-10/month at the current cadence.
- **Wait until 2026-06-01 free-tier reset.** Rejected — 12-day full paralysis on all CI-gated work would freeze every PR (including the dependabot bumps already in flight and the in-progress M2a milestone).
- **Trim CI surface as the sole solution.** Rejected — doesn't help the current billing cycle (cap already hit), and the gate discipline (security + Node CI on every PR) is non-negotiable. Captured as a post-revert follow-up regardless.
- **Stay private permanently with no payment and no CI.** Rejected — defeats the project's standing rule that CI is the gate of record.

## Out of scope, surfaced for separate decision

- **Repo physical location** (`C:\Users\galzi\OneDrive - Afiki-C\Development\Claude\PriorityKB\`) deviates from ADR-0001:15-17's pin to `C:\dev\PriorityKB` off OneDrive. Pre-existing condition unrelated to visibility. Tracked in `docs/BACKLOG.md` under "Architecture & Infra" for a future ADR or migration.

## Cross-references

- [ADR-0001](0001-bootstrap.md) — repo location (contradicted; see "Out of scope" above).
- [ADR-0002](0002-branching-and-merge-policy.md) — branching + protection (the Pass 1 + Pass 2 rollout this ADR executes; `enforce_admins` choice superseded for the public window).
- Iron rule #1 (`CLAUDE.md`) — credentials never committed. Preserved unchanged; flip-time audit confirmed compliance.
- ROADMAP M2a items 3 and 8 — the ingestion paths whose first real-content use is the revert trigger.
- `scripts/check-repo-public-banner.mjs` — local mechanical reminder.
