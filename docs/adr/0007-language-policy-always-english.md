# ADR-0007 — Language policy: agent replies always in English

Status: Accepted
Date: 2026-05-16
Supersedes: the mirror-language clause in `CLAUDE.md` (which had been live since the bootstrap session, 2026-05-14).
Superseded by: nothing

## Context

`CLAUDE.md` pinned a non-negotiable language convention from the bootstrap session: user input could be Hebrew or English (per message, user's choice); agent reply mirrored the user's input language (Hebrew → Hebrew, English → English). That convention has been live across all sessions to date.

In the 2026-05-16 process-alignment session, the user explicitly requested a switch to "always English" — first by selecting "לאמץ 'תמיד אנגלית'" (adopt 'always English') in an `AskUserQuestion` response about which language policy to adopt, then by reinforcing with a follow-up message: *"תכתוב לי הכל באנגלית ותענה רק באנגלית מעכשיו"* ("write everything to me in English and reply only in English from now on"). The "from now on" framing is what makes this permanent policy, not a per-session preference. When asked to confirm permanent vs per-session, the user replied "1 yes" to "Language flip is permanent policy (not just this session's preference)?".

Changing a "pinned, non-negotiable" deserves an ADR with explicit rationale and a supersedes pointer, so this file exists to make the change auditable.

## Decision

This ADR introduces no new types or test-helper signatures. ADR-with-new-types and Test-helper-signature sub-rules are vacuously satisfied.

### Scope — operating language only

**This ADR flips operating language only.** Operating-language = Claude↔user conversations, file edits, ADRs, CHATLOG entries, handoffs, and the runtime SessionStart instruction. It does NOT flip the product-facing language policy:

| Surface | Language policy | Governed by |
|---|---|---|
| Claude↔user operating chat | Always English (this ADR) | `CLAUDE.md` |
| File edits, ADRs, CHATLOG, README | Always English (this ADR) | `CLAUDE.md` |
| Retrieval Agent answering end users | **Mirror** (unchanged) | `docs/AGENTS.md` + `prompts/retrieval-agent.md` |
| Ingestion Agent admin chat | **Mirror** (unchanged) | `docs/AGENTS.md` + `prompts/ingestion-agent.md` |

The product surfaces remain on mirror because the Retrieval Agent answers Priority ERP questions to end users in an Israeli organisation — many native Hebrew speakers. Flipping the product would be a UX downgrade that requires its own decision, recorded in a separate future ADR if needed.

### Edits

The `CLAUDE.md` language-convention block is rewritten as follows:

- **User input:** Hebrew or English (per message, user's choice). Unchanged.
- **Agent reply:** **always English**. No Hebrew in Claude's output, ever. Self-check every draft before sending. Changed.
- **Scope:** operating language only — see scope table above.
- **Rationale pointer:** "Codified 2026-05-16 at user's explicit request; supersedes the prior mirror policy."

`SESSION_PROTOCOL.md` Opening Step 1 ("Greet — one line, warm…") is updated: "in English per `CLAUDE.md` language convention; no Hebrew in output, ever — even when greeting a Hebrew first-message." Closing Step 6 ("Close warmly") similarly cleaned of mirror wording: "in English per CLAUDE.md language convention."

The opening-trigger header in `CLAUDE.md` (line ~10) replaces the parenthetical *"(Hebrew or English — mirror)"* with "reply in English per the language convention below."

`README.md:97` (mutual-agreement block) is updated to distinguish operating-language English-only from product-language mirror, with a pointer to `docs/AGENTS.md` for the product policy.

`.claude/settings.json` SessionStart hook command is updated to instruct English-only operating reply in place of the previous "Mirror the user's input language" tail. (Note: the `.claude/settings.json` file is protected from Cowork-side edits; the user applies this change manually from their editor — see ADR-0006 handoff for the exact replacement.)

## Consequences

**Positive:**
- One language to render in every chat turn. Removes the per-message language-detection round (which has been correct ~100% of the time, but still costs a beat of attention).
- Closing ritual recap files (in CHATLOG and ADRs) are uniformly in English, so future-Claude orients faster without a Hebrew↔English render swap.
- Aligns with the YuTom operating-rules baseline that the user is comfortable working from on the parallel project.

**Negative:**
- Hebrew↔Hebrew conversation is a UX downgrade compared to mirror. The user accepted this trade-off in the AskUserQuestion (with the alternative "Hebrew מותר רק במסרים קצרים" available and not selected).
- If a future-Claude rendering issue makes English-only worse than mirror in some specific client, this ADR is the supersedes target.

**Open question parked to BACKLOG:**
- The original YuTom rationale for "always English" was that Hebrew rendering wasn't readable in Tom's specific client. PriorityKB uses Cowork primarily. After 5 sessions of always-English, verify whether Hebrew rendering is actually a problem in this environment — if not, mirror might be re-adoptable without the UX downgrade.

## Implementation notes

- The change lands in the same commit as ADR-0006 (process-alignment audit-import) because both are textually small and ADR-0006 references ADR-0007 for the language-block rewrite.
- The session producing this ADR adopted the policy mid-session (after the user's reinforcement message). All Claude replies in this session from that point forward are in English, regardless of whether the user typed Hebrew or English — that's the policy taking effect immediately.

## References

- `CLAUDE.md` — language convention block.
- `SESSION_PROTOCOL.md` Opening Step 1, Closing Step 6 — wording cleaned.
- CHATLOG 2026-05-16 — the process-alignment session entry will cite this ADR.
- Source: this session's `AskUserQuestion` answer + the user's follow-up reinforcement message.
