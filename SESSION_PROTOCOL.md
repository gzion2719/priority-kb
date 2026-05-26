# SESSION_PROTOCOL.md — Priority Knowledge Base

The strict ritual file. The opening ritual fires on the **FIRST user message of any chat** — full stop, no magic word. Greeting, question, work request, emoji, one word — all trigger the ritual.

---

## Opening Ritual

### Step 1 — Greet
One line, warm, in English per `CLAUDE.md` language convention (updated 2026-05-16, see ADR-0007). No Hebrew in output, ever — even when greeting a Hebrew first-message.

### Step 2 — Verify folder mount
Confirm the working folder is mounted; the path should end with `PriorityKB/`. If NOT mounted, request it via the host's directory tool (e.g., `mcp__cowork__request_cowork_directory`) **before any other action** — file reads will fail without it. Confirm to the user **"Folder confirmed: ✅"** before proceeding. This is the self-healing fallback if the user opens a new chat without pre-mounting.

### Step 3 — Confirm WORKFLOW.md in effect
Read it if not already loaded this session.

### Step 4 — Just-in-time orient
Read ONLY:
- `CHATLOG.md` last 3 entries
- `docs/ROADMAP.md`

Defer deeper docs (`docs/AGENTS.md`, ADRs, prompts, eval set) to Step 4b after Step 6 focus is chosen. **Principle: load just-in-time, not just-in-case.**

**Step 4b — ADR/design-document timing sub-rule:** for focuses that are design/ADR work, do the supporting reads (existing code, related ADRs, schema) *before* the Step 7 planning critique — not after. The critique needs the facts to evaluate against.

### Step 5 — Repo state summary
Run `git --no-optional-locks fetch origin main dev` **first**, then `git --no-optional-locks status` and `git branch`. The fetch is non-negotiable before judging merge state — a status/log check against stale remote-tracking refs will flag drift that's already resolved (or miss drift that exists). The `--no-optional-locks` flag prevents stale `.git/index.lock`.

Flag drift: uncommitted changes from previous session, branches ahead/behind, files outside the expected shape.

**Reconstruct-on-drift sub-rule.** If `git log` shows merged work that `CHATLOG.md` doesn't mention, the previous session likely ended without closing (API error, accidental close, network drop). **Offer to reconstruct the missing CHATLOG entry from git + chat transcript BEFORE starting new work** — don't pile new context on top of stale state. Mark the reconstructed entry `RECONSTRUCTED` in its title so the verify-before-recommending sub-rule (Step 6) knows to distrust its `Next session:` line.

**Behind-origin blocks planning sub-rule (codified 2026-05-16).** When `git --no-optional-locks status` reports the local working branch is behind `origin/<branch>` by N>0 commits AND the upcoming session plan depends on file contents (existing rules, ADR numbering, BACKLOG state, ROADMAP checklist position), **block on user-side `git pull --ff-only origin <branch>` BEFORE Step 6 focus selection**. Any plan sized against the stale local view will need full replanning after the pull and waste a planning round. The Cowork sandbox cannot push/pull, so the pull is always a user-side action — surface the exact `git pull --ff-only` command in Step 5's repo-state summary and wait for confirmation before proceeding. **Trigger:** Step 5 status line contains "Your branch is behind 'origin/" → planning halts; pull confirmation gates Step 6. **Origin:** 2026-05-16 audit-import session — opening Step 5 reported 34-commits-behind; I proceeded to plan a 5-commit audit-import against stale CLAUDE/SESSION_PROTOCOL/CHATLOG state; pull surfaced ADR-0004 and ADR-0005 already taken, Step 7b unbiased-review already codified, Plain-English Step 7 already dropped — full replan to a 1-commit audit-import required. One planning round wasted; the rule prevents recurrence.

### Step 6 — Ask for current focus
Use `AskUserQuestion` with 2-3 grounded options. Option sourcing is **ROADMAP-first** per the sub-rule directly below — the CHATLOG entry's `Next session:` line is a non-binding suggestion, not authority.

**Roadmap-first focus sub-rule (codified 2026-05-26).** Step 6 option candidates MUST be sourced primarily from the active ROADMAP milestone — defined as the lowest-numbered milestone in `docs/ROADMAP.md` with at least one **unstarted, unblocked** checklist item. The CHATLOG `Next session:` line is a *suggestion*, never a default; when it names a BACKLOG entry AND the active milestone has an unblocked item, the ROADMAP item is the **Recommended** option and the BACKLOG entry moves to a clearly labeled secondary "side-slice (BACKLOG)" slot (or is dropped if a sibling BACKLOG side-slice already covers the same itch). The "Every 5 sessions backlog review" hygiene cadence (below) surfaces 1-2 BACKLOG items as **secondary** options only — it does not promote them to primary. **Trigger:** every Step 6 focus selection. **How to apply:** (a) walk `docs/ROADMAP.md` top-to-bottom, identify the first milestone with `[ ]` items that are not blocked by an external-state dependency the user has deferred (e.g., per `feedback_adr_0011_revert_deferred`); (b) enumerate that milestone's unstarted unblocked items, pick 2-3 with the smallest first-increment shape, present them as primary; (c) BACKLOG entries appear only after all primary options, prefixed "Side-slice (BACKLOG):" so the framing is explicit. **Origin:** 2026-05-26 session — opening Step 6 surfaced yesterday's bounded BACKLOG alternatives (tooling drift checks + hook absolute-path) as primary while M2b (0/9) and M4 (0/6) sat fully unstarted and unblocked. User pushed back mid-session with the ROADMAP dashboard: "why are we doing unrelated work on the backlog?" The drift was in the framing — `Next session:` from a blocked-strategic-chain session pointed at BACKLOG; the rule should have anchored on ROADMAP regardless. Cross-ref: WORKFLOW.md "Build" archetype (now ROADMAP-only); Recurring Hygiene "Every 5 sessions backlog review" (secondary placement clarified).

**Scope-sprawl audit sub-rule:** if the previous CHATLOG entry's `Next session:` line bundles ≥3 distinct deliverables OR introduces an ADR-worthy architectural surface, present the smaller-cleaner first increment as the **Recommended** option.

**Verify-before-recommending sub-rule.** Before presenting a previous CHATLOG's `Next session:` item as the Recommended option, verify it is still pending. Cheap checks first: `git --no-optional-locks log origin/main origin/dev` for code/merge claims; for visibly-deployable artifacts (running services, dashboards, merged PRs, pushed branches) ask the user one sentence ("is X already live?") rather than trusting the doc. **Especially required when the previous CHATLOG entry is marked `RECONSTRUCTED`** — the reconstruction is built from git + chat transcript, but anything completed after the originating session's API error / context exhaustion appears in neither source, so the `Next session:` line is unverified by definition.

**External-state dependency surface sub-rule (codified 2026-05-17).** When a focus needs inputs only the user can supply — credentials the user holds (cloud subscription keys, OAuth tokens, PAT scopes), data the user holds (real screenshots, internal docs, production samples), or admin actions in systems Claude can't reach (cloud-portal clicks, DNS edits, branch-protection toggles, GitHub App installs) — name the dependency in the option's `description` field at focus-selection time. State explicitly that the session delivers only the scaffold (script, runbook, config, BACKLOG entry) and that the full outcome requires a Phase 2 the user runs. Don't bury the dependency for the Step 7 plan critique — by then the user has already agreed to a session shape the work can't actually deliver, and a round-trip of planning gets spent on a deliverable the user thought was end-to-end. **Trigger:** any focus where the work product cannot be exercised end-to-end with only what Claude has in hand (sandbox + repo + WebFetch + no live secrets / no third-party-system access). **Origin:** 2026-05-17 session — the L21 Hebrew OCR spike planned a "scaffold ships, you run Phase 2" split that wasn't surfaced until the user pushed back ("do it yourself") mid-flow; same session, the release-PR-autocreate side-quest spent a full Step 7 + Step 7b before discovering the PAT-vs-`GITHUB_TOKEN` BLOCKING was the user-side dependency that killed it. Both would have collapsed cleaner with "this needs your hands first" framed at focus-selection.

### Step 7 — Restate + planning self-critique
Restate the chosen focus in one sentence. Then run a **substantive** planning self-critique:
- Is this the most performant + efficient approach?
- Are the iron rules (non-negotiables in `CLAUDE.md`) covered?
- Is there a smaller cleaner first increment?
- Are there missed verification paths (eval set, smoke test, manual check)?
- Does this introduce a new architectural surface that needs an ADR before code?

**Unbiased-review sub-rule (Step 7b).** After the self-critique above and **before** "Wait for go", spawn an INDEPENDENT reviewer via the `review-loop` (a.k.a. `code review`) skill to stress-test the plan. The reviewer receives ONLY the plan text + the relevant rule-file paths — never the conversation, never the reasoning that produced the plan, never past attempts. Apply the skill's standard fix-plan classification (Agree+fix / Agree+defer / Disagree+why) and present the classified findings to the user before applying any of them. The rule fires on **every** Step 7, not just on large plans — trivial focuses get a trivial review, but the review still runs.

**The opt-out is narrow and verbal — it must NAME the review.** Skip only on phrases like "skip the review", "skip Step 7b", "no CR", "no review this time" (or unambiguous Hebrew/English equivalents). Approval phrases like "go", "ship it", "proceed", "yes", "approved", "ok", "go with fixed" **do not opt out** — they approve the existing plan, not the absence of a review. If the user adds new scope after the last review fired ("go, and also do X"), that's a **new Step 7** and the review fires again on the amplified plan. When skipping, say out loud that you're skipping. Codified 2026-05-16; carve-out tightened the same session after Claude rationalized a skip on a scope-amplified plan ("ship + fix red issues + add yellow to backlog") and the user had to call it out — the post-hoc review then caught 4 BLOCKING findings that would have shipped.

**Verify-before-implementing-CR-claim sub-rule (codified 2026-05-18).** When a CR finding asserts a factual claim about external behavior — a spec, framework, library, or platform — verify the claim with a `Read`, `Grep`, or `WebFetch` before implementing code or tests against it. The reviewer is one-shot, has no context, and can be wrong on facts; propagating an incorrect premise produces a test that catches a non-existent bug and fails at gate-time. Cheap verifications are always cheaper than the rewrite round. **Trigger:** a CR finding contains a phrase like "X does/doesn't Y", "the spec says Z", or "API W behaves like V" → verify before applying the fix. **Origin:** 2026-05-18 M2a stub-auth session — plan-CR MAJOR #6 asserted "`Headers.get` does NOT trim" leading/trailing whitespace; the implemented test against that premise failed because the Fetch Headers spec normalizes ASCII whitespace on `set/append`, so the helper never sees padded values. One avoidable test-rewrite round. Cross-ref: Step 7 verify-before-finalize (plan assumptions), Step 7 verify-before-asking (user questions) — same compounding pattern, extended to CR findings.

**"Amplified" covers review-induced plan changes, not only user-added scope.** If the unbiased reviewer returned ≥1 BLOCKING that changed the type system, the schema, an enforcement mechanism (e.g. compile-time → runtime guard), or the shape of a downstream-parsed field, the plan-as-applied differs materially from the plan-as-reviewed and a fresh review fires on the **implemented code** before commit. Two consecutive Step 7b passes per session is the norm, not the exception, on substantive feature work. Judge by the diff between plan-as-reviewed and plan-as-applied — *not* by whether you think the difference feels meaningful. Codified 2026-05-16 (third strike on the same Step 7b skip-rationalization pattern): a log-helper session ran plan-CR (3 BLOCKING + 5 MAJOR), applied all fixes, committed without re-reviewing; the user flagged the skip mid-session; the post-hoc code-CR caught 2 fresh BLOCKING + 5 MAJOR that would have shipped — including a `ts?: never` type-collision gap and a log-channel secret-exfil surface.

Wait for **"go"**. For trivial focuses, a one-line ack is fine; for new content landing in user-facing docs / code modules / architectural decisions, the critique must be a substantive list — not theater.

**Verify-before-finalize sub-rule.** A plan section titled "pre-coding verification" or "open assumptions to check after go" is a smell. If the plan holds N "verify later" assumptions, **answer them with greps/reads BEFORE presenting the plan** for approval — a 30-second `Read` or `Grep` is always cheaper than re-planning when the assumption turns out wrong. If the plan would benefit from a "pre-coding verification checklist," do the checklist now and bake the answers into the plan, not into a future blocker.

**Sub-option scope-split sub-rule (codified 2026-05-23).** When the "smaller cleaner first increment?" leg of the Step 7 critique enumerates 2+ discrete shippable shapes WITHIN a single approval option (e.g., "scope A contains shape A1 + shape A2 + shape A3, any of which is independently mergeable"), present THOSE sub-shapes as the `AskUserQuestion` choices, not the bundled parent option that contains them. The scope-sprawl audit sub-rule (Step 6) is the parent of this rule applied at milestone granularity; this sub-rule extends it to in-session sub-option granularity. **Trigger:** Step 7 self-critique's smaller-increment line names ≥2 discrete shapes inside one option → those shapes become the recommendation candidates in Step 6's user-facing question, NOT the bundle. **Origin:** 2026-05-23 M3 stage E 2c-ii session — the Step 7 critique explicitly enumerated "three discrete shippable shapes inside 2c-ii: (A) orchestrator + matrix only, (B) per-reason retry-prefix + LogEvent only, (C) full bundle"; I presented A bundled as the Recommended option, accepted "go" on it, then had to re-scope mid-implementation after the Step 7b plan-CR's amplifications (async-generator orchestrator + new wire events + +80-110 tests) made the ~2500-2800 line budget visible. The foundation-only ship was the right move but a planning-round-equivalent could have been avoided by surfacing the foundation/orchestrator split at Step 6 — the critique already had the right granularity, the user-facing question didn't carry it forward. Cross-ref: Step 6 scope-sprawl audit (milestone-level parent of this rule).

**Deferred-decision-audit sub-rule (codified 2026-05-21).** When the previous session's CHATLOG entry, PR body, or commit message explicitly defers a design decision to the next session ("decide at planning", "direct fetch or SDK — decide", "TBD"), the Step 7 plan MUST surface that decision as a discrete choice point with the trade-off enumerated BEFORE presenting the plan for approval. Don't silently default to the simpler precedent — that's how Step 7b plan-CR ends up doing the work Step 7 should have done. **Trigger:** previous-session artifact contains a phrase like "decide", "choose", "X or Y", "TBD" naming a design choice → Step 7 plan lists the choice as a discrete bullet with named alternatives + chosen path + 1-line rationale. **Origin:** 2026-05-21 stage-C-reconstruction session — PR #173's body said `direct fetch or @anthropic-ai/sdk (decide at planning)`; Step 7 silently picked direct-fetch via voyage-precedent lazy follow-through; plan-CR Q1 surfaced the SDK alternative + recommended switch. One avoidable planning round; the rule prevents recurrence.

**Verification-layer-matching sub-rule (codified 2026-05-19).** When the focus modifies an infrastructure surface — a GitHub Actions workflow file, a Dockerfile, a `package.json` script, a PreToolUse/PostToolUse hook config, a branch-protection ruleset — the gate selected for verification must EXERCISE the surface being modified. The project's standard pre-push gate (`npm run check`) verifies application code (Node lint/format/typecheck/tests), not infrastructure runtime behavior. Running `npm run check` "green" on a workflow-YAML bump is verifying the wrong layer; the real gate is the workflow itself running successfully on the modified branch. Map gate-to-surface explicitly in the Step 7 plan BEFORE proposing verification. **Trigger:** Step 7 focus touches `.github/workflows/*.yml`, `Dockerfile`, `docker-compose.yml`, `.claude/settings*.json`, branch-protection rulesets, `package.json` scripts, or `*.mjs` hook scripts → the plan names the surface-exercising gate (CI run on the bumped branch, container build + smoke, hook tested via simulated tool call, branch-protection probed via attempted bypass, etc.), NOT a default to `npm run check`. **Origin:** 2026-05-19 dependabot PR #4 verification — initial plan proposed `npm run check` for `actions/checkout@v4→v6`; the Node gate never executes GitHub Actions runners, so "green" would have meant nothing. Plan-CR BLOCKING #1 caught it; revised plan triggered fresh CI on the rebased branch (the real gate), which then empirically refuted the CR's MAJOR #1 risk on all three event surfaces. One avoidable plan-rewrite round; the rule prevents recurrence.

**Goal-quantification extension (codified 2026-05-16, see ADR-0006).** Same sub-rule, applied to measurable goals: when the user states the goal in measurable terms ("save tokens", "faster", "smaller", "fewer X", "more efficient", "cheaper"), the Step 7 plan MUST quantify how the proposed approach delivers on that metric with concrete numbers BEFORE presenting for approval. "This saves ~18K tokens per session orientation" is approval-ready; "this makes the file more readable" is not — readability is a different goal. Without the quantification, a full planning round can run on a proposal that doesn't actually deliver the stated objective; the user has to push back before the design pivots. **Trigger:** user message contains a goal expressed as a measurable quantity (token count, time, file size, error rate, $ saved, etc.) → Step 7 plan presents the predicted delivery on that metric with a defensible number BEFORE the structural description.

**Reconciliation-grep-completeness sub-rule (codified 2026-05-24).** When the focus changes the contract of a function or constant — return type, mapping, default value, enum membership, signature shape — the Step 7 pre-coding verification MUST include a full-repo `git grep` enumerating BOTH direct callers AND 1-hop transitive callers (the functions / consumers that call the modified function inside non-test code, then the test files that exercise THOSE consumers). A hand-picked grep across a sampled set of test files is insufficient and ships test-suite incompleteness to CI. **Trigger:** Step 7 plan touches a function or constant whose contract is consumed across the repo → pre-plan verification is `git grep -E "<modifiedFn>|<consumer1>|<consumer2>"` covering every 1-hop consumer named at the production call sites, NOT just a sampled set of files the author remembers. **Origin:** 2026-05-24 sensitivityAllowedForRole reconciliation — pre-plan grep was hand-picked across `lib/auth.test.ts` + `lib/entries.test.ts` + a couple of others; missed `tests/entries.integration.test.ts` which uses `findEntryForRole` (a 1-hop consumer of `sensitivityAllowedForRole`); CI on #208 caught it, requiring fixup commit `3875a3c` + a second CI cycle. Plan-CR M2 had explicitly flagged surface completeness as a stress-test axis but the reviewer also missed the surface — so this rule is the author-side floor, not a reviewer-side one. Cross-ref: Step 7 verify-before-finalize (plan-internal assumptions, same author-side discipline applied to plan content rather than surface enumeration).

**Mechanical-floor-surface-enumeration sub-rule (codified 2026-05-25).** When the focus ships a mechanical floor that asserts an invariant across multiple surfaces (e.g., "these N files must declare the same allowlist", "every audit row matching pattern P must carry field F"), the Step 7 pre-coding verification MUST include a full-repo grep for the literal value being enforced. BACKLOG framings name surfaces known at write-time; actual surfaces may have grown since. Anchoring scope on the BACKLOG line ships a floor with a coverage gap that's worse than no floor — it confers false reassurance that the named surfaces are aligned while the unknown surfaces drift silently. **Trigger:** Step 7 plan ships a script asserting "these N files match" or "every X has Y" → before Step 7b, grep the literal across the repo and reconcile the plan's named surfaces against the grep output. **Origin:** 2026-05-25 type-enum drift floor session — initial plan covered 2 surfaces per BACKLOG line 124 framing; plan-CR caught 2 more (`pr-title-normalize.yml` regex is load-bearing; missing it would silently skip Layer 2 normalization for new types). Cross-ref: Step 7 verify-before-finalize (the parent rule this specializes), Step 7 Reconciliation-grep-completeness (the same discipline applied to contract changes rather than surface enumeration).

**Platform-capability-empirical-check sub-rule (codified 2026-05-25).** When shipping tooling that assumes a third-party platform (GitHub, Anthropic, Voyage, Postgres, etc.) supports operation X on resource type Y under plan tier Z, the Step 7 pre-coding verification MUST empirically confirm the capability — via docs fetch, a one-line API probe, or a sandbox experiment — BEFORE the plan is finalized. Trusting an ADR's framing ("this should work") or a precedent ("we use this elsewhere") is not sufficient when the platform's behavior is plan-tier-conditional or undocumented in the local ADR. The 30-second empirical check is always cheaper than discovering mid-execution that the assumption was wrong and recovering. **Trigger:** Step 7 plan calls a third-party API in a context (plan tier, account type, resource visibility) the ADR doesn't already empirically demonstrate works → verify before committing the plan. **Origin:** 2026-05-25 ADR-0011 revert-tooling session — plan + script + plan-CR all assumed GitHub's `branches/.../protection` REST API works on private personal-account repos. GitHub Free does NOT expose this API on Private; flipping to private wiped branch protection and the recovery (re-public + re-apply payload + ship a Free-plan trap guard in a follow-up PR) absorbed a full session-leg. A `gh api repos/{owner}/some-private-test-repo/branches/main/protection` probe before the visibility flip would have surfaced the trap in seconds. Cross-ref: Step 7 verify-before-finalize (parent rule).

**Verify-before-asking sub-rule.** Before asking the user *any* clarifying question — whether via `AskUserQuestion`, an inline prose question, or a "let me know if…" hedge — first try to answer it yourself with `Read`, `Grep`, `Glob`, or `git log/diff`. If the answer lives in the repo, find it; don't pay the user-round-trip tax to surface what a 5-second tool call would. Ask only when the answer genuinely isn't local: a *preference* between two viable options the repo can't disambiguate, a *fact about external systems* (production state, an org decision, an in-flight conversation), or an *intent* only the user holds. This is the user-facing twin of verify-before-finalize: the same "30-second tool call beats the next round-trip" math applies to questions, not just to plan assumptions. Concrete failure mode: asking "is feature X already deployed?" when `git log origin/main` or a quick `gh pr list --state merged` would answer it without involving the user.

---

## Recurring Hygiene Rituals

- **Every 5 sessions** (CHATLOG entry count divisible by 5): backlog review — read `docs/BACKLOG.md`, surface 1-2 ripe items as **secondary** Step 6 options (per the Roadmap-first focus sub-rule above — BACKLOG items are side-slices, never primary).
- **Every 10 sessions**: CHATLOG archival — keep the most recent 5 entries active in `CHATLOG.md`; move older routine entries to `docs/CHATLOG_ARCHIVE.md` newest-first. Keep entries with decisions / non-obvious learnings / gotchas in place. **When in doubt, keep.**
- **Sandbox git reads use `git --no-optional-locks`** — prevents stale `.git/index.lock` on Windows + OneDrive-adjacent setups (the repo lives at `C:\dev\PriorityKB`, off OneDrive, but the rule stands).
- **Pre-push gate:** `npm run check` (Node side) + `make py-check` (Python side, when M2b adds Python). See `WORKFLOW.md` for the exact contents — must mirror `.github/workflows/ci.yml`.

---

## ADR Discipline

ADRs live in `docs/adr/NNNN-<slug>.md`. Number monotonically. The README at `docs/adr/README.md` is the index.

- **ADR-with-new-types sub-rule:** ADRs that introduce frozen dataclasses / TypedDicts / Zod schemas with structural invariants get a **10-line type skeleton inline** in the Decision section *before* the prose.
- **Test-helper-signature sub-rule:** ADRs that prescribe a test-helper / fixture signature change include the **new signature as a code skeleton** in the Decision section, not just a prose description.
- **ADR/design-document timing sub-rule:** (cross-ref Step 4b) for ADR work, supporting reads happen before the planning critique.

---

## Closing Ritual

**When to run.** Triggered by ANY **explicit farewell phrase** from the user — "תודה על היום", "see you tomorrow", "we're done", "let's call it", "thanks", a goodbye emoji, anything that explicitly signals end-of-session. Don't just say goodbye; **run the ritual**.

**What does NOT trigger the ritual.** Status updates, completion-adjacent signals, command outputs, URL shares, screenshots of finished work, "done" reports on a sub-task. These look like wrap-ups but they're progress signals — keep working, ask what's next. The user must explicitly farewell. If unsure, ask "wrap up, or keep going?" rather than assume. (Codified 2026-05-14 after the bootstrap session treated a GitHub URL share as a farewell.)

**Why it exists.** The closing ritual is NOT a session diary. It exists to make the **NEXT session's first 60 seconds frictionless**: read the last 3 entries, know exactly where we left off and where to look for detail. The orientation chain reads it every chat. Each entry's job is "where we left off, what the open question is, where to look for the detail." Compounding is the whole game — one concrete improvement per session × 200 sessions = a system that runs perfectly with zero friction.

### Pre-flight — step-completeness check (codified 2026-05-16, see ADR-0006)

Before executing Step 1, mentally enumerate all closing-ritual steps and confirm each will fire: Pre-flight, Step 1 (retrospective + Session Score + Goal-delivery verification), Step 2 (compose CHATLOG entry), Step 3 (write to disk), Step 4 (git status), Step 5 (handoff message — gate-first or worktree-override shape per `WORKFLOW.md`), Step 6 (warm close). If any step's wording has been amended since the last firing, re-verify the wording before executing. **Trigger:** any farewell signal → enumerate before Step 1 starts.

### Step 1 — Retrospective (the most important step)

Before writing anything for the record, take a structured look at the **session itself** — not the work product. Three bullets, in your head or on screen:

- **What worked:** moves that were efficient, decisions that paid off, friction we successfully avoided.
- **What didn't:** protocol slips, dead ends, things we redid, places we read/wrote/checked things we didn't need, over-engineered fixes.
- **Improvement for next session:** ONE concrete, actionable change. A protocol tweak, a habit shift, a new rule of thumb.

**Session Score (codified 2026-05-16, see ADR-0006).** After the three retrospective bullets, compute and display a score. The score is a self-assessment instrument — its purpose is to make waste visible and create pressure to improve over time. A perfect session scores 10/10. Three axes, each scored independently:

| Axis | Max | Scoring |
|------|-----|---------|
| **Code quality** | 4 | Start at 4. −1 per gate-failure round (local `npm run check` OR CI red) beyond the first. −1 if a sandbox check that should have caught a bug didn't run before handoff. Floor 0. |
| **Protocol compliance** | 3 | Start at 3. −1 per protocol slip — Step 7b skip-without-reason, wrong gate-first commit-block shape, Two-PR rule miss, missing PR-title-precheck self-check, proactive recap without farewell, etc. Floor 0. |
| **Efficiency** | 3 | Start at 3. −1 per wasted token cluster — unnecessary re-read of a file already in context, dead-end approach that had a known-better path, back-and-forth caused by an avoidable assumption. Floor 0. |

Display format (show after the three retrospective bullets, before the improvement write-up):

| Axis | Score | Deductions |
|------|-------|------------|
| Code quality | X/4 | reason, or — |
| Protocol compliance | X/3 | reason, or — |
| Efficiency | X/3 | reason, or — |
| **Total** | **X/10** | |

**Ceiling:** [one sentence — the specific change that would raise this score to 10/10 next session]

Rules:
- Be honest. Inflation makes the score useless. A 6/10 that identifies the right deductions is worth more than a 9/10 that papers over them.
- The Ceiling line is the most actionable part — single, concrete, next-session-executable change, not a vague aspiration.
- The score feeds the improvement: if the deductions are codifiable as a rule, write the rule. If not, the Ceiling line becomes the CHATLOG `Process improvement` bullet.
- A score of 10/10 is rare — only when the session was genuinely clean: first-attempt code passed `npm run check`, no protocol slips, no wasted reads.

**Goal-delivery verification sub-rule (codified 2026-05-16, see ADR-0006).** When the session's stated goal included a measurable target (token savings, performance improvement, file size reduction, error rate, etc.), Step 1 MUST verify actual delivery with concrete numbers BEFORE composing the CHATLOG entry. Run the measurement (`Read` for file size, benchmark, coverage diff — whatever fits), state before/after numbers, confirm whether the target was met. "Savings confirmed" without a number is not acceptable. This is the closing-leg mirror of the Goal-quantification extension under Step 7 Verify-before-finalize: if the session committed to a number at open, it verifies the number at close. **Trigger:** the session's `Step 6` focus or any user message during the session named a measurable goal → Step 1 includes a measurement block before the three retrospective bullets.

The improvement is the OUTPUT, and it has two possible homes:

1. **Codifiable as a rule** (it almost always is) — edit the relevant file **IN THIS SAME SESSION** (`SESSION_PROTOCOL.md`, `CLAUDE.md`, `WORKFLOW.md`, an ADR, etc.). The edit IS the improvement; don't write a separate description of it. **Before editing, do a conflict check:** grep the file for related rules, confirm the new wording doesn't contradict anything already there.
2. **Not yet codifiable** (an observation we want to remember but can't yet generalize) — keep it as the CHATLOG bullet only.

Either way, ALWAYS add a `**Process improvement:**` bullet to the CHATLOG entry. If genuinely none, say `none this session` explicitly — never silently skip. Future-Claude needs to know we looked.

Show the user the proposed improvement (and any file edits) before moving on. They approve or refine.

### Step 2 — Generate the CHATLOG entry

Compose a 3-5 bullet summary in this **exact** format:

```
## YYYY-MM-DD — <session title>
- <What we did, bullet 1>
- <What we did, bullet 2>
- <Key decision or learning>
- <Any blockers or open questions>
- **Process improvement:** <what we changed and which file, OR "none this session">
- **Next session:** <one sentence on what's first>
```

Constraints — enforced, not aspirational:

- **Max 5 content bullets** plus the two trailing ones (`Process improvement` + `Next session`). 7 lines total under the date header. If the session genuinely produced more than 5 distinct points, pick the 5 most useful for next session's orientation.
- **Each bullet ≤ 2 sentences.** If a bullet wants to be 4 sentences, the second half belongs in a rule file, an ADR, or BACKLOG — not the CHATLOG.
- **`Process improvement` is a 1-line pointer**, not a retelling. The file edit IS the improvement; the bullet exists to make it discoverable. Format: `Rule X gained Y sub-rule (see <file>)` or `ADR-NNNN written, see <path>`.
- **Don't re-tell bug stories that live elsewhere.** If a bug birthed a sub-rule, the rule file has the imperative + concrete trigger + date pointer; the CHATLOG entry has at most one sentence on what was caught and where the rule lives.
- **No "compounding scoreboard" / meta-reflection bullets.** Reflective meta-content about which codifications fired is closing-ritual reflection value (Step 1), not next-session orientation value (Step 2). Think it once during retrospective, then don't write it.

### Step 3 — Write the entry to CHATLOG.md

Insert the new entry directly below the header / `---` separator, **before** any existing dated entries (newest-first ordering). Show the user the entry you wrote.

### Step 4 — Report uncommitted work

Run `git --no-optional-locks status` from the project root. List the changed/new files and suggest a commit message.

### Step 5 — Give the exact commands the user needs (gate-first)

Don't assume the user will remember. The handoff message **LEADS** with the gate-first bash block — first content block, before any prose summary, before any file list, before any closing-trigger nudge.

```
cd "C:\dev\PriorityKB"
npm run check                     # Node gate — mirrors .github/workflows/ci.yml
# make py-check                   # Python gate — uncomment once M2b adds Python
git add <files>
git commit -m "<suggested commit message>"
git push -u origin <feature-branch>
gh pr create --base dev --title "<conventional-commit-style title>" --body "..."
```

**Then the canonical PR-pair handoff (non-negotiable shape).** Immediately after the gate block, render the PR pair(s) and session summary in this exact shape — see also the feedback memory `feedback_pr_handoff_shape.md`:

```
Session closed. N PR pair(s) to open + merge:

**1. <change name / branch scope>**
- [feature → dev](https://github.com/gzion2719/priority-kb/compare/dev...<branch>) — title: `<type>(<scope>): <subject>`
- [dev → main](https://github.com/gzion2719/priority-kb/compare/main...dev) — title: `release: dev → main (<one-line scope summary>)`

**2. <second logical change, if any>**
- [feature → dev](https://github.com/gzion2719/priority-kb/compare/dev...<branch-2>) — title: `<type>(<scope>): <subject>`
- [dev → main](https://github.com/gzion2719/priority-kb/compare/main...dev) — title: `release: dev → main (<one-line scope summary>)`

[Then deploy block — OMIT entirely until M5 hosting lands.]

Session summary:
- <commit SHA(s) + what each did>
- <key diagnosis / decision>
- <new artifacts: files / methods / tests>
- <test count + lint status with ✅ when green>
- Process improvement captured in CHATLOG: <one-line pointer>
```

Compare URLs are **clickable markdown links** (`[label](url)`), never bare code blocks — a code block is not clickable and forces copy-paste, exactly the friction the shape eliminates. The gate-first `bash` block above STAYS a code block; only the PR URLs become links.

**Two-PR rule — enforced every time, no exceptions.** Every PR pair MUST include BOTH links (feature → dev AND dev → main) in the same message. Never give one without the other. If the `dev → main` promotion is being batched with a future session, say so explicitly in one line under the pair — but the link still appears.

**Mechanical pre-send self-check.** Re-read the draft before sending. If `git push` appears, the draft MUST also contain (a) `npm run check` earlier in the same message, AND (b) the PR pair(s) with both clickable compare links each, AND (c) a `type(scope)?: lowercase-subject` title proposal beside *every* PR link. If any of (a)/(b)/(c) is missing, fix the draft before sending. Applies to ANY "ready to commit" handoff. The PR-title shape is enforced mechanically by the Claude Code `PreToolUse` hook on `gh pr create` (`scripts/hook-gh-pr-create-precheck.mjs`) and the server-side normalizer (`.github/workflows/pr-title-normalize.yml`); see ADR-0004 for the design and bug history.

**Title-allowlist sub-rule.** PR titles must satisfy `commitlint.config.cjs` (which is also the source of truth for `.github/workflows/pr-title.yml`). Run `node scripts/precheck-pr-title.mjs "<title>"` to check. The `dev → main` release PR uses `release: dev → main (<scope summary>)`; the server normalizer rewrites mismatches. See ADR-0004 for the layered design.

**Worktree-mode override sub-rule.** When the session ran inside `.claude/worktrees/<name>/`, Claude runs the gate, the commit, the push, and `gh pr create` for both legs of the PR pair itself via the Bash tool from inside the worktree, before sending the handoff message. The user-facing message drops the gate-first bash block and leads with: a one-line confirmation that Claude ran gate + commit + push + PR creation (commit SHA + branch + PR numbers), then the PR pair as clickable links to `/pull/<N>` (not `/compare/` URLs), then (post-M5) the deploy block, then the session summary. The mechanical pre-send self-check above still applies — vacuously for clauses (a) and (c): in worktree mode `git push` will not appear in the draft, and titles were baked in at creation time (the inline `— title:` annotation may be dropped). Two-PR clickable-links requirement remains in full force regardless of mode.

**Tooling-denial fallback sub-rule.** If `gh pr create --base main` is denied or fails for any tooling reason, Claude does **not** fall back to handing the user a GitHub `/compare/main...dev` URL — the UI default title (`Dev`) fails the gate. Instead Claude (1) surfaces the denial in one sentence, (2) writes the PR body to a stable path (e.g. `/tmp/release-pr-body.md`) and tells the user the path, and (3) hands the user the exact `gh` one-liner to paste: `gh pr create --base main --head dev --title "release: dev → main (<scope summary>)" --body-file <path>`. The prohibition on compare URLs is absolute for the `dev → main` leg. See ADR-0004.

**Never push to `main` directly** (see ADR-0002). Feature branches PR to `dev`; `dev` is promoted to `main` via a separate `release: dev → main` PR. Hotfixes are the only exception — `hotfix/<slug>` PRs target `main`, then immediately back-merge into `dev`. If a commit was created on `main` locally by accident, rewind `main` to `origin/main` and re-point the commit to a feature branch BEFORE pushing.

The gate is a verbatim mirror of the project's CI job. Running it locally before pushing catches red CI in seconds rather than minutes-plus-roundtrip; that's why it leads.

### Step 6 — Close warmly

One line, in English per `CLAUDE.md` language convention (updated 2026-05-16, see ADR-0007). No Hebrew in close-line, ever.

(The previous "Plain-English recap" Step 7 was dropped 2026-05-16 — the CHATLOG bullets already cover what each session did, and the recap was read at close and approximately never again. Removing it keeps the closing handoff tighter.)

---

## Session-wide rules

These fire throughout a session, not lifecycle-bound to opening or closing. Imported 2026-05-16 from external operating-rules audit (ADR-0006).

### Context-exhaustion early-close

When the user explicitly flags context length ("we're running out of context", "context is getting long", or unambiguous equivalent), Claude MUST: (1) STOP immediately — no new tool calls, no new work items, no new suggestions; (2) run the full closing ritual (Pre-flight + Steps 1–6) as the very next action; (3) only after CHATLOG is written and the gate-first commands + PR pair are handed off does the session end. Continuing new work after a context warning is a protocol violation. **Trigger:** any explicit context-length warning from the user.

---

## Worked example

(Hypothetical M2a session — text-only ingestion working end-to-end.)

User says: "thanks, that's enough for today."

You produce:

> **Step 1 — Retrospective.** Worked: stub auth let us focus on the ingestion path without Entra ID friction; the prompt-hash idea landed cleanly. Didn't: I read `docs/AGENTS.md` upfront instead of deferring to Step 4b — paid a 30-second tax for no gain. Improvement: codify the deferral explicitly — `docs/AGENTS.md` is Step-4b territory, not Step-4.
>
> **Step 2 — Entry:**
>
> ```
> ## 2026-05-21 — M2a text-only ingestion E2E
> - Ingestion API route accepts {title, body, category, tags, source, last_verified_at}; stores entry + chunks + embeddings.
> - Prompts now live in prompts/ingestion-agent.md; SHA-256 hash stored on each entry's audit row.
> - voyage-3-large wired in via embedding abstraction; embedding_model + embedding_version columns populated.
> - Stub auth header `x-stub-user-role: admin` gates writes; real Entra ID deferred to M5.
> - **Process improvement:** SESSION_PROTOCOL.md Step 4 gained the AGENTS.md-is-Step-4b clarification (see SESSION_PROTOCOL.md Step 4).
> - **Next session:** evals/golden_set.yaml seed — 10 Hebrew + 10 English Q/A pairs with expected source IDs.
> ```
>
> **Step 3 — Inserted** into CHATLOG.md below the `---` separator, before the most recent dated entry.
>
> **Step 4 — Uncommitted:** `CHATLOG.md` (+10), `SESSION_PROTOCOL.md` (+2), `app/api/ingest/route.ts` (new), `prompts/ingestion-agent.md` (new), `db/migrations/0003_entries.sql` (new).
>
> **Step 5 — Commands:**
>
> ```
> cd "C:\dev\PriorityKB"
> npm run check
> git add CHATLOG.md SESSION_PROTOCOL.md app/api/ingest prompts/ingestion-agent.md db/migrations/0003_entries.sql
> git commit -m "feat(ingest): M2a text-only ingestion E2E + prompt-hash audit"
> git push
> ```
>
> **Step 6 — See you tomorrow.**
