# CHATLOG.md — Priority Knowledge Base

Session memory, **newest-first**. Each entry: max 5 content bullets + `Process improvement` + `Next session`. See `SESSION_PROTOCOL.md` Closing Ritual Step 2 for the exact format and constraints.

This file is read every chat (last 3 entries, per opening Step 4). Every 10 sessions, the older entries get archived to `docs/CHATLOG_ARCHIVE.md`.

---

## 2026-05-14 — Bootstrap: protocol scaffold + tech stack pinned

- Defined project as agent-driven Priority ERP KB (admin ingests via chat, users query via Retrieval Agent with citations); two agents, Claude API direct.
- Locked tech stack: Next.js + Postgres + pgvector (HNSW), Voyage `voyage-3-large` embeddings + `rerank-2`, Python FastAPI worker added in M2b for OCR/parsing, Microsoft Entra ID in M5 (stub auth before).
- Independent architectural review (subagent) surfaced critical changes adopted: repo moved to `C:\dev\PriorityKB` (out of OneDrive), retrieval (M3) sequenced before media ingestion (M2b), evals + observability + backups land in M1, embedding abstraction with model versioning per row, prompt files hashed and stored with responses, ≥2 admin accounts, degraded mode for outages.
- Brand standards pinned to the Kramer skill (GT Eesti, `--kramer-*` palette, embedded logo); `styles/kramer-brand.css` is the canonical source.
- Generated full scaffold: `CLAUDE.md`, `SESSION_PROTOCOL.md`, `WORKFLOW.md`, `CHATLOG.md`, `README.md`, `docs/ROADMAP.md`, `docs/BACKLOG.md`, `docs/AGENTS.md`, `docs/adr/0001-bootstrap.md` + `docs/adr/README.md`, `prompts/{ingestion,retrieval}-agent.md`, `evals/golden_set.yaml`, `styles/kramer-brand.css`, `package.json`, `pyproject.toml`, `.gitignore`, `.github/workflows/ci.yml`.
- **Process improvement:** Spawning a Plan subagent for an unbiased cold review caught smells the in-conversation self-critique missed (OneDrive corruption risk, missing reranker, eval/backup sequencing). Codified as a habit — for any architectural decision, spawn a cold-review subagent before generating code (see `SESSION_PROTOCOL.md` Step 7's "smaller cleaner first increment" prompt; cold-review is the cleanest version of that check for big decisions).
- **Next session:** M1 Foundation — `git init` + first push to GitHub, Next.js scaffold with `styles/kramer-brand.css` wired in, Postgres + pgvector locally via Docker Compose, Alembic migrations folder structure, embedding abstraction skeleton (interface only), `pg_dump` cron stub.

---

<!-- New entries go directly below the separator above, before this one. -->
