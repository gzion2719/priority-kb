# ADR-0021 — Worker→Node HTTP callback for the M2b #5 ingest path (Option Y)

**Status:** Accepted (M2b #5).

## Context

[ROADMAP M2b #5](../ROADMAP.md) ships the worker-side ingest path: a Python worker
parses an uploaded PDF / DOCX blob and the extracted text lands as the entry
body, replacing the `[pending media OCR — awaiting worker]` placeholder
[app/api/ingest/upload/route.ts](../../app/api/ingest/upload/route.ts) wrote at
upload time.

Two architectural shapes are available for "Python parses → entry body
updated → chunks re-derived + re-embedded":

- **Option X — Python writes-direct.** The Python worker mirrors
  [lib/scrub.ts](../../lib/scrub.ts), [lib/chunk.ts](../../lib/chunk.ts),
  [lib/embedding.ts](../../lib/embedding.ts), [lib/ingest.ts](../../lib/ingest.ts)
  `updateEntry` in Python: scrub + tiktoken `o200k_base` chunking + Voyage
  adapter + `entries` UPDATE + `entries_versions` append + `chunks`
  delete+insert. Fires Python iron-rule mirrors #9 (chunks carry
  `embedding_model` + `embedding_version`) and #10 N/A (no agent), and is
  the first Python Voyage call site.
- **Option Y — Worker→Node HTTP callback.** The Python worker parses the
  blob to text, then issues `PUT /api/ingest/[id]` against the existing
  Node route, which already does scrub + chunk + embed + version-append.
  Voyage stays Node-side; no Python chunking, no Python Voyage adapter.

The Option X scope was sized at ~700–1000 LOC + ~50–80 tests + a separate
cross-language chunking-parity ADR ([js-tiktoken](https://github.com/dqbd/tiktoken)
and the Python [tiktoken](https://github.com/openai/tiktoken) must agree on
token counts byte-for-byte or chunks drift between Node and Python ingest
paths). The Option Y scope is the parser modules + a worker handler that
parses + HTTP-calls Node. The plan-review process picked Option Y for this
PR.

Three sub-decisions this ADR also pins:

1. The `worker_chunk_write` `audit_log.kind` discriminator that
   [ADR-0019 §D8 #2](0019-job-queue.md) reserved for "the worker's terminal
   entry-creation row" is **retired** under Option Y — the worker has no
   chunk-write surface; the existing `ingest_update` `audit_log.kind`
   covers worker-induced updates. Worker forensics are preserved via an
   optional `x-worker-id` header that the Node PUT logs into
   `audit_log.payload.worker_id`.
2. The placeholder-entry pattern from M2b #4 means the upload-time
   `createEntry` call writes `entries_versions` row v1 with body
   `[pending media OCR — awaiting worker]`. After the worker's PUT lands,
   v1 stays as the sentinel forever; v2 carries the real parsed text.
   This is documented as accepted M2b limitation, NOT fixed in this PR.
3. The worker-to-Node auth is M2b-only: the worker sends
   `x-stub-user-role: admin` (the same dev-stub all admin requests use
   per [lib/auth.ts](../../lib/auth.ts)). Production hardening is filed
   to M5 alongside Microsoft Entra ID adoption.

## Decision

### D1 — Architecture: Option Y (worker→Node HTTP callback)

The Python worker's media-ingest handler calls Node's
`PUT /api/ingest/[id]` with a full-body update containing the parsed text.
Voyage embedding, chunking, scrubbing, and version-append all stay on the
Node side via the existing `updateEntry`.

**Trade-off accepted:** one cross-language HTTP round-trip per
ingestion (admin-paced workload, acceptable). **Trade-off avoided:**
cross-language chunking parity bug class; first Python Voyage call site
+ adapter + iron-rule-#8 mirror test all deferred to a session that
genuinely needs them.

### D2 — `worker_chunk_write` `audit_log.kind` discriminator retired

[ADR-0019 §D8 #2](0019-job-queue.md) said:

> `audit_log.kind = worker_chunk_write` covers the worker's terminal
> entry-creation row when the implementation PR lands; the discriminator
> does not match `agent_%` and the prompt-hash CHECK does not fire — correctly,
> because no prompt is being invoked.

This ADR retires `worker_chunk_write`. Under Option Y the worker does
NOT write chunks directly; the existing `ingest_update` discriminator
covers worker-induced updates (the worker calls Node's `updateEntry` via
HTTP, which writes its standard `audit_log.kind = "ingest_update"` row).

If a future PR re-introduces Python-side chunk writes (e.g., Option X
flip for a performance optimization), this ADR's §D2 is the
re-introduction trigger — re-add `worker_chunk_write` to the
`AuditKind` union, re-amend ADR-0019, and add the Python iron-rule #9
mechanical-floor test for the new write path.

### D3 — Worker identity surfaced via optional `x-worker-id` header

The Node PUT route reads `x-worker-id` (case-insensitive); when
present, the value is logged into `audit_log.payload.worker_id`
alongside the existing `source` / `version_no` / chunk-count fields.
Human admin edits omit the header (browser doesn't send it); worker
PUTs always include it.

Header value shape: the worker's `make_worker_id()` output —
`worker-<hostname>-<pid>-<random4>` per
[ADR-0019 §D6](0019-job-queue.md) — so a stuck row's owning worker is
identifiable from a single `audit_log` row.

The route also threads `job_id` from `x-worker-job-id` (same shape;
optional) so post-mortems can correlate audit rows back to the queue
state.

**Why a header, not a body field:** keeps `IngestBody` (and its Zod
schema) untouched. The header is a transport-layer signal about
attribution, not a content-layer field about the entry. Future workers
that don't want to claim a `worker_id` simply omit the header.

### D4 — `IngestBody.sensitivity` becomes optional on PUT only

The worker omits `sensitivity` from the PUT body. The Node PUT route
parses with a derived schema (`IngestBodyForPut`) that makes
`sensitivity` optional. When the field is absent, the route reads the
current `entries.sensitivity` value via a separate SELECT and merges it
into the `IngestInput` passed to `updateEntry`.

**Why:** closes the dispatch-to-PUT sensitivity-downgrade race. The
worker may dwell on a job for seconds; an admin can re-tag the entry
from `public` to `restricted` during that window. If the worker
included `sensitivity` in its PUT body, the stale value would silently
overwrite the admin's re-tag. With sensitivity omitted, the route's
SELECT happens at PUT time — much narrower race window (microseconds
vs seconds), bounded by the route's own SELECT-then-updateEntry
sequence. The remaining race (between the route's SELECT and
`updateEntry`'s `FOR UPDATE`) is acceptable and consistent with the
existing M2b posture.

POST `/api/ingest` continues to require `sensitivity` — creates have no
prior value to preserve.

### D5 — Worker-to-Node auth: dev stub header, M5 hardening deferred

The worker authenticates with `x-stub-user-role: admin` (the same
header [lib/auth.ts](../../lib/auth.ts) `withAdmin` validates for any
admin route). In dev / M2b the worker and Node run in trusted local
environments; the stub is sufficient.

Production hardening (M5) requires one of:

- Microsoft Entra ID app-to-app (service principal with `admin` scope).
- Shared-secret HMAC header validated by a new `withWorker` HOF.
- mTLS between worker and Node.

Filed to BACKLOG: "M5 worker→Node auth hardening (Entra app-to-app /
shared-secret HMAC / mTLS — pick when M5 hosting ADR fires)."

### D6 — Placeholder entry version-history shape: v1=sentinel permanent

Upload writes `entries_versions` v1 with body
`[pending media OCR — awaiting worker]` via `createEntry`. The
worker's PUT then appends v2 with the parsed text. The v1 sentinel row
stays in the version history forever.

This is accepted M2b limitation. The M4 #3 version-history viewer (per
[ROADMAP M4 #3](../ROADMAP.md)) MUST detect v1=sentinel-body rows for
media-ingest entries and display them as "pending OCR placeholder"
rather than rendering the literal sentinel text. Filed to BACKLOG:
"M4 #3 viewer suppresses v1=sentinel display for media-ingest entries."

The alternative — having the worker UPDATE v1 in place instead of
appending v2 — was rejected because (a) `entries_versions` is
append-only per [ADR-0009 §7](0009-chunking-strategy.md) and breaking
that invariant for one path adds more surface than it removes, (b) an
admin who later edits the entry manually expects v2 to be their first
edit, not v3 (off-by-one in admin mental model).

### D7 — Content-type dispatch lives inside the handler, NOT the worker registry

The worker's handler registry is keyed by **`queue_name`** (mirroring
`api/worker.py main()`'s existing single-queue poll), not by
`payload.content_type`. The `ingest` queue dispatches to one handler —
`api.handlers.media_ingest.handle` — which inspects `payload.content_type`
internally and routes to `parse_pdf` / `parse_docx` / `mark_failed`
based on the content type.

**Why:** the worker's natural unit is the queue (it polls one queue at
a time); the content-type dispatch is a handler-internal detail. A
content-type-keyed registry at the worker layer would conflate the two
axes and complicate adding new queues (e.g., a future `reindex` queue
that takes a different payload shape).

The unknown-content-type path inside the handler calls
`mark_failed(error_class=WorkerErrorClass.UnsupportedContentType)`.
The worker's `_default_handler` stays as the unknown-queue fallback
(unchanged from [ADR-0019](0019-job-queue.md)).

### D8 — Worker error taxonomy: `WorkerErrorClass` enum

[ADR-0020 §D8](0020-python-log-event-emitter.md) deferred the stable
`error_class` taxonomy to "the first OCR handler whose failures are
taxonomically meaningful." This ADR is that PR; the enum lands here.

```python
class WorkerErrorClass(StrEnum):
    ParseFailed = "parse_failed"           # ParserError("corrupt"/"encrypted")
    ParseEmpty = "parse_empty_result"      # parser returned ""
    UnsupportedContentType = "unsupported_content_type"
    BlobReadFailed = "blob_read_failed"    # FS / IO error on blob load
    IngestApiNotFound = "ingest_api_not_found"  # PUT → 404
    IngestApi4xx = "ingest_api_4xx"        # PUT → other 4xx
    IngestApi5xx = "ingest_api_5xx"        # PUT → 5xx
    IngestApiTimeout = "ingest_api_timeout"
    EntryMetadataNotFound = "entry_metadata_not_found"
    HandlerCrashed = "handler_crashed"     # top-level except catch-all
```

`api.jobs.mark_failed` gains an optional `error_class: WorkerErrorClass | None = None` kwarg; the value threads into both
`audit_log.payload.error_class` and `LogEventJob.error_class` so
dashboards can group by stable taxonomy without parsing the free-text
`last_error`. Future taxonomy additions require an ADR amendment to
keep the enum closed.

### D9 — No `mark_failed(force_dead=True)` knob; 404 retries to max_attempts

The reviewer's M5 finding noted that `api.jobs.mark_failed` always
bumps `attempts` and re-queues until `max_attempts`; there is no
"mark dead immediately" path. Under Option Y, a PUT-side 404 means the
entry was deleted between enqueue and dispatch — almost certainly
unrecoverable, and the worker should not waste retry budget on it.

This ADR explicitly accepts the limitation for M2b: 404s retry up to
`max_attempts` (default 5 per `drizzle/migrations/0004_jobs.sql`) then
land in `dead`. The `error_class=IngestApiNotFound` value is stable so
dashboards can filter dead-due-to-404 separately.

Filed to BACKLOG: "`api.jobs.mark_failed(force_dead=True)` extension
for handler-known-unrecoverable failures."

### D10 — `httpx.AsyncClient` singleton per worker lifetime

The HTTP client is constructed once in `api/worker.py main()`, injected
into the handler closure, and `aclose()`d on graceful shutdown. Per-call
instantiation would tear down the connection pool per request and skip
HTTP keepalive across PUTs — fine at low volume, real cost at M5 when
the worker has dozens of PDFs queued.

### D11 — Blob path is relative to `BLOB_STORAGE_DIR`

[lib/blob-storage.ts:188-191](../../lib/blob-storage.ts) returns paths
RELATIVE to `BLOB_STORAGE_DIR` (default `./blob-storage/dev`) so the
queue payload + audit_log don't carry machine-specific absolute paths.
The worker reconstructs the absolute path by joining
`os.environ["BLOB_STORAGE_DIR"]` with `payload["blob_storage_path"]`.

The worker fails loudly at startup if `BLOB_STORAGE_DIR` is unset (no
silent default — the Node default lives only in TypeScript; the
Python worker must inherit the operator's choice explicitly so a
mismatched FS root surfaces immediately).

## 10-line type skeleton (per ADR-with-new-types sub-rule)

```python
# api/handlers/types.py
from enum import StrEnum

class WorkerErrorClass(StrEnum):
    ParseFailed = "parse_failed"
    ParseEmpty = "parse_empty_result"
    UnsupportedContentType = "unsupported_content_type"
    BlobReadFailed = "blob_read_failed"
    IngestApiNotFound = "ingest_api_not_found"
    IngestApi4xx = "ingest_api_4xx"
    IngestApi5xx = "ingest_api_5xx"
    IngestApiTimeout = "ingest_api_timeout"
    EntryMetadataNotFound = "entry_metadata_not_found"
    HandlerCrashed = "handler_crashed"
```

```typescript
// lib/ingest.ts updateEntry signature delta
export async function updateEntry(args: {
  // … existing fields …
  audit_extra?: { worker_id?: string; job_id?: string };
}): Promise<IngestResult>;
```

```typescript
// lib/ingest-schema.ts derived PUT schema
export const IngestBodyForPut = IngestBody.extend({
  sensitivity: z.enum(sensitivityEnum).optional(),
});
```

## Verification

Gate: `make py-check` + `npm run check`. Both must be green for the
PR pair.

Integration test:
[api/tests/test_handlers_media_ingest.py](../../api/tests/test_handlers_media_ingest.py)
runs against a real PostgreSQL + real LocalFSBlobStore + stub-`httpx`
sink. Stub-HTTP is acknowledged as a verification-layer gap (per
SESSION_PROTOCOL.md Verification-layer-matching sub-rule) — the
cross-language boundary the architecture invented is not exercised by
gate-time tests. Filed to BACKLOG: "Playwright-orchestrated
real-Node-server integration for M2b worker ingest path." Manual smoke
required in the PR description.

Manual smoke (PR-pair-2 acceptance):

1. `docker compose up` — Postgres + pgvector.
2. `npm run db:migrate` — schema in place.
3. `npm run dev` — Next.js on `:3000`.
4. `BLOB_STORAGE_DIR=./blob-storage/dev INGEST_API_BASE_URL=http://localhost:3000 python -m api.worker` — worker against same blob root.
5. Upload a real PDF via `http://localhost:3000/admin/ingest` (upload form to land at M4) OR via `curl -X POST` with multipart.
6. Observe worker logs: `LogEventJob` `claimed` → handler runs → PUT → `LogEventJob` `done`.
7. Verify `entries.body` updated from placeholder to parsed text via `psql` or `/entries/<id>`.

## Consequences

- The first cross-language runtime contract in PriorityKB lands. Future
  M2b #6/#7 OCR handlers inherit the same Option Y shape unless an ADR
  amendment flips them to Option X.
- `audit_log.kind = "worker_chunk_write"` reserved by ADR-0019 §D8 #2
  is retired. ADR-0019 gains a cross-reference Amendment to this ADR's
  §D2.
- `IngestBody.sensitivity` becomes optional on PUT but stays required
  on POST — a small schema asymmetry documented in
  `lib/ingest-schema.ts`.
- Worker-induced PUTs are distinguishable from human-admin PUTs via
  `audit_log.payload.worker_id` presence — small but real audit-trail
  hygiene improvement.
- v1=sentinel rows in `entries_versions` are a known M2b limitation
  the M4 #3 viewer must handle. Filed.

## References

- [ADR-0019](0019-job-queue.md) — worker contract; §D8 #2 amended by this ADR's §D2.
- [ADR-0020](0020-python-log-event-emitter.md) — LogEvent shape; §D8 taxonomy trigger satisfied by this ADR's §D8.
- [ADR-0009](0009-chunking-strategy.md) — chunking strategy that stays Node-side under Option Y.
- [lib/blob-storage.ts:188-191](../../lib/blob-storage.ts) — relative-path contract.
- [lib/ingest.ts](../../lib/ingest.ts) `updateEntry` — the Node side of the HTTP callback.
- [app/api/ingest/upload/route.ts](../../app/api/ingest/upload/route.ts) — placeholder-entry shape (M2b #4).
