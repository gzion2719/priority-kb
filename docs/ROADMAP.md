# ROADMAP.md — Priority Knowledge Base

**Guiding principle:** we are not in a rush. Milestones end when they **actually work** — eval set green, smoke tests pass, manual flow feels right — not on a calendar. If a milestone wants to grow, split it; never expand it.

Pacing: **milestone-by-milestone, open-ended.**

---

## M1 — Foundation

**Goal:** the empty house is built and wired. No features yet, but every gate, guardrail, and observation channel is in place from day one.

### Checklist
- [ ] `git init`, first commit, push to GitHub private repo (`priority-kb`).
- [ ] Next.js app scaffolded; `styles/kramer-brand.css` imported in the root layout; one branded page renders.
- [ ] Docker Compose: Postgres + pgvector locally; HNSW extension enabled.
- [ ] **Drizzle ORM + Drizzle-Kit migrations** configured (per [ADR-0008](adr/0008-orm-and-migration-ownership.md) — supersedes the prior Alembic plan); first migration creates baseline schema (`entries`, `entries_versions`, `chunks`, `audit_log`). Waits on the chunking-strategy ADR for chunk-table shape.
- [ ] Embedding abstraction interface (`embed_text(text) → vector`) — no implementation yet, just the contract + `embedding_model` + `embedding_version` columns on `chunks`.
- [ ] Observability: structured JSON log helper (every Claude/Voyage call → `tokens, latency, cost, prompt_hash, model, model_version`).
- [ ] `pg_dump` nightly backup cron stub (script + scheduled task; restore deferred to M5 drill).
- [ ] Hebrew OCR spike: 1-day prototype against Azure Document Intelligence with 5 sample Priority screenshots; record quality notes in BACKLOG.
- [ ] Chunking strategy doc (M1 ADR-0004) — default ~500 token chunks with overlap, semantic boundaries where possible. (ADR-0002 and 0003 were claimed by the branching-policy + CI-security-gates work.)
- [ ] `evals/golden_set.yaml` skeleton with 5 placeholder Q/A pairs (Hebrew + English) — fleshed out in M3.
- [ ] CI green on first push (`npm run check` mirrors `.github/workflows/ci.yml`).

### Acceptance
A new dev can clone the repo, run `docker compose up && npm install && npm run dev`, see the branded landing page, hit a `/healthz` endpoint that confirms Postgres + pgvector are reachable, and tail a structured log line on first request. CI is green on `main`.

---

## M2a — Text-only ingestion E2E

**Goal:** an admin can chat with the Ingestion Agent and produce a stored, embedded, versioned entry — text only, no media.

### Checklist
- [ ] Stub auth: `x-stub-user-role: admin | user` header parsed server-side; admin-only routes reject `user`.
- [ ] Ingestion Agent prompt at `prompts/ingestion-agent.md`; hash computed and stored on each entry's `audit_log` row.
- [ ] Chat UI (admin) — streamed Claude responses; agent guides admin through filling `{title, category, tags, body, source, last_verified_at, sensitivity}`.
- [ ] `POST /api/ingest` accepts the structured entry; runs validation; chunks; calls Voyage; writes `entries`, `entries_versions`, `chunks`.
- [ ] Version history: every edit appends to `entries_versions` (append-only); current view is the latest version.
- [ ] PII scrub pass: simple regex/heuristic strip on ingest (emails, phone numbers, IDs) — full pass deferred to M2b.
- [ ] Unit tests with fixture embeddings (no live API).
- [ ] Manual smoke: log 3 real Priority Q&A entries end-to-end.

### Acceptance
Three real entries land in the DB with chunks, embeddings, `embedding_model + embedding_version`, and a prompt hash. Pulling one back via SQL shows all required fields populated. CI green.

---

## M3 — Retrieval E2E *(before media — proves viability)*

**Goal:** a user (stub-auth as `user`) can ask a question and get a cited answer.

### Checklist
- [ ] Retrieval Agent prompt at `prompts/retrieval-agent.md`; hashed per response.
- [ ] Query UI (user) — single text box, streamed answer with inline citation links.
- [ ] Retrieval pipeline: query embedding → pgvector HNSW search top-K → Voyage `rerank-2` → top-N to Claude (Sonnet) → answer with citation IDs.
- [ ] Hybrid search: combine pgvector ANN scores with Postgres `tsvector` keyword match (Hebrew via `simple` config + `unaccent`).
- [ ] Citations resolve to entry detail page (read-only for `user` role).
- [ ] `evals/golden_set.yaml` filled in: 30+ Q/A pairs (15 Hebrew + 15 English), each with expected `source_ids[]`.
- [ ] Eval runner (`npm run eval` or `pytest evals/`) reports recall@5, citation precision; CI runs it on PR.
- [ ] Degraded mode: keyword-only fallback when Claude or Voyage 5xx for >X seconds; UI banner.

### Acceptance
On the golden eval set, retrieval recall@5 ≥ 0.8 and citation precision ≥ 0.9. Three real-world Priority questions answered convincingly with citations. Degraded mode demoed by killing the Voyage env var.

---

## M2b — Media ingestion *(now that retrieval works)*

**Goal:** admins can attach screenshots, PDFs, and Word docs; the worker parses, OCRs, chunks, embeds.

### Checklist
- [ ] **Review and adapt Python rules from [`docs/PYTHON_RULES_DRAFT.md`](../docs/PYTHON_RULES_DRAFT.md)** — three-bucket sort (adopt / adapt / reject) per the file's "How to use this file at M2b import time" section. Land the adopted rules in `SESSION_PROTOCOL.md` under a `Python pre-push` sub-section + write an M2b ADR documenting bucket assignments. Per [ADR-0006](adr/0006-process-alignment-with-external-audit.md).
- [ ] Python FastAPI worker scaffolded at `api/`; `pyproject.toml` activated.
- [ ] `pgqueuer` (or equivalent) job queue table; Next.js enqueues, worker consumes.
- [ ] File upload endpoint → blob storage (local FS in dev, prep S3 abstraction for prod).
- [ ] PDF parsing (`pypdf`), Word parsing (`python-docx`).
- [ ] OCR pipeline: Azure Document Intelligence primary, Tesseract fallback; Hebrew + English.
- [ ] Image processing: screenshots get OCR'd + caption extracted; stored as chunks attributed to the parent entry.
- [ ] Stronger PII scrub on extracted text (customer names, prices, vendor IDs).
- [ ] Worker tests with stub OCR + stub embedding.
- [ ] Manual smoke: ingest a real Priority screenshot + a 5-page PDF; verify retrievable.

### Acceptance
Uploading a Hebrew Priority screenshot via the admin chat results in a queued job, OCR'd text, chunked + embedded entry — and a retrieval query against its content surfaces it in top 3.

---

## M4 — Polish

**Goal:** the admin and user surfaces are actually pleasant to use.

### Checklist
- [ ] Admin entry browser: list, filter by category/tag/sensitivity, search.
- [ ] Admin entry editor: edit existing entry (appends a new `entries_versions` row).
- [ ] Version history viewer: diff between versions; one-click revert.
- [ ] Tag management: rename, merge, suggest from existing entries.
- [ ] Stale-entry detection: nightly job flags entries where `last_verified_at` > 6 months ago AND retrieval frequency > N; surfaces in admin dashboard.
- [ ] Citation hover preview on retrieval answers.

### Acceptance
Admin can correct a wrong entry, see the version history, and revert if needed. Stale-entry dashboard shows a non-empty list of candidates for re-verification.

---

## M5 — Production

**Goal:** real auth, real hosting, real backups, tested degraded mode.

### Checklist
- [ ] Microsoft Entra ID OAuth app registration (dev + prod tenants); role from group membership.
- [ ] Remove stub auth; enforce Entra everywhere.
- [ ] Hosting: pick provider (Azure App Service / Vercel + managed Postgres / VPS) — decide via ADR.
- [ ] S3-compatible bucket for uploads (Azure Blob if hosting on Azure).
- [ ] Backups: nightly `pg_dump` → object storage, 30-day retention.
- [ ] **Restore drill**: spin up a fresh Postgres, restore last night's backup, validate row counts + run a retrieval query. Document the runbook.
- [ ] Secrets in managed vault (Azure Key Vault / equivalent), not `.env`.
- [ ] Rate limits on ingestion + retrieval endpoints.
- [ ] Production observability dashboard (token costs per day, retrieval latency p95, eval pass rate trend).

### Acceptance
Two admin accounts can log in via Entra; a user account can query but not write. Restore drill passes. Hosted instance answers a real question in <3s p95.

---

## M6 — Optional

- [ ] Teams integration (bot surface for the Retrieval Agent).
- [ ] Stale-entry "is this still true?" agent — re-reads entries against current Priority docs, suggests updates.
- [ ] Multi-tenant (if other Priority shops want this).
- [ ] Multi-language UI (RTL polish for Hebrew users).

---

## Phase gates

Between every milestone:
1. Eval set passes its acceptance bar.
2. CHATLOG has a clean closing entry for the milestone-final session.
3. README updated if the user-visible shape changed.
4. ADR written for any non-trivial decision made during the milestone.
