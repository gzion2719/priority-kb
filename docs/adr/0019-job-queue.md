# ADR-0019 — Job queue: custom SKIP LOCKED + polling, single `jobs` table, Drizzle-owned schema (M2b #3)

**Status:** Accepted
**Date:** 2026-05-26
**Supersedes:** N/A
**Related:** [ADR-0005](0005-log-event-schema.md) (LogEvent union — extended here), [ADR-0008](0008-orm-and-migration-ownership.md) (Drizzle-owned migrations — unchanged), [ADR-0009](0009-chunking-strategy.md) (chunk DELETE+INSERT semantics — motivates the idempotency-key decision), [ADR-0016](0016-python-rules-adoption.md) §8 (Python iron-rule mirrors for #9/#10 — fire on M2b #4 worker code), [ADR-0018](0018-python-logging-primitive.md) (Python application logger — distinct from the LogEvent emitter named here).

## Context

[ROADMAP.md](../ROADMAP.md) M2b checklist item #3: *"pgqueuer (or equivalent) job queue table; Next.js enqueues, worker consumes."* The next milestone needs a cross-language job-dispatch surface for media-ingestion work (OCR via Azure DI, PDF parse via pypdf, Word parse via python-docx, image processing). Admins upload through the Next.js Ingestion Agent UI; the Python FastAPI worker (scaffolded in M2b #2) consumes the work.

The named-in-ROADMAP candidate is [pgqueuer](https://github.com/janbjorge/pgqueuer); active 2026 candidates include [Procrastinate](https://github.com/procrastinate-org/procrastinate) (v3.8.1, April 2026). A third option is a custom SKIP LOCKED + polling consumer.

This ADR records the design decision for M2b #3 before the implementation PR lands. Per the Step-7 ADR/design-document timing sub-rule, supporting reads (ADR-0008, ADR-0009, ADR-0016, ADR-0018, [db/init.sql](../../db/init.sql), [drizzle/migrations/0000_baseline.sql](../../drizzle/migrations/0000_baseline.sql), [lib/log.ts](../../lib/log.ts), [docs/AGENTS.md](../AGENTS.md)) were completed before this ADR was drafted.

Three forces pull on the library-vs-custom choice:

1. **Migration ownership.** [ADR-0008](0008-orm-and-migration-ownership.md) pins Drizzle-Kit as the sole schema migration owner; the canonical migration tool is invoked from the Node side. Both `pgqueuer` and Procrastinate own their schema via their own installer CLIs (`pgq install`, `procrastinate schema --apply`) — adopting either forces an ADR-0008 amendment carving out a second migration namespace.
2. **Cross-language enqueue.** The contract is "Next.js (TypeScript) writes; Python (FastAPI) reads." Both libraries assume Python-on-both-sides; their cross-language enqueue surface is undocumented. With a custom design, the contract *is* the SQL schema — versioned by Drizzle, readable from either runtime.
3. **House style.** [lib/log.ts](../../lib/log.ts) and [api/log.py](../../api/log.py) are hand-rolled small primitives (see ADR-0018 §"Why not structlog" for the same reasoning). A ~30-LOC SKIP LOCKED consumer fits this pattern; the operational scars worth importing from a library (visibility timeout, retry backoff, DLQ promotion) are bounded and well-understood.

## Decision

ADR-with-new-types: applies (SQL `jobs` table + `job_state` enum). Skeleton inline below. No test-helper signatures introduced.

### D1 — Library choice: custom SKIP LOCKED + polling

**Decision: custom.** Reject pgqueuer and Procrastinate. The forces above weigh: ADR-0008 stays untouched; cross-language enqueue becomes a deliberate contract rather than an off-label use; the implementation surface fits the house style. The trade-off accepted is that PriorityKB owns the operational primitives (visibility timeout, retry, DLQ promotion) — but these are ~50 LOC of well-understood SQL + Python.

If a concrete need emerges later (high-throughput priority lanes, hundreds of workers, NOTIFY-driven sub-millisecond latency), a future ADR can flip to a library against a small, well-isolated module — same migration pattern as ADR-0018's `structlog` carve-out.

### D2 — Queue table location

Single `jobs` table in the canonical `public` schema, mirroring `entries`/`chunks`/`audit_log`. Not a `jobs.*` schema. ADR-0008 conventions stand.

### D3 — Delivery semantics: at-least-once + enqueue-time idempotency key

**Decision: at-least-once delivery + an `idempotency_key text UNIQUE` column on `jobs`** checked at enqueue time. Replaces the earlier "naturally idempotent because chunks upsert by content hash" framing, which was **factually wrong** — [ADR-0009 §7](0009-chunking-strategy.md) prescribes DELETE+INSERT per entry, not content-hash upsert, and `chunks` has no `content_hash` column ([drizzle/migrations/0000_baseline.sql](../../drizzle/migrations/0000_baseline.sql) lines 17-32 confirms).

Real failure mode this column closes: an admin uploads a PDF; the worker claims the job, runs OCR, crashes before `mark_done`; the visibility timeout expires; a second worker claims the *same* job from the queue table. Without an enqueue-time idempotency key, the second worker re-runs OCR and writes a *duplicate* entry (since the existing `/api/ingest` path always inserts a new row).

Contract: `enqueueJob({queue, payload, idempotency_key})` does an `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`. Repeat enqueues with the same key are no-ops; the worker dedupe happens at enqueue, not in the handler. For M2b #3 callers, the idempotency key is derived from a stable input descriptor (e.g., `sha256(blob_storage_path)` for file-upload jobs). Callers that genuinely want multi-fire semantics pass a fresh UUID.

This does NOT make jobs exactly-once — at-least-once + idempotent insert at the **job** level, plus handler-side responsibility for ensuring the downstream side-effect (entry creation) is one-to-one with the job. The implementation PR documents the handler-side pattern.

### D4 — DLQ shape

Same table; `state='dead'` is the terminal state after `attempts >= max_attempts`. No separate `jobs_dlq` table — keeps the audit story single-source and avoids migration churn on schema additions.

### D5 — Payload encoding + size policy

`payload jsonb`. **Payload is a control-plane envelope** (`entry_id`, `blob_storage_path`, `content_type`, optional metadata) and MUST NOT contain the binary itself. Binary content lives in M2b #4's blob-storage abstraction; the queue carries the pointer. This is documented inline in the implementation PR's `enqueueJob` JSDoc to pre-empt the next-PR-reviewer's question.

### D6 — Visibility timeout + worker identity + shutdown semantics

- **Lock columns:** `locked_until timestamptz` + `locked_by text`.
- **No heartbeat.** M2b ingest jobs are bounded (OCR + chunk + embed runs in tens of seconds, not hours). If a worker dies mid-job, the lock expires at `locked_until` and another worker claims; no in-flight extension protocol.
- **`locked_by` format:** `worker-<hostname>-<pid>-<random4>` (operator-readable; a stuck row's owning process is identifiable from the column alone).
- **SIGTERM mid-job semantics.** A clean shutdown signal during an in-flight job marks the job `failed` (bumping `attempts`); the job is then retry-eligible at the next claim cycle (subject to `max_attempts`). This treats SIGTERM as a crash, not as a graceful release-lock — preferred because (a) it preserves attempt-counting visibility into platform-induced churn, and (b) the worker may already be partway through a side-effect that the retry handler must reconcile against anyway. The implementation PR registers the signal handler.

### D7 — Observability: `LogEvent` + `audit_log.kind` discriminators

Per [ADR-0005](0005-log-event-schema.md) the LogEvent union is closed at [lib/log.ts:268](../../lib/log.ts). The queue introduces a new long-lived control surface; this ADR extends the union with a new variant **`LogEventJob`** (kind: `"job"`), sibling to `LogEventRoute` and `LogEventRetrievalPipeline` — does NOT extend `LogEventBase` (no vendor invocation per the carve-out documented in ADR-0005 Amendment 2026-05-27). Fields: `queue_name`, `job_id`, `transition` (`"enqueued" | "claimed" | "done" | "failed" | "dead"`), optional `attempts`, optional `error_class`. Emitter fires from both Node (enqueue path, via [lib/log.ts](../../lib/log.ts)) and Python (worker path, via the Python LogEvent emitter that lands in M2b #4 per ADR-0018 §"LogEvent emitter").

**`audit_log.kind` discriminators:**
- `job_enqueued` — admin-initiated enqueue via the Ingestion Agent UI or `/api/ingest` upload path.
- `job_dispatched` — worker claimed and started the job (one per claim, not per attempt — the `claimed` LogEvent transition + this audit row cover the same moment).
- `job_done` — worker terminal success.
- `job_dead` — worker terminal failure after `max_attempts`.

**None of these match `kind LIKE 'agent_%'`**, so the existing DB CHECK `audit_log_prompt_hash_required_for_agent` does not fire on worker writes — by design (see D8 below).

### D8 — Iron-rule mapping (the explicit version)

- **#1 (credentials never committed)** — ADR-only PR, N/A.
- **#2 (writes via Ingestion Agent)** — Worker-side chunk writes are NOT agent writes. The iron rule is interpreted as *"admin-initiated writes are gated through the agent path"*; the worker is a downstream executor of an admin-authorized enqueue. The enqueue itself flows through the existing `/api/ingest` admin-only path (`withAdmin` HOF, [lib/auth.ts](../../lib/auth.ts)); the worker has no public surface. `audit_log.kind = worker_chunk_write` covers the worker's terminal entry-creation row when the implementation PR lands; the discriminator does not match `agent_%` and the prompt-hash CHECK does not fire — correctly, because no prompt is being invoked.
- **#6 (sensitivity tagging)** — Jobs carry `entry_id` only; **no `sensitivity` snapshot in `payload`**. The worker re-reads `entries.sensitivity` at chunk-write time, and the existing `chunks` composite-FK from ADR-0009 ON UPDATE CASCADE handles any sensitivity edit between enqueue and dispatch. This closes the enqueue→dispatch race where an admin re-tags an entry from `public` to `restricted` during the queue dwell time.
- **#9 (embedding_model + embedding_version on chunks)** — Deferred to the M2b #4 worker implementation PR per [ADR-0016 §8 #2](0016-python-rules-adoption.md) (`py-iron-rule-9-embedding-version-pinned`); fires when the worker's chunk-write path is first authored.
- **#10 (prompts hashed)** — Deferred to M2b #4 per [ADR-0016 §8 #3](0016-python-rules-adoption.md) (`py-iron-rule-10-prompt-hash-sealed`); the worker does NOT invoke an agent in M2b #3, so the surface is absent.
- **#12 (degraded mode)** — Queue is independent of Claude/Voyage. If those vendors are out, enqueue still works and jobs queue up; dispatch backs off via existing handler-side retry. The queue itself does not need a degraded-mode fallback.

### D9 — Priority and fairness across queue names

**Decision: single FIFO per `queue_name`; no priority lanes in M2b.** The dispatch index orders by `(queue_name, state, run_after)`; jobs within a queue process in FIFO. Different `queue_name` values compete for worker attention via the worker's poll loop (round-robin across configured queues, defined in the worker's startup config). No `priority smallint` column in M2b. If a real fairness problem emerges (e.g., long-running PDF parse jobs starve OCR), a follow-up ADR adds either priority lanes or per-queue worker pools.

### D10 — Schema-migration sequencing

The `jobs` table + `job_state` enum + `jobs_dispatch_idx` ship as a **new Drizzle migration in the M2b #3 implementation PR**, not in a separate baseline-style migration PR ahead of it. Mirrors the [ADR-0009 chunking pattern](0009-chunking-strategy.md) where the schema landed with the consumer code that uses it. Net new files on the implementation PR: `drizzle/migrations/000N_jobs.sql` + `drizzle/schema.ts` additions + the consumer module(s).

### D11 — UUID vs BIGINT for `jobs.id`

**Decision: UUID** (`gen_random_uuid()`), matching `entries`/`chunks`/`audit_log`. Acknowledged trade-off: BIGINT would be cheaper for index size and offers a "last id = throughput proxy" monitoring affordance for high-volume workloads. M2b throughput (admin uploads on the order of tens-per-day initially) does not pressure this; consistency wins. A future ADR can flip the choice if throughput justifies it; the cost is one migration to drop+recreate the column or rename to `id_uuid` + add `id_seq bigint`.

### D12 — Row retention and GC

**Decision:** `done` rows are pruned by a **separate cleanup cron** with a **7-day retention window** (operator gets a week to inspect successful jobs; `dead` rows retained indefinitely as the dead-letter audit surface). The cron implementation defers to the M2b #3 implementation PR; this ADR pins the retention number and the policy.

### Queue table 10-line skeleton (per ADR-with-new-types sub-rule)

```sql
CREATE TYPE job_state AS ENUM ('queued', 'in_progress', 'done', 'failed', 'dead');

CREATE TABLE jobs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  queue_name       text        NOT NULL,
  payload          jsonb       NOT NULL,
  idempotency_key  text        NOT NULL UNIQUE,
  state            job_state   NOT NULL DEFAULT 'queued',
  attempts         int         NOT NULL DEFAULT 0,
  max_attempts     int         NOT NULL DEFAULT 5,
  run_after        timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,
  locked_by        text,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jobs_dispatch_idx ON jobs (queue_name, state, run_after)
  WHERE state IN ('queued', 'in_progress');
```

Notes:
- `gen_random_uuid()` is core in Postgres 13+ (no `pgcrypto` extension install needed); confirmed by [drizzle/migrations/0000_baseline.sql](../../drizzle/migrations/0000_baseline.sql) precedent which uses it without an extension install in [db/init.sql](../../db/init.sql).
- `updated_at` is **caller-maintained** (no auto-update trigger). Every UPDATE statement on `jobs` MUST set `updated_at = now()`. Matches the existing entries-table convention; no schema-level trigger introduced.
- Dispatch hot path is covered by the partial index; the dead-letter inspection path (`WHERE state = 'dead'`) intentionally tolerates a seq scan in the M2b volume regime. Add a secondary index only if operator complaints surface.

### Enqueue/consume contract skeleton (per Test-helper-signature sub-rule)

```ts
// Node — lib/jobs.ts
export interface EnqueueArgs { queue: string; payload: object; idempotencyKey: string; }
export async function enqueueJob(args: EnqueueArgs): Promise<{ id: string; created: boolean }>;
// returns created:false when the idempotency key conflicts (no-op).
```

```python
# Python — api/jobs.py
async def claim_one(conn, queue: str, worker_id: str, vis_timeout_s: int) -> Job | None
async def mark_done(conn, job_id: UUID) -> None
async def mark_failed(conn, job_id: UUID, error: str) -> None
# mark_failed bumps attempts; promotes state to 'dead' when attempts >= max_attempts.
```

The implementation PR also wires the M2b #4 LogEvent emitter to fire `LogEventJob` on every state transition (enqueue, claim, mark_done, mark_failed-bumps-attempts, mark_failed-promotes-to-dead).

### Target end-to-end latency

For M2b: **admin sees OCR'd text within 30s of upload at p95** (file upload + queue dwell + OCR + chunk + embed + UI refresh). 1-second polling on the worker side absorbs ≤1s of the budget; the remainder is OCR runtime. If this budget breaks, the LISTEN/NOTIFY upgrade path is open (D1).

## Consequences

**Positive:**
- ADR-0008 stays untouched; no second migration system to reason about.
- Cross-language enqueue is a versioned SQL contract, not an off-label library use.
- Custom code path mirrors the hand-rolled small-primitive house style (lib/log.ts, api/log.py).
- All decision points the next-PR plan-CR will surface are addressed inline: idempotency-key, observability shape, sensitivity race, worker shutdown, priority/fairness, retention, UUID-vs-BIGINT, payload-size policy.
- Iron-rule #6 enqueue→dispatch sensitivity-race closed by re-read-at-handler discipline + the existing chunks composite-FK ON UPDATE CASCADE.

**Negative:**
- PriorityKB owns the visibility-timeout / retry-backoff / DLQ-promotion primitives. A library would import them for free. Mitigated by the small surface (~50 LOC of SQL + Python) and well-understood patterns.
- The LISTEN/NOTIFY latency win pgqueuer provides is forgone. Mitigated by the 30s p95 budget and the documented flip-to-library upgrade path.
- A new SIGTERM handler must land in the Python worker for the D6 shutdown contract. M2b #3 implementation PR scope expands by ~10 LOC + 1 test.
- The new `LogEventJob` variant extends a closed union; every existing exhaustive-switch consumer of `LogEvent` (currently zero — the union is consumed only at emission time in [lib/log.ts](../../lib/log.ts)) would need updating. Mitigated by the union still being emit-only.
- Cross-language `LogEvent` shape mirroring between TS and Python adds a synchronization surface. ADR-0018 already named the Python LogEvent emitter as M2b #4 work; this ADR confirms it carries a `LogEventJob`-shaped record.

**Mitigations:**
- The implementation PR (M2b #3) is the first PR that consumes this ADR. Plan-CR on that PR will catch any drift between this ADR's prose and the realized code; this ADR's job is to pre-load the decision space.
- M2b #4 (image processing) will be the first PR to land the Python LogEvent emitter; the `LogEventJob` shape pinned here becomes its first variant, alongside whatever vendor-call variants the embed/Claude paths require.
- [docs/AGENTS.md](../AGENTS.md) Ingestion Agent interface gains a media-ingest surface in M2b #3. **This ADR does not edit AGENTS.md** — that edit belongs in the M2b #3 implementation PR alongside the enqueue path. Flagged here so the next reader knows the AGENTS.md update is downstream-PR work, not a missing edit on this PR.

**ADR-0008 compatibility:** The `jobs` table is Drizzle-owned, mirroring `entries`/`chunks`/`audit_log`. No ADR-0008 amendment required. The `job_state` enum lives in the same Drizzle migration as the table per the ADR-0008 §1 schema-pattern convention.

## References

- [ROADMAP.md](../ROADMAP.md) M2b checklist item #3 — the trigger.
- [ADR-0005](0005-log-event-schema.md) — LogEvent union; extended by D7's `LogEventJob` variant.
- [ADR-0008](0008-orm-and-migration-ownership.md) — Drizzle-owned schema migrations; unchanged by this ADR.
- [ADR-0009](0009-chunking-strategy.md) §7 — DELETE+INSERT chunking semantics; motivates the D3 idempotency-key column.
- [ADR-0016](0016-python-rules-adoption.md) §8 #2/#3 — Python iron-rule #9/#10 mirrors; fire on M2b #4 worker code.
- [ADR-0018](0018-python-logging-primitive.md) — Python application logger (distinct from the LogEvent emitter named in D7).
- [db/init.sql](../../db/init.sql) + [drizzle/migrations/0000_baseline.sql](../../drizzle/migrations/0000_baseline.sql) — extension surface + `gen_random_uuid()` precedent.
- [lib/log.ts](../../lib/log.ts) — LogEvent union home; closed at line 268 today.
- [lib/auth.ts](../../lib/auth.ts) — `withAdmin` HOF gating the enqueue path per D8 iron-rule #2 interpretation.
- [docs/AGENTS.md](../AGENTS.md) — Ingestion Agent interface; update is downstream-PR work, not on this PR.
- [pgqueuer](https://github.com/janbjorge/pgqueuer) + [Procrastinate](https://github.com/procrastinate-org/procrastinate) — rejected library candidates per D1.
