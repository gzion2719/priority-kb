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

## Python pre-push

Rules imported 2026-05-26 from `docs/PYTHON_RULES_DRAFT.md` per [ADR-0016](docs/adr/0016-python-rules-adoption.md). Path-adaptation convention: `src/` → `api/`; `tests/` unchanged; `requirements-dev.txt` → `pyproject.toml [project.optional-dependencies].dev`. Most rules trigger from M2b #2 onward (when `api/` lands); the first substantive Python-touching PR walks this list and demotes non-firing rules to BACKLOG per ADR-0016 §Mitigations.

Lineage convention: each rule below carries either `Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016)` (DRAFT-sourced) or `Synthesized 2026-05-26 in ADR-0016` (net-new mirrors of CLAUDE.md non-negotiables, no DRAFT origin).

### §1 — Adopted verbatim from DRAFT Bucket 1

<a name="py-immediate-black"></a>
**Immediate black after each edit.** After every `Edit` / `Write` on a `.py` file, run `python -m black --fast <file>` in the same message. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-zip-strict"></a>
**`zip()` strict parameter at write time.** Every `zip()` call must include `strict=True` or `strict=False`. Ruff B905 fires deterministically on bare `zip(a, b)`. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-nested-with-flatten"></a>
**Nested-`with` SIM117 flatten at write time.** When the outer `with` block's body is only an inner `with` statement, flatten to `with A, B:` immediately rather than waiting for the linter. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-type-ignore-code"></a>
**`# type: ignore` code verification.** Read mypy's exact error code from output; never guess `[return-value]` vs `[no-any-return]`. The wrong code is no suppression at all. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-trailing-whitespace"></a>
**Trailing-whitespace grep on text edits.** Before declaring any `Edit` to a non-`.py` file done, `grep -n " $" <file>`. (Already implicitly applies to PriorityKB's `.md` edits today; codified explicitly when Python lands.) *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-pep563-unquoted"></a>
**PEP-563 unquoted-annotation check.** When a file opens with `from __future__ import annotations`, never quote forward-reference annotations (ruff UP037 fires on `def f(x: "Foo")` when `Foo` could be bare). *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-black-linelength-sync"></a>
**Black line-length sync.** Before any manual line-length check, `grep "line-length" pyproject.toml` (the project's pinned line length may differ from black's default 88). *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-black-version-sync"></a>
**Black version sync.** Run `python3 -m black --version` and compare against the pin in `pyproject.toml [project.optional-dependencies].dev` before sandbox black checks. A version-mismatched local black "passes" a file CI's black will reformat. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-black-diff-first"></a>
**Black `--diff` first diagnostic.** When pre-push fails on black, first action is `python -m black --diff <file>` — never read the file and guess at the reformat. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-i001-ruff-fix"></a>
**I001 repair: always `ruff --fix` first.** Never manually re-sort imports; ruff's isort rules are not reliably hand-reproducible (group ordering, type-checking blocks, conditional imports). *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-smoke-test-fidelity"></a>
**Smoke-test fidelity.** When pytest can't run in the sandbox and you fall back to a stdlib mirror, the mirror MUST use the same assertion mode as the real test (e.g., `re.search(PATTERN, str(e))` not substring `in`). A relaxed mirror that passes on substring while pytest requires regex match is worse than no smoke test. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-untyped-library-call"></a>
**Untyped-library call annotation.** Before annotating direct method calls with `# type: ignore[no-untyped-call]` on a `[[tool.mypy.overrides]] ignore_missing_imports = true` library, verify the method actually is untyped via the installed source. The library may have shipped stubs that the override masks. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-sandbox-ruff-sweep"></a>
**Sandbox ruff pre-handoff sweep.** When a session touches 4+ Python files, run `python3 -m ruff check <all-edited-files>` after all edits, before the handoff message. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-registry-test-sweep"></a>
**Registry test sweep.** Whenever a registry-style dict's keys are mirrored by an `assert set(d.keys()) == ...` test assertion, grep the test file for that assertion before declaring done — registry additions silently break the assertion's expected-set membership. (Adapted from DRAFT's YuTom-named `EVENT_PAYLOAD_TYPES` rule; generalised to any registry pattern.) *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

### §2 — Adopted with PriorityKB-generic phrasing from DRAFT Bucket 2

Bucket 2 rules originally named YuTom-specific classes / fields / commands; the imperative is generic and lifted here with PriorityKB-generic surface phrasing. Triggers that name a surface not yet present (`api/`-defined class, FastAPI worker) carry `(Trigger fires from M2b #2 onward when api/ lands)`.

<a name="py-third-party-special"></a>
**Third-party-library special case + first-call extension.** Before patching against a third-party lib (or making the first call to any newly-added library), inspect installed source. `pip show <pkg>` finds the path; read at least the function being called before assuming behaviour. *(Trigger fires from M2b #2 onward.) Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-sibling-bug-sweep"></a>
**Sibling-bug sweep.** When a Python pre-push check catches a bug, grep sibling files (same directory, same module pattern) for the same bug shape and fix in the same commit. The same protocol slip rarely lives in only one file. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-unsupported-promotion"></a>
**Unsupported-to-supported promotion sweep.** When a value is promoted from "raises `ValueError`" to "fully supported," grep the entire test suite for the literal — existing tests asserting the rejection path will silently invert. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-internal-type-grep"></a>
**`api/`-internal type construction grep + `__post_init__` validator scan + attribute-access extension.** Before constructing any `api/`-defined class in a test, grep its `__init__` / dataclass field list to verify exact kwarg names AND its `__post_init__` for value-range validators AND its attribute fields for any `obj.field` assertion in tests. Three reads, one commit. *(Trigger fires from M2b #2 onward.) Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-prod-kwarg-sweep"></a>
**Production-call-site kwarg sweep.** When adding new kwargs to an existing class `__init__`, grep ALL constructor call sites (including `scripts/` and one-off integration helpers). A new required kwarg without a default breaks every caller silently at runtime, not at type-check time if mypy is loose. *(Trigger fires from M2b #2 onward.) Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-composite-string-assert"></a>
**Composite-field string assertion.** Before asserting `payload[field] == "exact_string"`, read the composite's source for string transformation (case, strip, normalisation). Asserting the input value against an output that's been NFC-normalised or lower-cased is a vacuous test. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-helper-completeness"></a>
**Test-helper constructor-completeness check.** When writing a new test helper that wraps a class constructor, read the class's `__init__` signature and verify every kwarg is either forwarded or intentionally omitted with a comment. A helper that silently defaults a kwarg the class actually requires is a test-time foot-gun. (Adapted from DRAFT's YuTom-named `make_xxx_agent` rule.) *(Trigger fires from M2b #2 onward.) Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-test-class-alias"></a>
**`Test*`-class import alias.** When a test file imports a class whose name starts with `Test`, alias it at import (`from foo import TestThing as TestThingImpl`) to avoid pytest's auto-collection treating it as a test class. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-autouse-patch-consistency"></a>
**Autouse-fixture patch-mechanism consistency.** Mixed-mode patching (fixture via `unittest.mock.patch`, override via `monkeypatch.setattr`) produces unclear teardown ordering. Pick one mechanism per fixture and stay with it. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-counter-race-isolation"></a>
**Periodic-counter race isolation + wall-clock-triggered reset extension.** Tests asserting accumulated counter state must set the reset interval to a safely long value (e.g., 1 hour) so that a slow test run doesn't cross a reset boundary. Tests of UTC-hour-triggered resets must use a trigger hour (e.g., 03:00 UTC) that doesn't fire during typical test-run wall-clock times. *(Trigger fires from M2b #2 onward.) Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-utc-test-anchor"></a>
**UTC/local timezone mismatch in test anchors.** Tests setting a date/time anchor that pairs with UTC-using production code MUST use `datetime.now(UTC).date()`, never `date.today()`. A `date.today()` anchor silently passes near midnight UTC and silently fails the day after across the dateline. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-filter-kwarg-alignment"></a>
**Filter-kwarg default alignment across helper + factory.** When adding a filter kwarg that gates which events / records reach an inner domain object, verify defaults align across the test helper and the snapshot/factory before writing tests. A helper that defaults `include_X=False` paired with a factory that defaults `include_X=True` produces inverted assertions per test class. (Adapted from DRAFT's "bus-citizen filter parameter alignment".) *(Trigger fires from M2b #2 onward.) Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-side-effect-grep"></a>
**Side-effect addition grep.** When a previously-pure method gains a state-mutating side effect, grep existing tests for equality assertions on its return value. Tests asserting "same input → same output" silently fail when the method also mutates an enclosing object. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-cross-cutting-recon"></a>
**Cross-cutting reconciliation file-enumeration sweep.** For any reconciliation spanning multiple files of the same shape (e.g., "every `api/*/handlers.py` declares the same response schema"), run a structural `git grep` across each candidate directory; don't rely on prior enumerations. The set of files of a given shape grows monotonically and a hand-picked list silently misses additions. (Same surface-completeness discipline as the Reconciliation-grep-completeness sub-rule under Step 7.) *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-wallclock-deterministic"></a>
**Wall-clock → deterministic transition grep.** When changing a function from wall-clock-dependent to deterministic, grep the test file for `datetime.now` / `time.time` / `time.monotonic` near the affected class. Tests that pinned a wall-clock anchor against the old behaviour will pass for the wrong reason against the deterministic replacement. *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

<a name="py-silent-zero-guard"></a>
**Silent-zero-result guard in smoke tests.** When running any function that produces a count / metric in a smoke test, assert `count > 0` (or the expected non-zero) before reading derived metrics. A silent-zero return produces division-by-zero or vacuous `mean(0)` downstream that masks the upstream failure. (Reframed from DRAFT's "backtest zero-trade guard".) *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

### §3 — Sandbox-disk text-edit close-time verify (Bucket 3 partial promotion)

<a name="py-sandbox-disk-chatlog"></a>
**Sandbox-disk text-edit close-time verify.** Before sending the Closing Step 5 handoff, verify the sandbox actually wrote the close-time text edits (CHATLOG entry, any other handoff-time edits) — `git --no-optional-locks status` showing the expected file as modified, and a `Read` of the first few lines to confirm content matches the planned entry. A sandbox-disk write that silently failed (permissions, mount drop, OneDrive sync conflict) presents at the next-session open as a missing CHATLOG entry that the Reconstruct-on-drift sub-rule then has to recover. (Promoted from DRAFT Bucket 3 compound entry "Sandbox-disk CHATLOG pre-check + ..."; the other two sub-rules of that compound — sandbox-black-skip + post-handoff black escalation — remain deferred per [ADR-0016](docs/adr/0016-python-rules-adoption.md) §3.) *Codified 2026-05-26 from PYTHON_RULES_DRAFT.md (see ADR-0016).*

### §4 — Script logging initialisation (Rule 9 Python form)

<a name="py-script-logging-init"></a>
**Script logging initialisation.** Any `api/scripts/*.py` that imports a logger must call the project's chosen log-init function as the first line of `main()` — before any log call, before loading config. Without this, all log output is silently discarded (no terminal output, no file write). The log-init function name is TBD; pinned when the FastAPI worker logging primitive is chosen in M2b #2. *(Trigger fires from M2b #2 onward.) Codified 2026-05-26 from PYTHON_RULES_DRAFT.md §Rule 9 (see ADR-0016 §6).*

### §5 — Iron-rule mirror rules (synthesized in ADR-0016, not in DRAFT)

These three rules mirror CLAUDE.md non-negotiables #8, #9, #10 onto the Python side. YuTom has no iron-rule equivalents, so the DRAFT does not source them; ADR-0016 §8 synthesizes them and they land here.

<a name="py-iron-rule-8-no-live-api-imports"></a>
**Non-negotiable #8 mirror — Python source-file-no-import scan for live API SDKs.** Any `api/`-side production module that participates in the embedding / agent path MUST NOT import `voyageai`, `anthropic`, or `openai` directly; live API access flows only through a stub-by-default factory mirroring the Node precedent's `getEmbedder()` at `lib/embedding.ts`. The Node mechanical floor at `lib/embedding.test.ts:217-251` (the `non-negotiable #8` describe block) scans the production library source for SDK imports and ships positive-control regex tests against regex-rot — the Python mirror does the same against `api/`-side library modules (likely `api/embeddings.py` and `api/agents/*.py` once they land), with positive controls mirroring the precedent's lines 232-250 pattern. The scan is the mechanical floor backing CLAUDE.md non-negotiable #8 on the Python side. *(Trigger fires from M2b #2 onward when api/ lands.) Synthesized 2026-05-26 in ADR-0016 §8 #1 — not present in PYTHON_RULES_DRAFT.md; mirrors CLAUDE.md non-negotiable #8 for the Python side.*

<a name="py-iron-rule-9-embedding-version-pinned"></a>
**Non-negotiable #9 mirror — Python `chunks` write-path column-assertion.** Any Python ingest path that writes a `chunks` row MUST populate `embedding_model` + `embedding_version`. Enforced by the existing schema NOT NULL constraints (server-side floor) plus a unit-level assertion in the Python ingest helper that constructs the row (client-side floor — surfaces the mismatch at test time rather than waiting for the SQL error). *(Trigger fires from M2b #2 onward when api/ lands.) Synthesized 2026-05-26 in ADR-0016 §8 #2 — not present in PYTHON_RULES_DRAFT.md; mirrors CLAUDE.md non-negotiable #9 for the Python side.*

<a name="py-iron-rule-10-prompt-hash-sealed"></a>
**Non-negotiable #10 mirror — Python prompts loaded via sealed-at-boot helper.** Any Python invocation of a Claude agent MUST load the prompt via the Python analog of `lib/prompts.ts`, enforcing three invariants the Node precedent codifies: (a) **sealed at process boot** via a top-level synchronous file-read — precedent `readFileSync` at `lib/prompts.ts:77` (ingestion) and `:132` (retrieval); (b) **hash never supplied by caller** — the audit-row writer pins the hash to the boot-time module-export constant, not to a request-time argument; (c) **byte-roundtrip assertion at module init** — precedent at `lib/prompts.ts:79-89` (ingestion) and `:134-146` (retrieval) recomputes the hash from the in-memory string after the buffer-side hash is sealed and throws if the two diverge (catches encoding-drift attacks where the buffer hash is correct but the string-decoded prompt was altered). Plus: the DB CHECK `audit_log_prompt_hash_required_for_agent` server-side floor satisfied by both Node and Python ingest paths. *(Trigger fires from M2b #2 onward when api/ lands.) Synthesized 2026-05-26 in ADR-0016 §8 #3 — not present in PYTHON_RULES_DRAFT.md; mirrors CLAUDE.md non-negotiable #10 for the Python side.*

---

## ADR Discipline

ADRs live in `docs/adr/NNNN-<slug>.md`. Number monotonically. The README at `docs/adr/README.md` is the index.

- **ADR-with-new-types sub-rule:** ADRs that introduce frozen dataclasses / TypedDicts / Zod schemas with structural invariants get a **10-line type skeleton inline** in the Decision section *before* the prose.
- **Test-helper-signature sub-rule:** ADRs that prescribe a test-helper / fixture signature change include the **new signature as a code skeleton** in the Decision section, not just a prose description.
- **ADR/design-document timing sub-rule:** (cross-ref Step 4b) for ADR work, supporting reads happen before the planning critique.

---

## Closing Ritual

**Moved to [CLOSE_SESSION_PROTOCOL.md](CLOSE_SESSION_PROTOCOL.md) on 2026-05-26 per [ADR-0017](docs/adr/0017-protocol-split-closing.md).** The closing ritual fires on explicit farewell phrases ("see you tomorrow", "thanks", "we're done", emoji goodbyes, etc.); its Pre-flight step-completeness check, Step 1 Retrospective + Session Score + Goal-delivery verification, Steps 2–6, and the Worked example all live in `CLOSE_SESSION_PROTOCOL.md`. Read at close-time, not at open. The Opening Ritual above (Steps 1–7) stays in this file.

When a farewell phrase fires, switch to reading `CLOSE_SESSION_PROTOCOL.md` and execute its ritual from Pre-flight through Step 6.

---

## Session-wide rules

These fire throughout a session, not lifecycle-bound to opening or closing. Imported 2026-05-16 from external operating-rules audit (ADR-0006).

### Context-exhaustion early-close

When the user explicitly flags context length ("we're running out of context", "context is getting long", or unambiguous equivalent), Claude MUST: (1) STOP immediately — no new tool calls, no new work items, no new suggestions; (2) run the full closing ritual (`CLOSE_SESSION_PROTOCOL.md` Pre-flight + Steps 1–6) as the very next action; (3) only after CHATLOG is written and the gate-first commands + PR pair are handed off does the session end. Continuing new work after a context warning is a protocol violation. **Trigger:** any explicit context-length warning from the user.
