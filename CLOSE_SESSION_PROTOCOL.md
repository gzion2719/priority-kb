# CLOSE_SESSION_PROTOCOL.md — Priority Knowledge Base

Closing ritual file. Extracted from [SESSION_PROTOCOL.md](SESSION_PROTOCOL.md) 2026-05-26 per [ADR-0017](docs/adr/0017-protocol-split-closing.md) sub-shape (c) of the BACKLOG three-file split. The opening ritual stays in `SESSION_PROTOCOL.md`; this file owns everything from the explicit farewell signal through the gate-first handoff. Read this at close-time, not at session start.

Cross-file pointer convention (codified in ADR-0017 §Decision): forward-going references inside this file use the prose form "`SESSION_PROTOCOL.md` Step N (Section title)" — no markdown auto-anchors (drift-resistant). Historical CHATLOG entries that say `SESSION_PROTOCOL.md Closing Step *` stay verbatim as historical pointers.

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
| **Protocol compliance** | 3 | Start at 3. −1 per protocol slip — `SESSION_PROTOCOL.md` Step 7b skip-without-reason, wrong gate-first commit-block shape, Two-PR rule miss, missing PR-title-precheck self-check, proactive recap without farewell, etc. Floor 0. |
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

**Goal-delivery verification sub-rule (codified 2026-05-16, see ADR-0006).** When the session's stated goal included a measurable target (token savings, performance improvement, file size reduction, error rate, etc.), Step 1 MUST verify actual delivery with concrete numbers BEFORE composing the CHATLOG entry. Run the measurement (`Read` for file size, benchmark, coverage diff — whatever fits), state before/after numbers, confirm whether the target was met. "Savings confirmed" without a number is not acceptable. This is the closing-leg mirror of the Goal-quantification extension under `SESSION_PROTOCOL.md` Step 7 Verify-before-finalize: if the session committed to a number at open, it verifies the number at close. **Trigger:** the session's `SESSION_PROTOCOL.md` Step 6 focus or any user message during the session named a measurable goal → Step 1 includes a measurement block before the three retrospective bullets.

The improvement is the OUTPUT, and it has two possible homes:

1. **Codifiable as a rule** (it almost always is) — edit the relevant file **IN THIS SAME SESSION** (`SESSION_PROTOCOL.md`, `CLOSE_SESSION_PROTOCOL.md`, `CLAUDE.md`, `WORKFLOW.md`, an ADR, etc.). The edit IS the improvement; don't write a separate description of it. **Before editing, do a conflict check:** grep the file for related rules, confirm the new wording doesn't contradict anything already there.
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
