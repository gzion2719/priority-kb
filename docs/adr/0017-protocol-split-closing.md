# ADR-0017 — Closing-ritual extraction to CLOSE_SESSION_PROTOCOL.md

**Status:** Accepted
**Date:** 2026-05-26
**Supersedes:** N/A
**Related:** [ADR-0006](0006-process-alignment-with-external-audit.md) (§Deliberately-not-done deferred the three-file split until the file crossed ~20KB; this ADR is the first concrete step of that work), [ADR-0016](0016-python-rules-adoption.md) (added the §Python pre-push section that pushed SESSION_PROTOCOL.md to 60KB and made the split overdue)

## Context

`SESSION_PROTOCOL.md` was 60,370 bytes at session-open 2026-05-26 — well past the 14KB audit threshold ADR-0006 set, and well past the informally-tracked 20KB split-trigger. ADR-0006 §Deliberately-not-done envisioned a YuTom-style three-file split (navigation stub + Open + Close + Rules) when the threshold fired; the audit was overdue at session-open, and ADR-0016's §Python pre-push section (which added ~11KB the same session) compounded the case for splitting.

[BACKLOG.md](../BACKLOG.md) line 141 carries the trigger entry with three enumerated sub-shapes:
- **(a)** Full YuTom-style 4-file split (navigation stub + Open + Close + Rules).
- **(b)** Extract Python pre-push to `SESSION_PROTOCOL_PYTHON.md`.
- **(c)** Extract Closing ritual to `CLOSE_SESSION_PROTOCOL.md`.

This ADR records the decision to ship **sub-shape (c)** as the first protocol-hygiene PR.

Why (c) before (a) or (b):
- The closing ritual fires once-per-session at the session boundary, after the work product is settled — a natural lazy-load lifecycle file. Opening files are read at every chat-start; the closing file only needs to be loaded at the farewell phrase.
- (c) establishes the cross-file pointer convention this ADR codifies, paving the way for (b) and ultimately (a) without each successor PR re-deciding the convention.
- (a) is much larger reorg + needs its own design ADR for the navigation-stub shape; (b) is the next-smallest extraction. (c) is the right middle.

This is NOT an M2b ROADMAP item — it's protocol hygiene captured in BACKLOG. The branch slug is `chore/protocol-split-closing`, not `docs/m2b-*`.

## Decision

ADR-with-new-types: vacuous (documentation only, no types).
Test-helper-signature: vacuous (no test helpers).

### §1 — Extract scope

The new file `CLOSE_SESSION_PROTOCOL.md` (at the repo root, sibling to `SESSION_PROTOCOL.md`) owns the following content moved verbatim (with cross-file-pointer retargets noted in §3 below):

- The "When to run" + "What does NOT trigger" + "Why it exists" preamble paragraphs.
- The Pre-flight step-completeness check.
- Step 1 (Retrospective + Session Score table + Goal-delivery verification sub-rule + the Codifiable-as-a-rule guidance).
- Steps 2–6 (CHATLOG entry composition, write-to-disk, git status, gate-first handoff + Two-PR rule + Mechanical pre-send self-check + Title-allowlist + Worktree-mode override + Tooling-denial fallback + the "never push to main" reminder + the "gate is verbatim mirror" reminder, Close warmly).
- The Worked example section (the hypothetical M2a session walkthrough).

`SESSION_PROTOCOL.md` retains:
- Opening Ritual (Steps 1–7 + all opening sub-rules including Step 7b Unbiased-review).
- Recurring Hygiene Rituals.
- Python pre-push (the section added by ADR-0016).
- ADR Discipline.
- A short "Closing Ritual" pointer paragraph indicating the closing file's location.
- Session-wide rules (Context-exhaustion early-close fires DURING session, not at close — stays).

### §2 — Cross-file pointer convention

This convention is the durable artifact of ADR-0017; future extractions (sub-shapes b, a, and any others) inherit it without re-deciding.

**Prose pointer form, no markdown auto-anchors.** When a rule in one protocol file references a rule in another, use the prose form:

> `OTHER_FILE.md` Step N — Section title

NOT the markdown auto-anchor form `OTHER_FILE.md#step-n--section-title`. Rationale: markdown auto-anchors drift on copy-edits (heading text changes silently break the anchor); prose pointers are robust to renames and stay grep-able. This trades clickability for resilience — acceptable for a small finite set of cross-file pointers maintained by hand.

**Intra-file refs stay bare.** Same-file references (e.g., "Step 7b Verify-before-implementing-CR-claim" inside `SESSION_PROTOCOL.md`) stay bare, no file-name prefix. Only cross-file refs carry the prefix.

**Historical CHATLOG entries stay verbatim.** CHATLOG entries dated before this ADR may say `SESSION_PROTOCOL.md Closing Step *`; those stay as historical pointers. Future readers locate the rule by walking the lineage (`ADR-0017` → `CLOSE_SESSION_PROTOCOL.md`); they don't expect old CHATLOG entries to be retroactively rewritten on every file move. Codified to prevent a future "CHATLOG fix-up pass" from regressing this.

**Forward-going refs retarget in the same PR that causes the split.** When this ADR's PR moves the closing ritual to `CLOSE_SESSION_PROTOCOL.md`, every forward-going ref in `CLAUDE.md` / `WORKFLOW.md` / other ADRs / `CHATLOG.md` header / `README.md` / workflow YAML retargets in this same PR. The future-Claude-orientation invariant requires that load-bearing pointers stay current; the historical-CHATLOG carve-out above is the only exception.

**`.claude/settings.json` needs no edit.** Its hook message references "SESSION_PROTOCOL.md Opening Ritual Steps 1-7" — the Opening Ritual stays in `SESSION_PROTOCOL.md`, so no retarget needed. Confirmed explicitly here so a future reader doesn't waste a check.

### §3 — Inverse self-references (closing block's intra-protocol refs)

When the closing block moves to `CLOSE_SESSION_PROTOCOL.md`, several references inside the moved content are no longer same-file (they now point at `SESSION_PROTOCOL.md`):

- Session Score deductions list mentions "Step 7b skip-without-reason" — retargeted to `SESSION_PROTOCOL.md Step 7b`.
- Goal-delivery verification sub-rule says "closing-leg mirror of the Goal-quantification extension under Step 7 Verify-before-finalize" — retargeted to `SESSION_PROTOCOL.md Step 7 Verify-before-finalize`.
- Step 1's "Codifiable as a rule" file list `(SESSION_PROTOCOL.md, CLAUDE.md, WORKFLOW.md, an ADR, etc.)` — added `CLOSE_SESSION_PROTOCOL.md` to the editable-protocol-files list.

And one inverse direction in `SESSION_PROTOCOL.md`'s remaining Session-wide rules block:

- Context-exhaustion early-close sub-rule says "run the full closing ritual (Pre-flight + Steps 1–6) as the very next action" — retargeted to `CLOSE_SESSION_PROTOCOL.md Pre-flight + Steps 1–6`.

**Quoted-example narration carve-out.** The Worked example at the end of `CLOSE_SESSION_PROTOCOL.md` contains bare references to "Step 4b" / "Step-4" inside a hypothetical session walkthrough (`> You produce: ...`). Those bare refs are quoted illustration of a closing ritual run, not rule pointers — readers learn the format by example, not by following the refs. They stay bare on purpose. Distinguishable from rule-pointer refs by the quoted-narration context (`> ... ` indented block).

### §4 — Quantified delivery

| Metric | Pre-extraction | Post-extraction | Delta |
|---|---|---|---|
| `SESSION_PROTOCOL.md` size | 60,370 bytes | 44,936 bytes | **−15,434 bytes (−25.6%)** |
| `CLOSE_SESSION_PROTOCOL.md` size | n/a | 17,023 bytes (new file) | — |
| Sum of opening + closing files | 60,370 bytes | 61,959 bytes | +1,589 bytes (cross-file pointer + header overhead) |

Net session-wide token cost grows slightly (~+1.6KB across the two files combined) due to the new file's lineage header and the cross-file pointer paragraphs added in both files. The win is **lifecycle separation**, not raw byte reduction — orientation reads at chat-start no longer pay the closing-ritual token cost (~17KB lazy-loaded only on farewell), and closing reads at session-end no longer pay the opening-ritual token cost (~45KB lazy-loaded only at chat-start). The per-chat orientation read drops by ~15.4KB; the per-close read picks up ~17KB but fires once per session at the boundary, after the work is done.

Residual `SESSION_PROTOCOL.md` at ~44KB is still above the 20KB split trigger. Sub-shape (b) — extract Python pre-push to `SESSION_PROTOCOL_PYTHON.md` — is the next protocol-hygiene PR per the BACKLOG entry. Carrying the trigger forward.

## Consequences

**Positive:**
- Chat-start orientation no longer includes ~14KB of closing-ritual content that won't fire until session-end. Net token win per chat-start: every session.
- The cross-file pointer convention codified in §2 makes future extractions (sub-shape b, sub-shape a) mechanical rather than design-each-time.
- Lineage chain is self-contained: ADR-0006 → ADR-0017 → `SESSION_PROTOCOL.md` + `CLOSE_SESSION_PROTOCOL.md`; future readers reconstruct from this ADR alone.

**Negative:**
- One more file in the repo root. Already five protocol files at root (`CLAUDE.md`, `SESSION_PROTOCOL.md`, `WORKFLOW.md`, `CHATLOG.md`, `README.md`); adding `CLOSE_SESSION_PROTOCOL.md` makes six. If the full 4-file split (sub-shape a) eventually lands, root will have 8+ files — at that point, consider moving them under `docs/protocol/`.
- Cross-file refs are now a surface area that can drift. The mechanical-floor candidate filed to BACKLOG (cross-protocol-file reference linter) is the eventual fix; per `feedback_prefer_mechanical_over_prose`, it fires on the 3rd recurrence of a drift incident.
- Sub-shape (c) is partial — `SESSION_PROTOCOL.md` is still ~44KB, over the 20KB trigger. Sub-shape (b) is queued.

**Mitigations:**
- Cross-protocol-file reference linter queued to BACKLOG as a mechanical-floor candidate (per `feedback_prefer_mechanical_over_prose` — 3rd recurrence threshold).
- Worktree snapshots under `.claude/worktrees/` are stale-by-design and refresh on next worktree creation; no action needed.
- BACKLOG 3-file split entry updated to reflect (c) shipped, with size measurement; (b) and (a) remain.

## References

- [ADR-0006](0006-process-alignment-with-external-audit.md) §Deliberately-not-done — the original deferral this ADR closes (partially).
- [ADR-0016](0016-python-rules-adoption.md) §Consequences-Negative — flagged the post-import file size growth that compounded the trigger.
- [docs/BACKLOG.md](../BACKLOG.md) — three-file split entry (sub-shapes a/b/c) + the cross-protocol-file reference linter BACKLOG item filed alongside this ADR.
- [SESSION_PROTOCOL.md](../../SESSION_PROTOCOL.md) — the post-extraction opening + recurring-hygiene + Python-pre-push + ADR-discipline + closing-pointer + session-wide-rules file.
- [CLOSE_SESSION_PROTOCOL.md](../../CLOSE_SESSION_PROTOCOL.md) — the new closing + worked-example file.
