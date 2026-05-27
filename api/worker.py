"""ADR-0019 M2b #3 — job-queue worker entrypoint.

Poll loop + SIGTERM handler. Per ADR-0019 §D6, SIGTERM mid-job marks the
in-flight job 'failed' (NOT a graceful release-lock) — preserves
attempt-counting visibility into platform-induced churn and accepts that
the worker may already be partway through a side-effect the retry
handler must reconcile against anyway.

Iron-rule footprint:
    #2  No public surface — process-internal.
    #6  Honors entries.sensitivity at chunk-write time via api/jobs.py
        (which reads, never trusts payload-borne sensitivity).
    #9/#10  No agent invocation here; deferred to M2b #4.
    #12 Polls regardless of vendor health; vendor outages surface as
        handler-side failures that mark_failed catches.

Per py-script-logging-init (SESSION_PROTOCOL.md §Python pre-push §4):
``api.log.init_logging`` is the first line of ``main()``.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
import socket
import sys
from secrets import token_hex
from typing import Any
from uuid import UUID

import psycopg

from api.handlers import build_registry
from api.handlers.ingest_api_client import build_client
from api.handlers.media_ingest import make_handler as make_media_ingest_handler
from api.handlers.media_ingest import resolve_blob_root, resolve_ingest_api_base_url
from api.jobs import Job, claim_one, mark_failed
from api.log import init_logging

logger = logging.getLogger(__name__)


def make_worker_id() -> str:
    """Operator-readable worker identity per ADR-0019 §D6.

    Shape: ``worker-<hostname>-<pid>-<random4>``. A stuck row's owning
    process is identifiable from ``jobs.locked_by`` alone.
    """
    return f"worker-{socket.gethostname()}-{os.getpid()}-{token_hex(2)}"


class WorkerState:
    """In-flight tracking for SIGTERM coordination.

    SIGTERM handler reads ``current_job_id`` to mark the active row
    'failed' before exit. The handler does NOT do DB work itself —
    signal handlers must be fast and reentrancy-safe — it sets a flag
    that the poll loop's outer guard observes and acts on.
    """

    def __init__(self) -> None:
        self.current_job_id: UUID | None = None
        self.current_worker_id: str | None = None
        self.shutdown_requested: bool = False


async def _handle_shutdown(
    state: WorkerState,
    conn_factory: Any,
) -> None:
    """Run by the poll loop when ``shutdown_requested`` is observed.

    If a job is in-flight, marks it failed with a SIGTERM-specific
    error label; otherwise exits cleanly. Per ADR-0019 §D6.

    Ownership-guard interaction (code-CR B2): mark_failed validates
    ``locked_by`` matches the worker_id passed here. If the visibility
    timeout expired during the in-flight handler and another worker
    reclaimed the row, mark_failed no-ops (logged warning) and this
    function does not attribute work the new owner is doing.
    """
    if state.current_job_id is None or state.current_worker_id is None:
        logger.info("worker shutdown: no in-flight job")
        return
    try:
        async with await conn_factory() as conn:
            await mark_failed(
                conn,
                job_id=state.current_job_id,
                worker_id=state.current_worker_id,
                error="SIGTERM during in-flight job (worker shutting down)",
            )
            logger.info(
                "worker shutdown: marked in-flight job failed",
                extra={"job_id": str(state.current_job_id)},
            )
    except Exception:
        # Last-ditch — don't let cleanup failure block the shutdown.
        logger.exception("worker shutdown: failed to mark in-flight job")


def install_signal_handler(state: WorkerState) -> None:
    """Wire SIGTERM to flip the shutdown flag.

    The handler is intentionally minimal — flag-flip ONLY, no logging,
    no DB I/O. Python's ``logging`` module acquires module-level locks
    that the main thread may already hold when the signal fires; a
    logger.info call inside the handler can deadlock the worker.
    Code-CR B3 (2026-05-26): the previous implementation logged from
    the handler; removed. Observability of "signal received" surfaces
    via the poll loop logging ``shutdown_requested`` on its next
    iteration (cheap one-shot at top of the loop).

    The handler also doesn't call async code (signal handlers run on
    the main thread with unknown stack state).
    """

    def handler(signum: int, _frame: Any) -> None:
        # Single attribute assignment — atomic under the GIL.
        state.shutdown_requested = True

    signal.signal(signal.SIGTERM, handler)


async def poll_loop(
    state: WorkerState,
    *,
    queue: str,
    worker_id: str,
    vis_timeout_s: int,
    poll_interval_s: float,
    conn_factory: Any,
    handler: Any,
) -> None:
    """Main worker loop.

    Loops:
      1. If shutdown requested → run shutdown coordination, exit.
      2. Try claim_one. If None, sleep and continue.
      3. Set state.current_job_id + current_worker_id, run handler(job),
         clear them.
      4. handler is expected to call mark_done or mark_failed itself.

    handler is injected so unit tests can substitute a stub without
    spinning up real OCR/parse work. Per ADR-0019 §D6, the worker does
    NOT call mark_done / mark_failed itself — the handler decides
    success vs failure based on its own work.

    Connection lifecycle (code-CR M1 TODO, 2026-05-26): every loop
    iteration opens a fresh psycopg.AsyncConnection. At
    poll_interval_s=1.0 that's ~86k connections/day per worker — TCP +
    auth overhead per iteration. Acceptable at M2b ingestion volumes
    (tens of uploads/day) but a connection-pool upgrade is filed in
    BACKLOG (psycopg_pool.AsyncConnectionPool) ahead of M5 prod tuning.
    """
    while not state.shutdown_requested:
        async with await conn_factory() as conn:
            job = await claim_one(
                conn, queue=queue, worker_id=worker_id, vis_timeout_s=vis_timeout_s
            )
        if job is None:
            await asyncio.sleep(poll_interval_s)
            continue
        state.current_job_id = job.id
        state.current_worker_id = worker_id
        try:
            await handler(job)
        finally:
            state.current_job_id = None
            state.current_worker_id = None
    await _handle_shutdown(state, conn_factory)


async def _default_handler(job: Job, *, conn_factory: Any, worker_id: str) -> None:
    """Stub handler — DEFAULT FAIL.

    M2b #4 replaces this with the real OCR/parse path. Until then, the
    default explicitly marks the job failed so it does not silently
    rot in 'in_progress'. Code-CR m5 (2026-05-26): the previous stub
    only logged, leaving claimed jobs stuck in_progress until visibility
    timeout — a job-eating black hole for any operator that
    accidentally ran the worker without a real handler.
    """
    logger.warning(
        "worker received job with no handler wired (M2b #4 deferred); marking failed",
        extra={"job_id": str(job.id)},
    )
    async with await conn_factory() as conn:
        await mark_failed(
            conn,
            job_id=job.id,
            worker_id=worker_id,
            error="no handler wired (M2b #4 deferred — _default_handler explicit fail)",
        )


def main() -> int:
    """Entry point. Per py-script-logging-init, init_logging is line 1."""
    init_logging()

    # Windows-only — psycopg v3 async mode is incompatible with the
    # default ProactorEventLoop on Python 3.8+; it requires the selector
    # loop. The fix MUST land before any `asyncio.run(...)` call further
    # below. Linux + macOS already default to the compatible loop, so
    # this is a no-op there. Caught at the M2b #5 manual-smoke step on
    # 2026-05-27 — the test suite stubs `conn_factory` so it never hits
    # the real psycopg adapter, and CI runs on Linux where the bug
    # doesn't surface; the local Windows smoke was the only verification
    # surface that exercises the real connect path.
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    database_url = os.environ.get("DATABASE_URL")
    if database_url is None:
        logger.error("worker: DATABASE_URL must be set")
        return 1

    # M2b #5 — required env for the media-ingest handler. Fail loud at
    # startup so a misconfigured deployment doesn't silently mark every
    # ingest job failed via BlobReadFailed (ADR-0021 §D11).
    try:
        blob_root = resolve_blob_root()
        ingest_api_base_url = resolve_ingest_api_base_url()
    except RuntimeError as e:
        logger.error("worker: %s", e)
        return 1

    queue = os.environ.get("WORKER_QUEUE", "ingest")
    vis_timeout_s = int(os.environ.get("WORKER_VIS_TIMEOUT_S", "60"))
    poll_interval_s = float(os.environ.get("WORKER_POLL_INTERVAL_S", "1.0"))
    ingest_api_timeout_s = float(os.environ.get("INGEST_API_TIMEOUT_S", "30.0"))
    worker_id = make_worker_id()

    state = WorkerState()
    install_signal_handler(state)

    def conn_factory() -> Any:
        return psycopg.AsyncConnection.connect(database_url)

    # ADR-0021 §D10 — httpx.AsyncClient singleton per worker lifetime.
    http_client = build_client(timeout_s=ingest_api_timeout_s)

    media_ingest_handler = make_media_ingest_handler(
        conn_factory=conn_factory,
        worker_id=worker_id,
        http_client=http_client,
        ingest_api_base_url=ingest_api_base_url,
        blob_root=blob_root,
    )
    registry = build_registry(media_ingest_handler=media_ingest_handler)

    logger.info(
        "worker starting",
        extra={"worker_id": worker_id, "queue": queue, "vis_timeout_s": vis_timeout_s},
    )

    async def dispatch(job: Job) -> None:
        handler_fn = registry.get(job.queue_name)
        if handler_fn is None:
            # Unknown queue — fall back to the explicit-fail default per
            # ADR-0019 §D6. Preserves the "no silently rotting jobs"
            # invariant even when a new queue lands without a handler.
            await _default_handler(job, conn_factory=conn_factory, worker_id=worker_id)
            return
        await handler_fn(job)

    async def run() -> None:
        try:
            await poll_loop(
                state,
                queue=queue,
                worker_id=worker_id,
                vis_timeout_s=vis_timeout_s,
                poll_interval_s=poll_interval_s,
                conn_factory=conn_factory,
                handler=dispatch,
            )
        finally:
            # Drain the connection pool on shutdown so test runs + ops
            # teardown don't leak sockets.
            await http_client.aclose()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        logger.info("worker: KeyboardInterrupt; exiting")
    return 0


if __name__ == "__main__":
    sys.exit(main())
