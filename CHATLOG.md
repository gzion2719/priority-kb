# CHATLOG.md — Priority Knowledge Base

Session memory, **newest-first**. Each entry: max 5 content bullets + `Process improvement` + `Next session`. See `SESSION_PROTOCOL.md` Closing Ritual Step 2 for the exact format and constraints.

This file is read every chat (last 3 entries, per opening Step 4). Every 10 sessions, the older entries get archived to `docs/CHATLOG_ARCHIVE.md`.

---

## 2026-05-14 — Bootstrap: scaffold, push, prereqs cleared

- Generated full protocol scaffold (18 files) at `C:\dev\PriorityKB` (deliberately off OneDrive per ADR-0001); pushed to private GitHub repo `gzion2719/priority-kb` on `main`; repo description + 5 topics set via `gh`.
- Independent Plan-subagent review surfaced and forced adoption of: OneDrive avoidance, Voyage `rerank-2` in M3 (not later), evals + observability + `pg_dump` cron land in M1, embedding abstraction with model+version per row, prompt files hashed and stored with every response, ≥2 admin accounts, degraded mode for outages.
- Stack locked: Next.js + Postgres+pgvector (HNSW), Voyage `voyage-3-large` embeddings + `rerank-2` reranker, Haiku/Sonnet/Opus model split (ingestion/retrieval/evals), Python FastAPI worker added in M2b only, Microsoft Entra ID deferred to M5 with `x-stub-user-role` header in dev. Brand: Kramer (`styles/kramer-brand.css`).
- Sequencing flipped: **M3 retrieval before M2b media** — text-only retrieval E2E is the viability proof.
- Prereqs swept: Node v24.14.1 ✓, Python 3.12.10 ✓, Docker + WSL2 working (after `wsl --install` recovered a corrupted state) ✓, `gh` authenticated ✓, CRLF auto-handling on ✓.
- **Process improvement:** SESSION_PROTOCOL.md Closing Ritual "When to run" gained a status-update-is-not-a-farewell clarification, after this session treated a GitHub URL share as a farewell signal (see `SESSION_PROTOCOL.md` Closing Ritual "What does NOT trigger the ritual").
- **Next session:** M1 Foundation first slice — `create-next-app` scaffold in `.` with TypeScript + app router + ESLint, `styles/kramer-brand.css` imported in root layout, one branded landing page renders. Docker-Compose Postgres+pgvector + Alembic baseline come the session after.

---

<!-- New entries go directly below the separator above, before this one. -->
