# SESSION_PROTOCOL.md — Priority Knowledge Base

The strict ritual file. The opening ritual fires on the **FIRST user message of any chat** — full stop, no magic word. Greeting, question, work request, emoji, one word — all trigger the ritual.

---

## Opening Ritual

### Step 1 — Greet
One line, warm, in the user's input language (Hebrew or English).

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

### Step 6 — Ask for current focus
Use `AskUserQuestion` with 2-3 grounded options derived from the last CHATLOG entry's `Next session:` line and the active ROADMAP milestone.

**Scope-sprawl audit sub-rule:** if the previous CHATLOG entry's `Next session:` line bundles ≥3 distinct deliverables OR introduces an ADR-worthy architectural surface, present the smaller-cleaner first increment as the **Recommended** option.

**Verify-before-recommending sub-rule.** Before presenting a previous CHATLOG's `Next session:` item as the Recommended option, verify it is still pending. Cheap checks first: `git --no-optional-locks log origin/main origin/dev` for code/merge claims; for visibly-deployable artifacts (running services, dashboards, merged PRs, pushed branches) ask the user one sentence ("is X already live?") rather than trusting the doc. **Especially required when the previous CHATLOG entry is marked `RECONSTRUCTED`** — the reconstruction is built from git + chat transcript, but anything completed after the originating session's API error / context exhaustion appears in neither source, so the `Next session:` line is unverified by definition.

### Step 7 — Restate + planning self-critique
Restate the chosen focus in one sentence. Then run a **substantive** planning self-critique:
- Is this the most performant + efficient approach?
- Are the iron rules (non-negotiables in `CLAUDE.md`) covered?
- Is there a smaller cleaner first increment?
- Are there missed verification paths (eval set, smoke test, manual check)?
- Does this introduce a new architectural surface that needs an ADR before code?

Wait for **"go"**. For trivial focuses, a one-line ack is fine; for new content landing in user-facing docs / code modules / architectural decisions, the critique must be a substantive list — not theater.

**Verify-before-finalize sub-rule.** A plan section titled "pre-coding verification" or "open assumptions to check after go" is a smell. If the plan holds N "verify later" assumptions, **answer them with greps/reads BEFORE presenting the plan** for approval — a 30-second `Read` or `Grep` is always cheaper than re-planning when the assumption turns out wrong. If the plan would benefit from a "pre-coding verification checklist," do the checklist now and bake the answers into the plan, not into a future blocker.

---

## Recurring Hygiene Rituals

- **Every 5 sessions** (CHATLOG entry count divisible by 5): backlog review — read `docs/BACKLOG.md`, surface 1-2 ripe items as Step 6 options.
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

### Step 1 — Retrospective (the most important step)

Before writing anything for the record, take a structured look at the **session itself** — not the work product. Three bullets, in your head or on screen:

- **What worked:** moves that were efficient, decisions that paid off, friction we successfully avoided.
- **What didn't:** protocol slips, dead ends, things we redid, places we read/wrote/checked things we didn't need, over-engineered fixes.
- **Improvement for next session:** ONE concrete, actionable change. A protocol tweak, a habit shift, a new rule of thumb.

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
- [feature → dev](https://github.com/gzion2719/priority-kb/compare/dev...<branch>)
- [dev → main](https://github.com/gzion2719/priority-kb/compare/main...dev)

**2. <second logical change, if any>**
- [feature → dev](https://github.com/gzion2719/priority-kb/compare/dev...<branch-2>)
- [dev → main](https://github.com/gzion2719/priority-kb/compare/main...dev)

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

**Mechanical pre-send self-check.** Re-read the draft before sending. If `git push` appears, the draft MUST also contain (a) `npm run check` earlier in the same message, AND (b) the PR pair(s) with both clickable compare links each. If either is missing, fix the draft before sending. Applies to ANY "ready to commit" handoff — closing ritual, mid-session commits, ADR-only commits, anything.

**Worktree-mode override sub-rule.** When the session ran inside `.claude/worktrees/<name>/` (the default Claude Code setup on this project — see WORKFLOW.md "Worktree commit-handoff rule"), Claude runs the gate, the commit, and the push *itself* via the Bash tool from inside the worktree, **before** sending the handoff message. The user-facing message then drops the gate-first bash block entirely and leads with: a one-line confirmation that Claude ran the gate + commit + push (with the commit SHA + branch name), then the canonical PR-pair compare links, then (post-M5) the deploy block, then the session summary. The mechanical pre-send self-check above still applies — but vacuously: in worktree mode `git push` will not appear in the draft, so the `npm run check` co-presence requirement is moot. The PR-pair clickable-links requirement and the two-PR rule remain in full force regardless of mode.

**Never push to `main` directly** (see ADR-0002). Feature branches PR to `dev`; `dev` is promoted to `main` via a separate `release: dev → main` PR. Hotfixes are the only exception — `hotfix/<slug>` PRs target `main`, then immediately back-merge into `dev`. If a commit was created on `main` locally by accident, rewind `main` to `origin/main` and re-point the commit to a feature branch BEFORE pushing.

The gate is a verbatim mirror of the project's CI job. Running it locally before pushing catches red CI in seconds rather than minutes-plus-roundtrip; that's why it leads.

### Step 6 — Close warmly

One line. Match the user's register and the language pair pinned in `CLAUDE.md` (mirror the user's input language).

### Step 7 — Plain-English recap + concrete example

AFTER Step 6's farewell, append to the SAME message a short paragraph (3-5 sentences max) summarizing what you did this session in plain language, followed by ONE concrete example that makes the work tangible — a command we ran, a behavior we built, a decision we made. The CHATLOG bullets cover technical depth; this is the human anchor. Keep it simple, no jargon dumps. Format:

```
---
**In plain English:**
<3-5 short sentences about what we did and why>

**Example:**
<one concrete example — a command, a behavior, a decision, or a snippet>
```

The recap mirrors the user's input language, per `CLAUDE.md`.

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
>
> ---
> **In plain English:** Today we wired up the first working ingestion path: an admin chats with the Ingestion Agent, fills in the entry fields, and the entry gets stored with its chunks, embeddings, and a hash of the prompt that produced it. We also tightened the protocol — supporting docs like `AGENTS.md` are now explicitly Step-4b reads, not Step-4 reads, so we stop pre-loading them.
>
> **Example:** Posting `{title: "Fix duplicate customer codes", body: "...", source: "ticket #4421", last_verified_at: "2026-05-21"}` to `POST /api/ingest` now returns `{entry_id, chunks: 4, embedding_model: "voyage-3-large", embedding_version: "1"}` — and the audit row records `prompt_hash: sha256(...)`.
