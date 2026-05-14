# WORKFLOW.md — Priority Knowledge Base

How chats work across the project. Read on the first message of every chat (per `SESSION_PROTOCOL.md` opening Step 3).

---

## Chat archetypes

### Build — implementing a milestone task
Most chats are this. Pick one focus from the active ROADMAP milestone, do the planning self-critique, ship the narrowest E2E increment, close with the ritual.

**Starter prompt (paste):**
> Build session. Focus: <task from ROADMAP / BACKLOG>. Run opening ritual, then propose smallest E2E increment and wait for go.

### Research — investigating a tool / pattern / dataset
For when the path forward is unclear and we need to look at options or read existing code before committing. Outputs an ADR draft or a BACKLOG entry, not production code.

**Starter prompt:**
> Research session. Question: <question>. No production code; output is either an ADR draft or a BACKLOG entry. Constrain to <time/scope>.

### Unrelated — out-of-scope work
For one-off Q&A or tasks that don't touch the KB. Skip the opening ritual's deeper reads (Step 4); do not append a CHATLOG entry unless the work produces a project-affecting decision.

**Starter prompt:**
> Unrelated to PriorityKB. <ask>. Skip ROADMAP/CHATLOG reads.

---

## Fresh-chat triggers

Open a new chat when any of these hit:
- ~30 exchanges deep (context is starting to compact).
- Topic switch — different milestone or different chat archetype.
- Phase / milestone boundary (M1 → M2a, etc.).
- Claude forgetting or contradicting an earlier decision in the same chat.
- Approaching a sensitive operation (DB migration, schema change, prompt overhaul) — start fresh with full attention.

---

## End-of-session phrase

Any farewell triggers the closing ritual (see `SESSION_PROTOCOL.md` Closing Ritual). Examples:
- "thanks for today"
- "see you tomorrow"
- "we're done"
- "תודה על היום"
- "let's call it"
- 👋 / 🙏

---

## Pre-push gate

Mirrors `.github/workflows/ci.yml` exactly. The gate command lives in `package.json` and (eventually) `pyproject.toml`.

**Node side (M1+):**
```
npm run check
```
Which runs:
- `npm run lint`     → ESLint
- `npm run format:check` → Prettier --check
- `npm run typecheck` → `tsc --noEmit`
- `npm test`         → Vitest

**Python side (M2b+, when the FastAPI worker lands):**
```
make py-check
```
Which runs:
- `ruff check api/`
- `black --check api/`
- `mypy --strict api/`
- `pytest api/ --cov`

If either gate is red, **do not push**. Fix locally; the gate is the contract.

---

## Red flags — stop and resync

If any of these happen, pause and re-orient before continuing:
- Claude repeats a corrected mistake within the same chat.
- Claude contradicts a decision from an earlier message of the same chat.
- Claude generates content that contradicts `CLAUDE.md`, an ADR, a prompt file, or a recent CHATLOG entry.
- Tests pass but the manual smoke-check fails (means the test isn't testing what we think).
- Embedding/Claude API call appears in a test file (violates non-negotiable #8).
- Raw SQL insert / direct DB write appears outside a migration (violates non-negotiable #2).

Resync = re-read the relevant rule file, restate the constraint, then continue.

---

## Emergency protocol

If the KB is corrupted (bad data, schema drift, accidental admin mass-delete):

1. **Stop writes.** Flip the ingestion API to read-only mode.
2. **Snapshot current state** — `pg_dump` immediately even if you think the data is bad; you'll want the forensic snapshot.
3. **Restore from last good backup** (nightly `pg_dump` in M1+, S3-backed in M5+).
4. **Diff and re-ingest** the entries from the gap window.
5. **Postmortem** as ADR — what failed, what guardrail prevents recurrence.

If Claude or Voyage is down for >15 minutes: flip the Retrieval Agent to **degraded mode** (keyword-only search, no synthesis). Banner the UI. This is per non-negotiable #12.
