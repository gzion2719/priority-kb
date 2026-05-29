# Runbook — M2b #10 media-ingestion smoke (synthetic, development-stage)

Proves the media-ingestion pipeline end-to-end against a live local stack:

```
POST /api/ingest/upload (admin)        placeholder entry + queued job
  → python -m api.worker claims job
    → parse_pdf  (PDF)  /  stub-OCR  (PNG)
      → PUT /api/ingest/<id>  (worker, x-stub-user-role: admin)
        → updateEntry: entries_versions v2 + re-chunk + re-embed (stub)
POST /api/retrieve (user)              entry surfaces in the `candidates` event
```

Driver: [`scripts/media_smoke.py`](../../scripts/media_smoke.py). It generates
the fixtures, uploads, polls the job, queries retrieval, and dumps the SQL
evidence — one command once the stack is up.

## What this smoke is (and is NOT)

This is a **pipeline-wiring** smoke, mirroring the M2a #8 / M3 stub-embedder
framing. It is **not** a retrieval-quality measurement.

- **No Azure creds** → the OCR adapter resolves to the **stub**
  (`get_ocr_adapter()` returns `StubOcrAdapter` unless both
  `AZURE_DOCINTEL_ENDPOINT` + `AZURE_DOCINTEL_KEY` are set). The PNG body is
  therefore deterministic hash text — the **PNG leg proves OCR dispatch +
  worker wiring only**. The **PDF leg** (real `parse_pdf`) is the meaningful,
  keyword-retrievable target.
- The stub embedder + stub reranker are not semantic, **and** the stub
  synthesizer cites a sentinel UUID (`STUB_SYNTH_SENTINEL_UUID`, the zero
  UUID) that fails citation-validation. So the retrieve terminal event is
  **`chunks_only` with `degraded_reason: citation_validation_failed`** — this
  is the **EXPECTED** stub outcome, not a failure. The pass signal is **"the
  entry appears in the `candidates` event"** (fed by the deterministic keyword
  lane), NOT `done.citation_ids` (structurally always empty under stub synth)
  and NOT a semantic top-3 rank.

Semantic top-3 / recall stays gated on the real Voyage embedder, exactly as
M3 Acceptance already states. The **real-data** smoke (real Priority
screenshot + real PDF) is deferred to the production-stage transition gate per
[ADR-0011 Amendment 2026-05-27](../adr/0011-repo-visibility.md#amendment-2026-05-27--revert-trigger-event-gated-to-production-stage-transition).

## Prerequisites

1. **Docker Desktop running** (the daemon, not just the installer). The
   `db` service in [`docker-compose.yml`](../../docker-compose.yml) is
   Postgres + pgvector; `db/init.sql` installs the `vector` + `unaccent`
   extensions only (no tables — so the Drizzle baseline migrate does not
   collide).
2. Node deps installed (`npm install`), Python deps installed
   (`pip install -e ".[dev]"` or at least `httpx`, `psycopg`, `pypdf`,
   `reportlab`).

## Sequence

```bash
# 1. Postgres up + schema
docker compose up -d
docker compose exec db pg_isready -U postgres        # wait until "accepting connections"
npm run db:migrate                                   # drizzle-kit migrate (baseline + 0004 jobs + 0005 caption)

# 2. Next dev server (background, :3000) — reads .env.local
npm run dev    # leave running in its own terminal

# 3. Worker (background) — DOES NOT read .env.local; export its env explicitly.
#    Use the SAME DATABASE_URL as .env.local and the SAME blob dir the upload
#    route writes to (default ./blob-storage/dev).
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/priority_kb"
export BLOB_STORAGE_DIR="./blob-storage/dev"
export INGEST_API_BASE_URL="http://localhost:3000"
python -m api.worker
#    Confirm the boot log: "worker starting" with ocr_adapter=StubOcrAdapter.
#    If it exits 1, one of the three env vars is missing in THIS shell.

# 4. (optional) warm the route so the worker's first PUT doesn't race Next's
#    cold compile:
curl -s http://localhost:3000/healthz >/dev/null

# 5. Run the smoke (separate terminal). DATABASE_URL must point at the same DB.
python scripts/media_smoke.py \
    --base-url http://localhost:3000 \
    --database-url "postgresql://postgres:postgres@localhost:5432/priority_kb"
```

Exit 0 = both legs passed. The script prints, per leg: upload entry/job ids,
job state transitions, `entries_versions` rows (expect v2), chunk count +
`embedding_model`/`embedding_version`, audit rows, and (PDF leg) the
`candidates` membership check.

### SQL evidence (manual cross-check)

```bash
docker compose exec db psql -U postgres -d priority_kb -c \
  "SELECT id, title, source_pointer FROM entries WHERE source_pointer LIKE 'synthetic-fixture-2026-05-29-media-smoke-%';"
docker compose exec db psql -U postgres -d priority_kb -c \
  "SELECT entry_id, version_no FROM entries_versions ORDER BY entry_id, version_no;"
docker compose exec db psql -U postgres -d priority_kb -c \
  "SELECT id, queue_name, state, attempts FROM jobs ORDER BY created_at DESC LIMIT 4;"
```

### Teardown

```bash
# stop the worker + dev server (Ctrl-C in their terminals), then:
docker compose down            # add -v to also drop the volume
rm -rf ./.smoke-fixtures       # generated fixtures (gitignored)
```

## Captured evidence

Live run on 2026-05-29 against local docker Postgres (`priority-kb-db`),
`npm run dev` (Next 16.2.6, :3000), and `python -m api.worker`
(`worker_id=worker-DESKTOP-…`, `ocr_adapter=StubOcrAdapter`). Both legs
**PASS**.

```
=== LEG: PDF (parse_pdf, keyword-retrievable) ===
  uploaded -> entry_id=130dc247-… job_id=c4a07b14-… created=True
    job c4a07b14 -> state=queued
    job c4a07b14 -> state=done   attempts=0
  entries_versions: [(1, 37), (2, 2296)]        # v1 placeholder -> v2 parsed PDF
  chunks: count=2 model=stub-sha256 version=v1  # re-chunked + re-embedded
  audit (entry): [('ingest', None), ('ingest_update', 'worker-DESKTOP-…')]
  audit (job):   ['job_enqueued', 'job_dispatched', 'ingest_update', 'job_done']
  retrieve('requisition') terminal=chunks_only candidates=5 entry_in_candidates=True
  LEG PDF: PASS

=== LEG: PNG (stub-OCR dispatch + worker wiring) ===
  uploaded -> entry_id=8db79447-… job_id=7dc5937f-… created=True
    job 7dc5937f -> state=done   attempts=0
  entries_versions: [(1, 37), (2, 134)]         # v2 body = deterministic stub-OCR hash text
  chunks: count=1 model=stub-sha256 version=v1
  audit (entry): [('ingest', None), ('ingest_update', 'worker-DESKTOP-…')]
  audit (job):   ['job_enqueued', 'job_dispatched', 'ingest_update', 'job_done']
  LEG PNG: PASS

=== SMOKE RESULT: PASS ===
```

Notes confirming the expected stub behavior:

- **`terminal=chunks_only`** on the PDF retrieve is the EXPECTED outcome
  (`degraded_reason: citation_validation_failed`) — the stub synthesizer
  cites the zero-UUID sentinel, which fails candidate-membership validation.
  The pass signal is `entry_in_candidates=True` (deterministic keyword lane),
  not a synthesized `done` answer.
- The PDF `v2` body is the real `parse_pdf` extraction (2296 chars of the
  synthetic requisition text); the PNG `v2` body (134 chars) is the
  `StubOcrAdapter` hash text — wiring proven, OCR quality not (no Azure creds).
- `entry_id` appears as the top-level `audit_log.entry_id` FK column;
  `worker_id` is in `payload.worker_id` on the worker-written `ingest_update`
  row; `occurred_at` is the audit timestamp column.

### Gotcha hit during the run (worth knowing)

A stale Turbopack `.next/dev` cache made `/api/retrieve` + `/api/ingest/upload`
500 with `Cannot find module 'zod'` / `ComponentMod.handler is not a function`
while `/api/ingest` worked — an inconsistent dev-cache resolution glitch (zod
resolves fine via Node). Fix: stop the dev server, `rm -rf .next`, restart.
Not a code issue.
