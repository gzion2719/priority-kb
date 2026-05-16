# ADR-0006 — Process alignment with external operating-rules audit

Status: Accepted
Date: 2026-05-16
Supersedes: nothing
Superseded by: nothing

## Context

The user provided four files from a parallel project (the YuTom Trading Bot) representing that project's evolved operating rules — a split `SESSION_PROTOCOL.md` navigation stub plus `OPEN_SESSION_PROTOCOL.md`, `CLOSE_SESSION_PROTOCOL.md`, and `SESSION_RULES.md`. The goal: import operationally-tight rules that generalise across projects, without dragging in the trading-bot-specific noise or duplicating what PriorityKB has already codified across the 2026-05-15 / 2026-05-16 protocol-merge passes (Pass 1, Pass 2a, Pass 2b, ADR-0004 PR-title floor, Step 7b unbiased-review, etc.).

The session that produced this ADR ran the imports through a Step 7b unbiased-review pass; the reviewer surfaced 4 BLOCKING + 8 MAJOR findings that shrank the import scope substantially. Most YuTom rules either duplicated work already done in PriorityKB or were trading-bot-specific.

This ADR records what was imported, what was deferred, what was rejected, and the rationale — so a future reader can reconstruct the decisions without re-running the audit.

## Decision

This ADR introduces no new types or test-helper signatures. ADR-with-new-types and Test-helper-signature sub-rules are vacuously satisfied.

### Imported (this commit)

Five additions to `SESSION_PROTOCOL.md`:

1. **Closing — Pre-flight step-completeness check** (before Step 1). Enumerate all closing-ritual steps and confirm each will fire before Step 1 starts.
2. **Closing Step 1 — Session Score** (3-axis 10/10 table + Ceiling line). Adapted deductions for PriorityKB: `npm run check` rounds, Step 7b skip-without-reason, gate-first commit-block shape, Two-PR rule, PR-title precheck self-check, proactive-recap-without-farewell, wasted token clusters.
3. **Closing Step 1 — Goal-delivery verification sub-rule.** When the session named a measurable goal, Step 1 measures actual delivery with concrete numbers before composing the CHATLOG entry.
4. **Opening Step 7 Verify-before-finalize — Goal-quantification extension.** When the user states a measurable goal, the Step 7 plan quantifies predicted delivery on that metric before presenting for approval. Tucked under the existing Verify-before-finalize sub-rule rather than introduced as a separate named sub-rule (per reviewer M3).
5. **New bottom section "Session-wide rules" — Context-exhaustion early-close.** When the user flags context length, STOP, no new tool calls, run the full closing ritual as the next action.

One addition to `CLAUDE.md`: see ADR-0007 (separate ADR, landed in same commit) for the language-policy flip.

### Already present in PriorityKB → skipped

The external audit's surface that PriorityKB already covers, often more rigorously:

| External rule | PriorityKB equivalent |
|---|---|
| Rule 11 — Plan adversarial review (ADR-shaped or not) is automatic | **Step 7b Unbiased-review sub-rule** fires on *every* Step 7 plan (not just ADRs), using the `review-loop` skill — independent subagent receives plan + rule-file paths only, never the conversation. More rigorous than the external version's self-critique. |
| Mechanical pre-response self-check | Already in `CLAUDE.md` opening-trigger header. |
| Step 5 — `git fetch` before `git status` | Already in `SESSION_PROTOCOL.md` Step 5. |
| Step 6 — Verify-before-recommending | Already in Step 6. |
| Step 7 — Verify-before-asking | Already in Step 7. |
| Reconstruct-on-drift | Already in Step 5. |
| Scope-sprawl audit (Step 6) | Already in Step 6. |
| ADR-with-new-types / Test-helper-signature / ADR-design-document timing | Already in `SESSION_PROTOCOL.md` ADR Discipline section. |
| Worktree commit-handoff + Tooling-denial fallback + Two-PR rule + PR-title mechanical floor | All in `WORKFLOW.md` and `SESSION_PROTOCOL.md` Closing Step 5; ADR-0004 has the full design. |
| Stacked-PR + Describe-from-source + Secret-redaction | All in `WORKFLOW.md`. |
| "Claude never merges its own PRs" (no `gh pr merge --auto`) | Codified 2026-05-16 in `WORKFLOW.md` Worktree commit-handoff rule. |
| Plain-English Closing Step 7 | **Deliberately dropped 2026-05-16** ("not earning its keep" — see CHATLOG and `SESSION_PROTOCOL.md` Step 6 trailing note). Not re-imported. |

### Deferred to BACKLOG

| External rule | Reason deferred |
|---|---|
| Closing Step 7 — Next-session focus preview + tool tag (Cowork vs Claude Code) | Adding a new Closing Step 7 the same week PriorityKB dropped its Plain-English Step 7 conflicts with the trim narrative. Park; revisit after 5 sessions where the Cowork↔Claude Code switch decision was non-obvious. |
| Subagent absence-claim verification (Rule 12) + parallel-batch sub-rule | The `review-loop` skill (PriorityKB's actual review mechanism) has its own internal contract for subagent claims. PriorityKB doesn't use subagents outside review yet. Codify when a non-review subagent surface appears. |
| Acceptance-signal verification before ✅ (Rule 13) | Requires per-milestone canonical acceptance signals; PriorityKB's ROADMAP phrases acceptance as user-flow narrative, not as canonical log lines. Codify the rule once canonical signals exist. |
| Step 7b second-pass-on-implemented-code policy formalisation | The "amplified" sub-rule in Step 7b already implies this; revisit after 5 sessions to see if a more formal trigger is needed. |
| 5-session audit of which imported rules actually fired vs are dead letters | XS task; surface at the next 5-session backlog review. |

### Rejected (YuTom-specific, no PriorityKB equivalent surface)

- **Rule 8 — Code Writing Protocol (Spec → Critic-mode → Code → Critic-mode → QA)**. Directly contradicts Step 7b, which deliberately replaced self-critique with subagent review after the "Step 7b dogfood failure" (2026-05-16 CHATLOG entry) where I rationalised a skip on a self-critique pass.
- **Refusal clause** ("just start" → refuse once, comply if pressed). Contradicts the existing **Explicit opt-out** in `CLAUDE.md` opening-trigger header.
- **Manual-trigger sub-rule on every-10-sessions CHATLOG archival**. No evidence in CHATLOG that the absence has caused a missed archival; pure rule-thickening.
- **VPS sudo-over-SSH handoff sub-rule**. No VPS surface until M5.
- **Capital/economics settings-pre-read sub-rule**. Trading-bot-specific.
- **Typed-event publish-site audit sub-rule**. References `TOPIC_*` in `src/core/event_topics.py` — trading-bot-specific.
- **Config-value-to-component support sweep**. References pipeline components specific to a data-collection bot.
- **Touch ID over CLI sudo, Cowork within-import alphabetization**. Mac-specific, environment-specific.
- **Rule 5 (~40 Python sub-rules), Rule 7 (C-extension coverage), Rule 9 (script logging init)**. Parked in `docs/PYTHON_RULES_DRAFT.md` for per-rule review when the M2b FastAPI worker lands. Some sub-rules may have Node analogues (e.g., the script-logging principle for the existing `scripts/*.mjs` files); flagged in BACKLOG.

### Deliberately not done

- **The YuTom three-file split** (navigation stub + Open + Close + Rules) is not adopted now. PriorityKB's `SESSION_PROTOCOL.md` is ~10KB, well under any token ceiling. The split was driven by YuTom hitting the file-size ceiling; PriorityKB hasn't. Defer until the file crosses ~20KB; track in BACKLOG. After this commit's additions, re-measure SESSION_PROTOCOL.md size — if it crosses 14KB, audit the split threshold.

## Consequences

**Positive:**
- Session Score creates measurable pressure to improve session-over-session; the Ceiling line feeds the CHATLOG `Process improvement` bullet with a concrete next-session-executable change.
- Goal-quantification + Goal-delivery verification close the open↔close measurement loop for any session with a stated numeric target.
- Pre-flight step-completeness check guards against silently-skipped closing steps after sub-rule amendments.
- Context-exhaustion early-close is a small generic rule with a clear trigger that prevents context-thrash sessions.

**Negative:**
- Session Score adds a markdown table to every closing ritual — a thickening, while three slimming items sit in BACKLOG's "Protocol slimming — YELLOW items" section. The trade-off is conscious: Session Score is a measurement instrument, not ceremonial recap. If after 5 sessions the score is being filled out perfunctorily rather than driving real improvement, revisit.
- Multiple imported rules ("Goal-quantification", "Goal-delivery", "Context-exhaustion") rely on the user stating something specific (a measurable goal, a context warning). They may not fire for many sessions, which makes them hard to verify as effective. The 5-session audit BACKLOG item addresses this.

**Mitigations:**
- BACKLOG carries the deferred items + the 5-session audit so nothing is silently dropped.
- The Python rules draft is referenced from BACKLOG AND from `docs/ROADMAP.md` M2b checklist, so it surfaces when M2b actually starts.

## References

- `SESSION_PROTOCOL.md` Closing Pre-flight, Step 1 Session Score, Step 1 Goal-delivery sub-rule, Step 7 Goal-quantification extension, Session-wide rules — Context-exhaustion.
- `CLAUDE.md` language convention block (see ADR-0007).
- `docs/PYTHON_RULES_DRAFT.md` — parked Python rules.
- `docs/BACKLOG.md` — deferred items.
- `docs/ROADMAP.md` M2b checklist — review of `PYTHON_RULES_DRAFT.md`.
- CHATLOG 2026-05-16 — log helper session ("Step 7b dogfood failure" and "amplified covers review-induced plan changes").
- Uploaded source files (session attachment): `OPEN_SESSION_PROTOCOL.md`, `CLOSE_SESSION_PROTOCOL.md`, `SESSION_RULES.md`, `SESSION_PROTOCOL.md` (navigation stub).
