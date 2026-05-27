"""ADR-0019 M2b #3 — job-queue worker consumer surface.

This is the Python half of the queue contract; the producer surface is
``lib/jobs.ts`` ``enqueueJob`` (Node). The wire format between the two
is the SQL schema (``drizzle/migrations/0004_jobs.sql``) — versioned by
Drizzle per ADR-0008.

Iron-rule footprint (ADR-0019 §D8):
    #2  No public surface — the worker reads admin-authorized enqueued
        rows. Routes that enqueue are ``withAdmin``-gated.
    #6  Reads ``entries.sensitivity`` at chunk-write time (M2b #4) — does
        NOT trust any sensitivity snapshot in ``jobs.payload``. The Node
        enqueue side rejects payload-borne sensitivity at any depth;
        this side enforces the rule by simply never reading the field.
    #9/#10  Deferred to M2b #4 (no agent / no embedding write here).
    #12 Queue is independent of Claude/Voyage; worker keeps consuming
        even when those vendors are out (handler-side retries via
        mark_failed).

LogEvent emission: emits ``LogEventJob`` (kind=``"job"``) on every
state transition that writes an ``audit_log`` row — ``claimed`` after
``claim_one``'s commit, ``done`` after ``mark_done``'s success-branch
commit, ``failed`` after ``mark_failed``'s queued-retry-branch commit,
``dead`` after ``mark_failed``'s dead-branch commit. Lost-ownership and
empty-queue branches write no audit row and emit no LogEvent —
``audit_log row written ⇔ LogEventJob line emitted`` per
[ADR-0020](../docs/adr/0020-python-log-event-emitter.md) §D4 wire-point
matrix. ``error_class`` is ``None`` at M2b #3 transition sites per
ADR-0020 §D8; the stable taxonomy lands at M2b #5+ when the first OCR
handler ships.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from api.log_event import LogEventJob, log_event

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Job:
    """Mirror of the ``jobs`` row shape (drizzle/schema.ts ``jobs`` table).

    Frozen so a claimed job's snapshot can't be mutated by handler code.
    Field set MUST stay in lockstep with the Drizzle schema; the
    information-schema mirror test (api/tests/test_jobs.py) catches drift.
    """

    id: UUID
    queue_name: str
    payload: dict[str, Any]
    idempotency_key: str
    state: str
    attempts: int
    max_attempts: int
    run_after: datetime
    locked_until: datetime | None
    locked_by: str | None
    last_error: str | None
    created_at: datetime
    updated_at: datetime


# claim_one SQL pinned by ADR-0019 Amendment 2026-05-26 §F.
# Single statement so no explicit transaction needed beyond the
# explicit conn.commit() at the end of claim_one.
# Predicate set:
#   - run_after <= now()                        (back-off-scheduled retries)
#   - EITHER (state='queued')                   (fresh / non-terminal retry)
#     OR     (state='in_progress' AND locked_until < now())
#                                               (expired-lock reclaim per §D6 —
#                                                worker died mid-job; another
#                                                worker takes over. Without
#                                                this clause the row would
#                                                stay stuck in_progress with
#                                                no way back to claimable
#                                                without an external sweep.)
# Order:  run_after ASC                         (FIFO within a queue)
# Lock:   FOR UPDATE SKIP LOCKED LIMIT 1        (multi-worker contention)
#
# Code-CR M2 (2026-05-26): the predicate previously only matched
# state='queued' — the reclaim arm was unreachable because §D6's "another
# worker claims" semantics require accepting state='in_progress' when the
# lock has expired. Fixed in-place; ADR-0019 §F unchanged (the SQL
# matches the intent §D6 always described).
_CLAIM_SQL = """
UPDATE jobs
SET    state        = 'in_progress',
       locked_until = now() + (%(vis_s)s || ' seconds')::interval,
       locked_by    = %(worker_id)s,
       updated_at   = now()
WHERE  id = (
  SELECT id FROM jobs
  WHERE  queue_name = %(queue)s
    AND  run_after <= now()
    AND  (
           state = 'queued'
        OR (state = 'in_progress' AND locked_until < now())
    )
  ORDER BY run_after
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING id, queue_name, payload, idempotency_key, state, attempts,
          max_attempts, run_after, locked_until, locked_by, last_error,
          created_at, updated_at
"""


async def claim_one(
    conn: psycopg.AsyncConnection[Any],
    *,
    queue: str,
    worker_id: str,
    vis_timeout_s: int,
) -> Job | None:
    """Claim the next available job from ``queue`` for this worker.

    Returns ``None`` when the queue is empty (no row matches the predicate
    set above). Writes one ``audit_log`` row (``kind='job_dispatched'``)
    on success; no audit row on empty-queue.

    The worker_id should be the operator-readable
    ``worker-<hostname>-<pid>-<random4>`` shape per ADR-0019 §D6 so a
    stuck row's owning process is identifiable from the column alone.

    Behavior under concurrent workers: PostgreSQL's
    ``FOR UPDATE SKIP LOCKED`` skips rows held by other transactions, so
    N workers calling ``claim_one`` simultaneously each get a distinct
    job (or ``None``) — no claim is ever issued twice.
    """
    started_ms = time.perf_counter() * 1000.0
    async with conn.cursor() as cur:
        await cur.execute(
            _CLAIM_SQL,
            {"queue": queue, "worker_id": worker_id, "vis_s": vis_timeout_s},
        )
        row = await cur.fetchone()
        if row is None:
            # Empty-queue branch — no audit row, no LogEvent emit per
            # ADR-0020 §D4 wire-point matrix.
            return None
        job = _row_to_job(row)
        # Audit row written in the same tx as the UPDATE. If this INSERT
        # raises (e.g., a future audit_log CHECK constraint that rejects
        # an unknown kind), psycopg's AsyncConnection __aexit__ rolls back
        # on exception — the claim itself rolls back and the row remains
        # queued (or reclaimable in_progress) for the next poll. The
        # caller never sees a half-claimed job. Code-CR M5 (2026-05-26).
        await cur.execute(
            "INSERT INTO audit_log (kind, payload) VALUES (%s, %s)",
            (
                "job_dispatched",
                Jsonb(
                    {
                        "queue_name": job.queue_name,
                        "job_id": str(job.id),
                        "worker_id": worker_id,
                        "attempts": job.attempts,
                    }
                ),
            ),
        )
        await conn.commit()
        # LogEvent emit AFTER commit per ADR-0020 §D4: the audit_log row
        # is the durable record; the NDJSON line is an observability tee.
        # Sink errors are swallowed by log_event itself — observability
        # MUST NEVER break the API path.
        log_event(
            LogEventJob(
                kind="job",
                queue_name=job.queue_name,
                job_id=str(job.id),
                transition="claimed",
                latency_ms=time.perf_counter() * 1000.0 - started_ms,
                cost_usd=None,
                attempts=job.attempts,
                error_class=None,
                status="ok",
            )
        )
        return job


async def mark_done(
    conn: psycopg.AsyncConnection[Any],
    *,
    job_id: UUID,
    worker_id: str,
) -> None:
    """Terminal-success transition.

    Sets state='done', clears the lock (cosmetic on done — the row will
    never be claimed again, but the cleared lock keeps the SQL shape
    uniform with mark_failed which DOES need the clear). updated_at
    advanced per ADR-0019 §I.

    Ownership guard (code-CR B2, 2026-05-26): the UPDATE includes
    ``AND locked_by = %s`` so a worker that lost its lock to a faster
    reclaim cannot mark the row done — only the current owner can.
    If the row was reclaimed by another worker between this worker's
    handler completion and this call, the UPDATE matches zero rows and
    this function returns without raising (logged as a no-op).
    """
    started_ms = time.perf_counter() * 1000.0
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE jobs
            SET    state='done',
                   locked_until=NULL,
                   locked_by=NULL,
                   updated_at=now()
            WHERE  id=%s AND locked_by=%s
            RETURNING queue_name
            """,
            (job_id, worker_id),
        )
        owned = await cur.fetchone()
        if owned is None:
            # Lost the lock to a reclaim. Don't write a job_done audit
            # row — that would claim credit for work the new owner
            # might also be running. Log + return. No LogEvent emit per
            # ADR-0020 §D4 (audit_log row written ⇔ LogEvent emitted).
            logger.warning(
                "mark_done: job %s no longer owned by worker %s (lock reclaimed?); no audit row",
                job_id,
                worker_id,
            )
            await conn.commit()
            return
        queue_name: str = owned[0]
        await cur.execute(
            "INSERT INTO audit_log (kind, payload) VALUES (%s, %s)",
            ("job_done", Jsonb({"job_id": str(job_id)})),
        )
        await conn.commit()
        # LogEvent emit AFTER commit per ADR-0020 §D4 — only the
        # success-branch path. queue_name read from the RETURNING clause
        # so the wire-format carries the same field set as claim_one's
        # emit without an extra round-trip.
        log_event(
            LogEventJob(
                kind="job",
                queue_name=queue_name,
                job_id=str(job_id),
                transition="done",
                latency_ms=time.perf_counter() * 1000.0 - started_ms,
                cost_usd=None,
                attempts=None,
                error_class=None,
                status="ok",
            )
        )


async def mark_failed(
    conn: psycopg.AsyncConnection[Any],
    *,
    job_id: UUID,
    worker_id: str,
    error: str,
) -> None:
    """Failure transition — bumps attempts; promotes to 'dead' when
    ``attempts >= max_attempts``.

    Two terminal shapes per ADR-0019 Amendment §A:
      - ``attempts < max_attempts`` → state goes back to 'queued'
        (retry-eligible at next claim cycle), audit_log row
        kind='job_failed'.
      - ``attempts >= max_attempts`` → state promoted to 'dead', audit_log
        row kind='job_dead'.

    locked_until + locked_by cleared on BOTH shapes — load-bearing on the
    retry-eligible path (next claim must see the lock released, not held
    until natural visibility-timeout expiry) and cosmetic on the dead
    path. Per ADR-0019 §F + §I.

    Ownership guard (code-CR B2, 2026-05-26): the bump-attempts UPDATE
    includes ``AND locked_by = %s`` so a worker that lost its lock to a
    faster reclaim cannot bump attempts on a row another worker now
    owns. The row-not-owned-by-me branch logs + returns without raising.

    Atomicity: both UPDATEs (attempts bump, then state set) plus the
    audit_log INSERT run in a single transaction committed at the end.
    External readers see the transition atomically at commit. Code-CR B4
    (2026-05-26).
    """
    started_ms = time.perf_counter() * 1000.0
    async with conn.cursor() as cur:
        await cur.execute(
            """
            UPDATE jobs
            SET    attempts = attempts + 1,
                   last_error = %(err)s,
                   locked_until = NULL,
                   locked_by = NULL,
                   updated_at = now()
            WHERE  id = %(id)s AND locked_by = %(worker_id)s
            RETURNING attempts, max_attempts, queue_name
            """,
            {"id": job_id, "worker_id": worker_id, "err": error},
        )
        row = await cur.fetchone()
        if row is None:
            # Either (a) the row vanished (cleanup cron raced), or (b)
            # the lock was reclaimed by another worker between claim and
            # this call. Either way, this worker is no longer authoritative
            # over the row. Roll back and log — don't raise, don't write an
            # audit row that would attribute work to a non-owner. No
            # LogEvent emit per ADR-0020 §D4 (audit_log row written ⇔
            # LogEvent emitted).
            await conn.rollback()
            logger.warning(
                "mark_failed: job %s no longer owned by worker %s (vanished or reclaimed); no-op",
                job_id,
                worker_id,
            )
            return
        attempts: int = row[0]
        max_attempts: int = row[1]
        queue_name: str = row[2]
        is_dead = attempts >= max_attempts
        if is_dead:
            await cur.execute(
                "UPDATE jobs SET state='dead', updated_at=now() WHERE id=%s",
                (job_id,),
            )
            await cur.execute(
                "INSERT INTO audit_log (kind, payload) VALUES (%s, %s)",
                (
                    "job_dead",
                    Jsonb({"job_id": str(job_id), "attempts": attempts, "last_error": error}),
                ),
            )
        else:
            # Non-terminal failure — state goes back to 'queued' for retry.
            await cur.execute(
                "UPDATE jobs SET state='queued', updated_at=now() WHERE id=%s",
                (job_id,),
            )
            await cur.execute(
                "INSERT INTO audit_log (kind, payload) VALUES (%s, %s)",
                (
                    "job_failed",
                    Jsonb({"job_id": str(job_id), "attempts": attempts, "last_error": error}),
                ),
            )
        await conn.commit()
        # LogEvent emit AFTER commit per ADR-0020 §D4 — branch on
        # is_dead to pick the right transition. error_class=None at all
        # M2b #3 transition sites per ADR-0020 §D8 (the stable taxonomy
        # lands at M2b #5+; the audit_log row's last_error field carries
        # the free text for human inspection).
        log_event(
            LogEventJob(
                kind="job",
                queue_name=queue_name,
                job_id=str(job_id),
                transition="dead" if is_dead else "failed",
                latency_ms=time.perf_counter() * 1000.0 - started_ms,
                cost_usd=None,
                attempts=attempts,
                error_class=None,
                status="error",
            )
        )


def _row_to_job(row: tuple[Any, ...]) -> Job:
    """Tuple-position-bound row -> Job. The column order is fixed by
    the RETURNING clause in _CLAIM_SQL; if that order changes, this
    function changes in the same commit.
    """
    return Job(
        id=row[0],
        queue_name=row[1],
        # payload column is `jsonb NOT NULL` — psycopg v3 returns dict.
        payload=row[2],
        idempotency_key=row[3],
        state=row[4],
        attempts=row[5],
        max_attempts=row[6],
        run_after=row[7],
        locked_until=row[8],
        locked_by=row[9],
        last_error=row[10],
        created_at=row[11],
        updated_at=row[12],
    )
