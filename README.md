# Priority Knowledge Base

An agent-driven knowledge base for **Priority ERP**. Admins log workflows, bug fixes, ticket resolutions, walkthroughs, best practices, and Q&A by chatting with the **Ingestion Agent** and attaching screenshots, PDFs, and documents. End users ask the **Retrieval Agent** questions; it answers with citations to the underlying KB entries.

The system is designed to **learn and adapt** — the more entries it absorbs, the more expert it becomes at answering Priority questions.

---

## Vision

A senior Priority consultant in your team — except it never forgets a ticket fix, never loses a walkthrough, never grows tired of saying "yes, we've seen this before and here's exactly how to fix it." The KB is the long-term memory; the agents are the interface.

---

## Non-negotiables

See `CLAUDE.md` for the full list. The load-bearing ones:

1. **Credentials never committed.** `.env*` gitignored.
2. **Every write goes through the Ingestion Agent** — consistent entry shape.
3. **Every retrieval answer cites sources.**
4. **Admin-only writes; everyone can query** (enforced server-side).
5. **Nightly backups, 30-day retention, restore drill in M5.**
6. **Entries tagged `public | internal | restricted`** — retrieval respects the tag.
7. **Source pointer + `last_verified_at` on every entry.**
8. **Tests never call live AI APIs.**
9. **Embedding model + version stored per row.**
10. **Prompts in git, hashed; hash stored with every response.**
11. **≥2 admin accounts.**
12. **Degraded mode** when Claude/Voyage are down.
13. **Kramer brand by default** — `styles/kramer-brand.css`.

---

## Structure

```
C:\dev\PriorityKB\
├── CLAUDE.md                 ← always-read-first
├── SESSION_PROTOCOL.md       ← opening ritual + recurring hygiene + Python pre-push + ADR discipline + session-wide rules
├── CLOSE_SESSION_PROTOCOL.md ← closing ritual + Session Score + Worked example (loaded at close-time only; see ADR-0017)
├── WORKFLOW.md               ← chat archetypes, pre-push gate, red flags
├── CHATLOG.md                ← session memory (newest-first)
├── docs/
│   ├── ROADMAP.md            ← phased plan
│   ├── BACKLOG.md            ← scope-creep capture
│   ├── AGENTS.md             ← Ingestion + Retrieval Agent specs
│   └── adr/                  ← architectural decision records
├── prompts/                  ← versioned agent prompts (hashed per response)
├── evals/                    ← retrieval eval golden set
├── styles/                   ← Kramer brand CSS
└── .github/workflows/ci.yml  ← CI mirror of the pre-push gate
```

(Application code lands in `app/` and `api/` as M1 progresses.)

---

## Tech stack

- **Frontend:** Next.js (React) — Kramer-branded UI per `styles/kramer-brand.css`.
- **Backend (M1):** Next.js API routes + Postgres.
- **Backend (M2b+):** Python FastAPI worker + job queue (`pgqueuer`) for document parsing, OCR, embedding.
- **Database:** PostgreSQL with **pgvector** (HNSW index) — structured + full-text + semantic search in one store.
- **Embeddings:** Voyage AI `voyage-3-large` (multilingual, top quality).
- **Reranker:** Voyage `rerank-2` — second-stage ranking in retrieval.
- **Models:** Haiku for ingestion (form-filling), Sonnet for retrieval (synthesis), Opus for evals/hard cases.
- **Auth:** stub header in dev/M1-M4, **Microsoft Entra ID** OAuth in M5.
- **OCR:** Azure Document Intelligence (primary), Tesseract (offline fallback). Hebrew + English.
- **File storage:** local filesystem in dev, S3-compatible bucket in production.
- **Schema migrations:** Alembic.
- **Observability:** structured JSON logs per Claude/Voyage call (tokens, latency, cost, prompt hash).

---

## Git remote

Hosted on **GitHub** as a private repository. See `docs/adr/0001-bootstrap.md` for the rationale.

## CI/CD posture

**Full CI** on push + PR. `.github/workflows/ci.yml` runs:
- Node side: ESLint, Prettier --check, `tsc --noEmit`, Vitest.
- Python side (when M2b adds Python): Ruff, Black --check, Mypy --strict, Pytest with coverage.

Pre-push gate (`npm run check` and `make py-check`) is a **verbatim local mirror** so red CI is caught in seconds, not minutes.

---

## Mutual agreement

**Claude commits to:**
- Run the opening ritual on every first message.
- Surface uncertainty via `AskUserQuestion`; not guess on non-negotiables.
- Build the narrowest E2E increment; defer everything else to BACKLOG.
- Run the closing ritual on every farewell; produce a CHATLOG entry that orients next session.
- Land one concrete protocol/rule improvement per session, in-session.
- Reply in English in operating sessions (this chat, file edits, ADRs, CHATLOG) per `CLAUDE.md` language convention. Retrieval Agent / Ingestion Agent product surfaces keep mirror policy for end users — see `docs/AGENTS.md`.

**User commits to:**
- Mount the project folder on a fresh chat (or let Step 2 self-heal).
- Approve / refine the closing-ritual improvement before commit.
- Run `npm run check` (and later `make py-check`) before every push.
- Keep secrets out of commits.

---

## Getting started (developer)

```bash
cd "C:\dev\PriorityKB"

# Node side
npm install
npm run check         # lint + format + typecheck + test — must pass before push

# Database — Postgres + pgvector via Docker Compose
cp .env.example .env  # adjust DATABASE_URL if 5432 is taken (e.g., map 5433:5432 in docker-compose.yml)
docker compose up -d
npm run dev           # Next.js runs on host; DB in container at localhost:5432
# Smoke: http://localhost:3000/healthz should return {"ok":true,"pgvector":true}
# Manual extension check:
# docker compose exec db psql -U postgres -d priority_kb -c "SELECT extname FROM pg_extension WHERE extname='vector';"

# Python side (M2b+)
# python -m venv .venv && .venv\Scripts\activate
# pip install -e ".[dev]"
# make py-check
```

See `docs/ROADMAP.md` for what to build next.
