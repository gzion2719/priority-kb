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

## Amendment 2026-05-25 — Revert tooling shipped

Revert tooling lives at [scripts/revert-to-private.mjs](../../scripts/revert-to-private.mjs), wired as `npm run revert:private` (dry-run default; `npm run revert:private -- --apply` to execute). Idempotent — re-runs against partial state heal only what's still drifting.

The script's surgical-DELETE approach preserves `required_status_checks.strict=false` (ADR-0002 §"Required-checks `strict` policy" amended 2026-05-20) and the three required contexts (Node — lint, format, types, tests / gitleaks / Validate PR title), then verifies them post-execute. On success, the script appends an `## Amendment — Revert executed` block to this file with timestamp, post-state per branch, and a fork list (`gh api .../forks --jq .[].full_name`). Idempotent on the writeback too (skips if the block is already present).

**Residual billing amplifier (consciously deferred).** The post-revert cost-trim wave 1 shipped 2026-05-21 (no-op `python` + `evals` lanes deleted, dependabot grouped). The `e2e` lane (added 2026-05-29 per ADR-0014) now runs in parallel with the `node` lane on every PR — Postgres service + `npm run build` + `next start` subprocess; ~2-3 min/run. Wave 2 trims (security.yml weekly cron, pr-title-workflow merge, e2e gating to `pull_request` only) stay queued in BACKLOG and fire on first observed billing recurrence post-revert. A 7-day billing-delta measurement via `gh api /repos/.../actions/billing/usage` is the empirical trigger.

**Execution gating.** None of §"Revert trigger" conditions (a)/(b)/(c) has fired as of tooling-ship. The script may be run any time per the user's discretion; intended execution moment is "just before starting M2a item 8."

## Amendment 2026-05-25 — Free-plan private-trap: revert blocked

**Discovery.** Same session as the tooling ship: `--apply` was executed end-to-end against the real repo. Step 1 (visibility flip PUBLIC → PRIVATE) succeeded. Step 2 (`DELETE /repos/.../branches/main/protection/enforce_admins`) returned **HTTP 403 — "Upgrade to GitHub Pro or make this repository public to enable this feature."** Subsequent GETs on `/protection` also returned 403. The visibility flip itself had auto-removed the ADR-0002 §Decision protection rules with no API path to restore them on Free + Private.

**Root cause.** GitHub Free does NOT expose the `branches/{branch}/protection` REST API on private personal-account repositories. The §Decision payload assumed protection would remain API-managed across the public ↔ private boundary — false on Free. Documented by GitHub at the same 403 message URL.

**Immediate recovery.** Repo flipped back to PUBLIC via `gh repo edit ... --visibility public --accept-visibility-change-consequences`; protection re-applied verbatim from the §Decision JSON payload (`gh api -X PUT .../branches/{main,dev}/protection --input <payload>`). Post-recovery state matches §Decision exactly: `strict=false`, 3 contexts, `enforce_admins=true`, force-push + deletion disabled on both branches. Net session effect: zero state change to the repo, one important finding captured.

**Revised revert decision.** Stay PUBLIC until one of:
- **(i)** GitHub Pro is purchased (~$4/month) — restores private-repo branch-protection API access; revert tooling works as designed.
- **(ii)** Cost-trim wave 2 + e2e-lane gating drops public-window CI consumption below the cap with margin — revert no longer needed.
- **(iii)** M2a item 8 forces the hand; user accepts unmanaged protection on private (mechanical PreToolUse hooks become the *only* floor) and runs `npm run revert:private -- --apply --i-accept-free-plan-trap`.

The original §"Revert trigger" (a)/(b)/(c) is amended to require ALSO satisfying one of (i)/(ii)/(iii) before the revert fires.

**Script hardening (same fix PR).** `scripts/revert-to-private.mjs` gained `detectFreePlanPrivateTrap({planName, visibility})` precondition check that runs BEFORE the visibility flip. Reads `gh api user --jq .plan.name`; aborts with exit 1 + actionable message when plan is Free and visibility is PUBLIC. Bypass flag `--i-accept-free-plan-trap` exists for option (iii) above. Stub via `REVERT_STUB_USER_PLAN_NAME` for tests.

**Cross-refs.**
- ADR-0002 §"Branch protection" — the protection-rules contract that this finding shows is unenforceable via API on Free + Private.
- BACKLOG "Post-revert: `e2e` CI lane billing watch" — wave-2 trim queued; relevant to option (ii).
- The `scripts/check-repo-public-banner.mjs` warning remains accurate — public window persists indefinitely until one of (i)/(ii)/(iii) is satisfied.
