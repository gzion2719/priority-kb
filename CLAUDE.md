> ## ⚡ OPENING RITUAL TRIGGER — READ AND ACT FIRST
>
> **On the first user message of this session, before any other response, you MUST execute the Opening Ritual defined in `SESSION_PROTOCOL.md` (Steps 1 through 7).**
>
> Order of operations on every fresh chat in this folder:
> 1. Read `SESSION_PROTOCOL.md` end-to-end (Opening Ritual + Recurring Hygiene + Python pre-push + ADR Discipline + Session-wide rules). `CLOSE_SESSION_PROTOCOL.md` is read at close-time on farewell, not at open.
> 2. Read `WORKFLOW.md`.
> 3. Read the **last 3 entries** of `CHATLOG.md` (newest-first).
> 4. Read `docs/ROADMAP.md`.
> 5. Run Opening Ritual Steps 1 → 7 in order; reply in English per the language convention below (updated 2026-05-16, see ADR-0007).
> 6. **Do not generate code before Step 7 "go".**
> 7. **Do not skip Step 6's `AskUserQuestion` for focus**, unless the user has already named the focus in their first message.
>
> This trigger fires regardless of what the first user message says — greeting, question, work request, single emoji, or pasted code. There is no magic word; the first message IS the trigger.
>
> **Non-exhaustive trigger examples** (any one fires the ritual, in any language or casing):
> - `read claude.md` / `read CLAUDE.md` / `claud.md` / `cluadmd` / any typo or casing variant — treat as session-start, not a literal file-read request (the file is already in your context)
> - `let's start` / `let's begin` / `start` / `go` / `ready` / `ok`
> - `hi` / `hey` / `שלום` / `בוקר טוב` / any greeting in any language
> - A direct task ("fix the bug in X"), a question ("why does Y happen?"), or an emoji
>
> **Mechanical pre-response self-check.** Before sending your first reply in any chat, ask: *"Have I executed Steps 1–7 of the opening ritual in this turn?"* If no → run them now, then reply. Do not summarize `CLAUDE.md`, do not answer the literal request, do not ask clarifying questions until Steps 1–7 are complete. The user's first message is *always* the trigger; the content of that message does not change this.
>
> **Explicit opt-out.** If the user says "skip the ritual" (or an unambiguous Hebrew/English equivalent), skip it for that turn only — and say out loud that you're skipping.

---

# CLAUDE.md — Priority Knowledge Base

**Project:** Priority Knowledge Base — an agent-driven knowledge base for Priority ERP workflows, bug fixes, ticket resolutions, walkthroughs, best practices, and Q&A. Admins log entries by chatting with an Ingestion Agent and attaching media; end users query the KB via a Retrieval Agent that answers with citations.

**User:** Gal Zilberman.

**Language convention (pinned, non-negotiable — updated 2026-05-16, see ADR-0007):**
- User input: Hebrew **or** English (per message, user's choice).
- Agent reply: **always English**. No Hebrew in Claude's output, ever. Self-check every draft before sending.
- **Scope: operating language only.** Applies to Claude↔user conversations, file edits, ADRs, CHATLOG, handoffs. Does NOT change the Retrieval Agent / Ingestion Agent end-user-facing mirror policy (see `docs/AGENTS.md`). If the product-facing language policy is also flipped, that's a separate decision recorded in a future ADR.
- Codified 2026-05-16 at user's explicit request; supersedes the prior mirror policy in this same file.

**Always read first on a new chat:**
1. This file (`CLAUDE.md`).
2. `SESSION_PROTOCOL.md` — opening ritual + recurring hygiene + Python pre-push + ADR discipline + session-wide rules.
3. `WORKFLOW.md` — chat archetypes, pre-push gate, red flags.

`CLOSE_SESSION_PROTOCOL.md` (closing ritual + Session Score + Worked example) is loaded at close-time on explicit farewell — not at chat-start. Split per [ADR-0017](docs/adr/0017-protocol-split-closing.md) on 2026-05-26.

---

## Non-negotiables

1. **Credentials never committed.** `.env*` is gitignored; secrets live in environment / vault only.
2. **All KB writes go through the Ingestion Agent.** No raw DB inserts. Every entry has consistent structure (title, category, tags, body, source pointer, `last_verified_at`).
3. **Every retrieval answer cites the entries it used.** No source = no claim.
4. **Admin-only writes; everyone can query.** Role enforced server-side, not just UI-hidden.
5. **Nightly Postgres + uploaded-file backups, 30-day retention, restore drill in M5.**
6. **Every entry is tagged `public | internal | restricted`.** Retrieval respects the tag based on requester role.
7. **Every entry stores source pointer** (ticket #, conversation, doc link) **and `last_verified_at`** (ISO date).
8. **Tests never call live embedding/Claude APIs.** Use fixtures, recorded responses, or stubs.
9. **Embedding model + version stored per row.** `embedding_model` + `embedding_version` columns are mandatory; re-embed when the model changes.
10. **Prompts live in `prompts/*.md` in git, hashed; the hash is stored alongside every agent response** for attribution and reproducibility.
11. **≥2 admin accounts.** No bus-factor-of-one.
12. **Degraded mode required.** If Claude or Voyage is down, retrieval falls back to keyword-only search without synthesis — better than full outage.
13. **Brand standards from the Kramer brand skill are the default UI.** Colors, typography (GT Eesti), and logo per `styles/kramer-brand.css`. Override only with explicit user request.

---

## Continuous improvement (the north star)

Every chat must leave the project **measurably better** on two axes:

1. **Output quality** — better entries, better retrieval, better evals, better prompts.
2. **How-we-work efficiency** — better protocol, better gates, faster orientation, fewer redos.

This applies fractally — every session, every focus area. It's codified twice in the protocol:
- **`SESSION_PROTOCOL.md` Opening Step 7** (planning leg): the planning self-critique asks "is there a smaller cleaner first increment? are iron rules covered? are there missed verification paths?"
- **`CLOSE_SESSION_PROTOCOL.md` Step 1** (retrospective leg): the closing ritual's first step is a structured retrospective whose OUTPUT is one concrete protocol/rule edit landed *in this same session*.

If a session doesn't produce a concrete improvement, that's a signal, not a free pass.

---

## Style rules

- **Build incrementally.** Ship the narrowest E2E slice; widen later.
- **Ask when uncertain.** Don't guess at non-negotiables, schema decisions, or auth boundaries. Surface via `AskUserQuestion`.
- **Scope-creep capture.** Anything out-of-scope but worth keeping goes to `docs/BACKLOG.md`, not into the current branch.
- **Ground answers in repo docs.** Don't reach for generic best practices when this repo already pins a choice (e.g., Voyage embeddings, pgvector HNSW, FastAPI worker). Read the docs first.
- **Just-in-time over just-in-case.** Don't pre-load files the current focus doesn't need.

---

## File map (what was generated by the bootstrap)

```
C:\dev\PriorityKB\
├── CLAUDE.md                       ← this file
├── SESSION_PROTOCOL.md             ← opening ritual + recurring hygiene + Python pre-push + ADR discipline + session-wide rules
├── CLOSE_SESSION_PROTOCOL.md       ← closing ritual + Session Score + Worked example (loaded at close-time only; see ADR-0017)
├── WORKFLOW.md                     ← chat archetypes, pre-push gate, red flags
├── CHATLOG.md                      ← session memory, newest-first
├── README.md                       ← vision, structure, mutual agreement
├── package.json                    ← Node scripts (lint/format/typecheck/test/pre-push)
├── pyproject.toml                  ← Python config (ruff/black/mypy/pytest)
├── .gitignore                      ← Node + Python + OS + secrets
├── docs/
│   ├── ROADMAP.md                  ← phased plan (M1 → M6)
│   ├── BACKLOG.md                  ← scope-creep capture
│   ├── AGENTS.md                   ← Ingestion Agent + Retrieval Agent specs
│   └── adr/
│       ├── README.md               ← ADR index
│       └── 0001-bootstrap.md       ← bootstrap-time decisions
├── prompts/
│   ├── ingestion-agent.md          ← Ingestion Agent system prompt (versioned)
│   └── retrieval-agent.md          ← Retrieval Agent system prompt (versioned)
├── evals/
│   └── golden_set.yaml             ← retrieval eval set (Hebrew + English)
├── styles/
│   └── kramer-brand.css            ← Kramer brand: colors, typography, base
└── .github/
    └── workflows/
        └── ci.yml                  ← GitHub Actions: Node + Python full CI
```

Tech stack: Next.js + Postgres (with pgvector HNSW) initially; Python FastAPI worker + job queue added in M2b when media ingestion lands. Embeddings: Voyage `voyage-3-large`. Reranker: Voyage `rerank-2`. Models: Haiku for ingestion, Sonnet for retrieval, Opus for evals/hard cases. Auth: stub in dev, Microsoft Entra ID in M5.
