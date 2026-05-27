# ROADMAP.md — Priority Knowledge Base

**Guiding principle:** we are not in a rush. Milestones end when they **actually work** — eval set green, smoke tests pass, manual flow feels right — not on a calendar. If a milestone wants to grow, split it; never expand it.

Pacing: **milestone-by-milestone, open-ended.**

---

## M1 — Foundation

**Goal:** the empty house is built and wired. No features yet, but every gate, guardrail, and observation channel is in place from day one.

### Checklist
- [x] `git init`, first commit, push to GitHub private repo (`priority-kb`) — bootstrap session 2026-05-14 (see CHATLOG).
- [x] Next.js app scaffolded; `styles/kramer-brand.css` imported in the root layout; one branded page renders — see [app/page.tsx](../app/page.tsx), [app/layout.tsx](../app/layout.tsx).
- [x] Docker Compose: Postgres + pgvector locally; HNSW extension enabled — see [docker-compose.yml](../docker-compose.yml) (`pgvector/pgvector:pg16`) + [db/init.sql](../db/init.sql).
- [x] **Drizzle ORM + Drizzle-Kit migrations** configured (per [ADR-0008](adr/0008-orm-and-migration-ownership.md) — supersedes the prior Alembic plan); first migration creates baseline schema (`entries`, `entries_versions`, `chunks`, `audit_log`). Waits on the chunking-strategy ADR for chunk-table shape.
- [x] Embedding abstraction interface (`embed_text(text) → vector`) — see [lib/embedding.ts](../lib/embedding.ts). Contract: `Embedder.embed` / `embedBatch` returning `vector + model + version + tokens_used`; deterministic stub for tests; `EmbeddingUnavailableError` for non-negotiable #12 degraded-mode handoff. Voyage adapter lands with M2a.
- [x] Observability: structured JSON log helper (every Claude/Voyage call → `tokens, latency, cost, prompt_hash, model, model_version`) — see [lib/log.ts](../lib/log.ts) + [ADR-0005](adr/0005-log-event-schema.md) (PRs #35/#36/#37).
- [x] `pg_dump` nightly backup cron stub — see [scripts/backup-db.ps1](../scripts/backup-db.ps1) + [docs/runbooks/backup.md](runbooks/backup.md). Local-dev only (compression + retention + object storage + restore drill all M5).
- [x] Hebrew OCR spike — Azure DI v4.0 (api-version `2024-11-30`) on 5 stratified Priority screenshots × 2 models (`prebuilt-read` + `prebuilt-layout`) PASSED 2026-05-20 on all 4 criteria. Decision: M2b OCR pipeline commits to Azure DI with `prebuilt-layout` as default. Scoring + qualitative notes in [docs/BACKLOG.md](BACKLOG.md) §Ingestion → Stronger Hebrew OCR. Scaffold at [scripts/hebrew-ocr-spike.mjs](../scripts/hebrew-ocr-spike.mjs) + [docs/spikes/hebrew-ocr-spike.md](spikes/hebrew-ocr-spike.md).
- [x] Chunking strategy ADR — see [ADR-0009](adr/0009-chunking-strategy.md). 500-token chunks, 60-token overlap, trailing-merge rule, deterministic / model-free, `js-tiktoken` `o200k_base` local proxy for `chunks.token_count`, title+tags prefix at embed-time only, `entries.body` is post-scrub canonical, composite-FK propagates `sensitivity` from entries to chunks. (The original ADR-0004 reservation for this doc was claimed by the PR-title mechanical floor; 0008 then claimed the next slot.)
- [x] Chunking module implementation — see [lib/chunk.ts](../lib/chunk.ts) per [ADR-0009](adr/0009-chunking-strategy.md) (PRs #52/#53): deterministic 500/60, NFC normalization, forbidden-range detection, `buildEmbedInput`/`getRawSlice` separation.
- [x] `evals/golden_set.yaml` skeleton with 5 placeholder Q/A pairs (Hebrew + English) — see [evals/golden_set.yaml](../evals/golden_set.yaml); fleshed out in M3 (target 15+15).
- [x] CI green on first push (`npm run check` mirrors [.github/workflows/ci.yml](../.github/workflows/ci.yml)).

### Acceptance
A new dev can clone the repo, run `docker compose up && npm install && npm run dev`, see the branded landing page, hit a `/healthz` endpoint that confirms Postgres + pgvector are reachable, and tail a structured log line on first request. CI is green on `main`.

---

## M2a — Text-only ingestion E2E

**Goal:** an admin can chat with the Ingestion Agent and produce a stored, embedded, versioned entry — text only, no media.

**Repo visibility precondition ([ADR-0011](adr/0011-repo-visibility.md)):** real Priority entries land via `POST /api/ingest` (item 4, shipped), the chat UI (item 3, shipped), or `PUT /api/ingest/[id]` (item 5, shipped) — all write to the DB even under the stub agent. **REVERT REPO TO PRIVATE** before typing any real Priority content into any ingestion path, regardless of which checklist item is next. Hard date floor: 2026-06-15.

### Checklist
- [x] Stub auth: `x-stub-user-role: admin | user` header parsed server-side; admin-only routes reject `user` — see [lib/auth.ts](../lib/auth.ts) (`withAdmin` HOF) + [lib/auth.test.ts](../lib/auth.test.ts) (PRs #70/#71).
- [x] Ingestion Agent prompt at [prompts/ingestion-agent.md](../prompts/ingestion-agent.md); hash sealed at process boot via [lib/prompts.ts](../lib/prompts.ts) and pinned onto every `audit_log` row written through the agent path in [lib/ingest.ts](../lib/ingest.ts) (`source:{kind:"agent"}` → `kind:"agent_ingest"` / `"agent_ingest_update"` + non-null `prompt_hash`, enforced by the DB CHECK `audit_log_prompt_hash_required_for_agent`). Caller never supplies the hash — mechanical floor for iron rule #10.
- [x] Chat UI (admin) — streamed Claude responses; agent guides admin through filling `{title, category, tags, body, source, last_verified_at, sensitivity}` — see [app/admin/ingest/page.tsx](../app/admin/ingest/page.tsx) (`"use client"` SSE consumer with AbortController race guard, 503-unavailable banner, 400-max_turns Start-New affordance) + [app/admin/ingest/direct/page.tsx](../app/admin/ingest/direct/page.tsx) (iron-rule-#12 client-fallback shape) + [lib/sse-parse.ts](../lib/sse-parse.ts) (WHATWG §9.2 parser) + [lib/agent-chat-state.ts](../lib/agent-chat-state.ts) (pure reducer mirroring [app/api/agent/ingest/route.ts](../app/api/agent/ingest/route.ts) wire ordering) (PRs #113/#114).
- [x] `POST /api/ingest` accepts the structured entry; runs validation; chunks; calls Voyage; writes `entries`, `entries_versions`, `chunks` — see [app/api/ingest/route.ts](../app/api/ingest/route.ts) + [app/api/ingest/route.test.ts](../app/api/ingest/route.test.ts) + [lib/ingest.ts](../lib/ingest.ts) + [lib/ingest.test.ts](../lib/ingest.test.ts) + [tests/ingest.integration.test.ts](../tests/ingest.integration.test.ts) (PRs #76/#77).
- [x] Version history: every edit appends to `entries_versions` (append-only); current view is the latest version. `PUT /api/ingest/[id]` append path + composite-FK cascade + `SELECT ... FOR UPDATE` concurrency guard live in [lib/ingest.ts](../lib/ingest.ts) (`updateEntry`) with shared Zod schema in [lib/ingest-schema.ts](../lib/ingest-schema.ts); two-connection lock-contention test in [tests/ingest.integration.test.ts](../tests/ingest.integration.test.ts) (PRs #78/#79).
- [x] PII scrub pass: simple regex/heuristic strip on ingest (emails, phone numbers, IDs) — see [lib/scrub.ts](../lib/scrub.ts) + [lib/scrub.test.ts](../lib/scrub.test.ts) (shipped with PR #76). Stronger pass queued at M2b line 82.
- [x] Unit tests with fixture embeddings (no live API) — `createStubEmbedder` in [lib/embedding.ts](../lib/embedding.ts) is the deterministic fixture; consumed by [lib/ingest.test.ts](../lib/ingest.test.ts) + [tests/ingest.integration.test.ts](../tests/ingest.integration.test.ts) (test surface accumulated across PRs #76/#78/#82). Non-negotiable #8 mechanically enforced by [lib/embedding.test.ts](../lib/embedding.test.ts) lines 161–175 (source-file-no-import: rejects any `voyageai`/`@anthropic-ai`/`openai` import in `lib/embedding.ts`).
- [ ] Manual smoke: log 3 real Priority Q&A entries end-to-end. **PRE-STEP:** revert repo visibility to private per [ADR-0011](adr/0011-repo-visibility.md) — this is the planned moment real content first enters the DB.

### Acceptance
Three real entries land in the DB with chunks, embeddings, `embedding_model + embedding_version`, and a prompt hash. Pulling one back via SQL shows all required fields populated. CI green.

---

## M3 — Retrieval E2E *(before media — proves viability)*

**Goal:** a user (stub-auth as `user`) can ask a question and get a cited answer.

### Checklist
- [x] Retrieval Agent prompt at [prompts/retrieval-agent.md](../prompts/retrieval-agent.md); hashed per response — `RETRIEVAL_AGENT_PROMPT_HASH` in [lib/prompts.ts](../lib/prompts.ts) sealed at boot with byte-roundtrip assertion; audit row pins it at [app/api/retrieve/route.ts](../app/api/retrieve/route.ts) on every terminal path under `kind:"agent_retrieval"` (401-from-`withUserOrAdmin` is the only omission, by design — wrapper returns before the handler runs).
- [x] Query UI (user) — single text box, streamed answer with inline citation links: see [app/query/page.tsx](../app/query/page.tsx) (SSE consumer over [lib/query-chat-state.ts](../lib/query-chat-state.ts) reducer + [lib/sse-parse.ts](../lib/sse-parse.ts) WHATWG §9.2 parser).
- [x] Retrieval pipeline: query embedding → pgvector HNSW top-K → Voyage `rerank-2` → top-N to Claude (Sonnet) → answer with citation IDs — async-generator orchestrator at [lib/retrieval-pipeline.ts](../lib/retrieval-pipeline.ts) owning [ADR-0012](adr/0012-retrieval-pipeline.md) §3 + [ADR-0013](adr/0013-hybrid-rrf-tsvector.md) §3 8-row degraded matrix; `AuditOutcome ≡ RetrievalAuditPayload` with zero projection.
- [x] Hybrid search: combine pgvector ANN scores with Postgres `tsvector` keyword match (Hebrew via `simple` config + `unaccent`) — see [lib/retrieval-ann.ts](../lib/retrieval-ann.ts) + [lib/retrieval-keyword.ts](../lib/retrieval-keyword.ts) (`websearch_to_tsquery('simple', unaccent(...))` on trigger-maintained `entries.tsv` + GIN) fused via RRF (default `k=60`, env knob `RETRIEVAL_RRF_K`); per [ADR-0013](adr/0013-hybrid-rrf-tsvector.md).
- [x] Citations resolve to entry detail page (read-only for `user` role) — see [app/entries/[id]/page.tsx](../app/entries/[id]/page.tsx) + [app/entries/[id]/not-found.tsx](../app/entries/[id]/not-found.tsx) + [lib/entries.ts](../lib/entries.ts) (`findEntryForRole` enforces iron-rule #6 in SQL WHERE; UUID regex pre-check + null-collapse closes the existence-leak side channel — auth-failure / malformed-id / missing-id / sensitivity-mismatch all return the same `null` and render the same `notFound()` page). Citation cards in [app/query/page.tsx](../app/query/page.tsx) link via `next/link` to `/entries/[id]`. `kind:"entry_view"` audit row on both served and denied paths. `resolveRoleFromHeader` extracted to [lib/auth.ts](../lib/auth.ts) as the canonical stub-auth parser shared by `withAdmin`/`withUserOrAdmin` and the page.
- [ ] `evals/golden_set.yaml` filled in: 30+ Q/A pairs (15 Hebrew + 15 English), each with expected `source_ids[]` — **Phase A shipped** ([evals/golden_set.yaml](../evals/golden_set.yaml): 32 cases, 16 he + 16 en); all currently `phase: queued` with empty `expected_source_ids[]`. Phase B (populate UUIDs against real entries) is gated on [ADR-0011](adr/0011-repo-visibility.md) private-revert + M2a item 8 (3 real entries logged) before any real Priority content lands in the DB.
- [ ] Eval runner (`npm run eval` or `pytest evals/`) reports recall@5, citation precision; CI runs it on PR — **runner shipped** at [evals/run.ts](../evals/run.ts) (+ [evals/lib.ts](../evals/lib.ts) + [evals/schema.ts](../evals/schema.ts)); `npm run eval` / `npm run eval:lint` wired in [package.json](../package.json) and `eval:lint` chained into `npm run check`. Reports `n/a (no measured cases)` for both metrics until item 6's Phase B `phase: ready` flip lands.
- [x] Degraded mode: keyword-only fallback when Claude or Voyage 5xx for >X seconds; UI banner. Orchestrator emits `degraded`/`degraded_reason` on terminal `done`/`chunks_only` per ADR-0012 §3 + ADR-0013 §3; dynamic banner at [app/query/page.tsx](../app/query/page.tsx) consumes via [lib/degraded-copy.ts](../lib/degraded-copy.ts) (one entry per `DegradedReasonCode`). `no_content` wire event extension queued in BACKLOG to surface `no_keyword_match_under_embed_outage` to the UI; audit row already carries it.

### Acceptance
On the golden eval set, retrieval recall@5 ≥ 0.8 and citation precision ≥ 0.9. Three real-world Priority questions answered convincingly with citations. Degraded mode demoed by killing the Voyage env var. **Acceptance gating:** the metric bar is currently unmeasurable — golden-set `phase: ready` flip + [ADR-0011](adr/0011-repo-visibility.md) private-revert + M2a item 8 (3 real Priority entries) are joint prerequisites to even running the measurement. Implementation (items 1-4 + 5 + 8) is complete; acceptance is Phase-B-gated.

---

## M2b — Media ingestion *(now that retrieval works)*

**Goal:** admins can attach screenshots, PDFs, and Word docs; the worker parses, OCRs, chunks, embeds.

### Checklist
- [x] **Review and adapt Python rules from [`docs/PYTHON_RULES_DRAFT.md`](PYTHON_RULES_DRAFT.md)** — three-bucket sort (adopt / adapt / reject) per the file's "How to use this file at M2b import time" section. Adopted rules land in [SESSION_PROTOCOL.md §Python pre-push](../SESSION_PROTOCOL.md#python-pre-push); bucket assignments + Rule 7 / 8 / 9 dispositions + 3 net-new iron-rule mirror rules in [ADR-0016](adr/0016-python-rules-adoption.md). DRAFT flipped to imported-for-archaeology status. Per [ADR-0006](adr/0006-process-alignment-with-external-audit.md).
- [x] Python FastAPI worker scaffolded at `api/`; `pyproject.toml` activated — see [api/main.py](../api/main.py) (FastAPI app + `/healthz`), [api/log.py](../api/log.py) ([ADR-0018](adr/0018-python-logging-primitive.md) — runtime logger, NOT the LogEvent emitter), [api/tests/test_iron_rule_8_no_live_api_imports.py](../api/tests/test_iron_rule_8_no_live_api_imports.py) (iron-rule #8 mirror per [ADR-0016](adr/0016-python-rules-adoption.md) §8 #1), [Makefile](../Makefile) `py-check` gate, [.github/workflows/ci.yml](../.github/workflows/ci.yml) `python` job. ADR-0016 §Mitigations #1 floor walk recorded in ADR-0016 Amendment 2026-05-26; substantive walk deferred to M2b #3.
- [x] `pgqueuer` (or equivalent) job queue table; Next.js enqueues, worker consumes — see [drizzle/migrations/0004_jobs.sql](../drizzle/migrations/0004_jobs.sql) + [lib/jobs.ts](../lib/jobs.ts) `enqueueJob` (Node producer) + [api/jobs.py](../api/jobs.py) `claim_one`/`mark_done`/`mark_failed` (Python consumer) + [api/worker.py](../api/worker.py) poll loop + SIGTERM. Per [ADR-0019](adr/0019-job-queue.md) — custom SKIP LOCKED + polling; pgqueuer + Procrastinate rejected (ADR-0008 schema-ownership conflict). Python `LogEventJob` emitter at [api/log_event.py](../api/log_event.py) per [ADR-0020](adr/0020-python-log-event-emitter.md) closes the M2b #3 observability gap (vendor variants land at M2b #5+ first call site).
- [x] File upload endpoint → blob storage (local FS in dev, prep S3 abstraction for prod) — see [lib/blob-storage.ts](../lib/blob-storage.ts) `BlobStore` interface + `LocalFSBlobStore` content-addressed implementation + `createInMemoryBlobStore` test seam; [app/api/ingest/upload/route.ts](../app/api/ingest/upload/route.ts) `POST /api/ingest/upload` (`withAdmin` + multipart via `NextRequest.formData()` + Content-Length pre-check + post-buffer fallback + content-type allowlist + placeholder-entry-inline pattern carrying admin-supplied sensitivity per iron rule #6 + `enqueueJob` with `idempotencyKey: contentHash` directly per ADR-0019 §D3). S3-compatible BlobStore implementation queued for M5 hosting decision; see `docs/BACKLOG.md` "S3-compatible BlobStore implementation."
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
