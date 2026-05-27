"""Integration tests for api/jobs.py — ADR-0019 M2b #3 worker consumer.

Requires DATABASE_URL pointing at a Postgres with migrations applied
(drizzle/migrations/0004_jobs.sql). Per the project pattern,
DATABASE_URL must be set in CI; locally the tests skip without it.
"""

from __future__ import annotations

import json
import os
import signal
import sys
from collections.abc import AsyncIterator, Iterator
from dataclasses import fields as dataclass_fields
from typing import Any
from uuid import UUID, uuid4

import psycopg
import pytest
import pytest_asyncio
from psycopg.types.json import Jsonb

from api import log_event as le
from api.jobs import Job, claim_one, mark_done, mark_failed
from api.worker import WorkerState, install_signal_handler

DATABASE_URL = os.environ.get("DATABASE_URL")
IS_CI = os.environ.get("CI") == "true"

if IS_CI and DATABASE_URL is None:
    raise RuntimeError("DATABASE_URL must be set in CI; jobs integration test cannot silently skip")

pytestmark = pytest.mark.skipif(DATABASE_URL is None, reason="DATABASE_URL not set")


@pytest_asyncio.fixture
async def conn() -> AsyncIterator[psycopg.AsyncConnection[Any]]:
    """One psycopg async connection per test; truncated before each."""
    assert DATABASE_URL is not None
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as c:
        async with c.cursor() as cur:
            await cur.execute("TRUNCATE jobs, audit_log CASCADE")
        await c.commit()
        yield c


async def _seed_job(
    conn: psycopg.AsyncConnection[Any],
    *,
    queue: str = "ingest",
    idempotency_key: str | None = None,
    payload: dict[str, Any] | None = None,
    max_attempts: int = 5,
) -> UUID:
    """Insert a fresh queued job; returns the row id."""
    key = idempotency_key or f"key-{uuid4().hex[:12]}"
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO jobs (queue_name, payload, idempotency_key, max_attempts)
            VALUES (%s, %s::jsonb, %s, %s)
            RETURNING id
            """,
            (queue, Jsonb(payload or {"entry_id": "x"}), key, max_attempts),
        )
        row = await cur.fetchone()
        assert row is not None
    await conn.commit()
    # psycopg v3 returns UUID for uuid columns; no defensive cast needed.
    return row[0]  # type: ignore[no-any-return]


# -----------------------------------------------------------------------
# Schema-mirror test (plan-CR M3 mechanical floor for cross-language drift)
# -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_job_dataclass_mirrors_jobs_table_columns(
    conn: psycopg.AsyncConnection[Any],
) -> None:
    """Python ``Job`` dataclass fields ⊇ ``jobs`` table columns.

    A future Drizzle migration that adds a column to ``jobs`` without
    extending ``Job`` would let the new column silently drift out of
    sync. This test fails loudly on first run after such a migration —
    forcing the dataclass update to ship in the same PR.
    """
    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name='jobs' AND table_schema='public'"
        )
        db_columns = {row[0] async for row in cur}
    dataclass_fields_set = {f.name for f in dataclass_fields(Job)}
    # Bidirectional drift check (code-CR M3, 2026-05-26): catches both
    # directions — a migration adding a column without updating Job (left)
    # AND a Job field added without a migration (right).
    db_only = db_columns - dataclass_fields_set
    dc_only = dataclass_fields_set - db_columns
    assert not db_only and not dc_only, (
        f"jobs ↔ Job dataclass drift — db_only={db_only}, dataclass_only={dc_only}. "
        f"Reconcile in the same PR."
    )


# -----------------------------------------------------------------------
# claim_one
# -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_claim_one_returns_none_on_empty_queue(
    conn: psycopg.AsyncConnection[Any],
) -> None:
    result = await claim_one(conn, queue="ingest", worker_id="w-1", vis_timeout_s=60)
    assert result is None


@pytest.mark.asyncio
async def test_claim_one_returns_queued_row_and_writes_audit(
    conn: psycopg.AsyncConnection[Any],
) -> None:
    job_id = await _seed_job(conn)
    claimed = await claim_one(conn, queue="ingest", worker_id="w-1", vis_timeout_s=60)
    assert claimed is not None
    assert claimed.id == job_id
    assert claimed.state == "in_progress"
    assert claimed.locked_by == "w-1"
    assert claimed.locked_until is not None

    async with conn.cursor() as cur:
        await cur.execute("SELECT kind, payload FROM audit_log WHERE kind='job_dispatched'")
        rows = await cur.fetchall()
    assert len(rows) == 1
    assert rows[0][1]["job_id"] == str(job_id)
    assert rows[0][1]["worker_id"] == "w-1"


@pytest.mark.asyncio
async def test_claim_one_ignores_already_claimed_rows() -> None:
    """SKIP LOCKED via two distinct connections; worker B should NOT
    re-claim the row worker A holds.

    Negative-assertion shape (WORKFLOW.md): if SKIP LOCKED were absent,
    worker B would block on the lock and eventually re-claim once
    worker A's transaction released — both workers would see the same
    job. The assertion that B sees None proves SKIP LOCKED, not just
    queue ordering.
    """
    assert DATABASE_URL is not None
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as ca:
        async with ca.cursor() as cur:
            await cur.execute("TRUNCATE jobs, audit_log CASCADE")
        await ca.commit()
        await _seed_job(ca)
        # Worker A claims inside its own outer transaction so the lock is
        # held while worker B tries.
        await ca.set_autocommit(False)
        try:
            async with ca.cursor() as cur:
                await cur.execute(
                    "UPDATE jobs SET state='in_progress', "
                    "locked_until=now()+interval '60 seconds', "
                    "locked_by='wA', updated_at=now() WHERE id = ("
                    "  SELECT id FROM jobs WHERE state='queued' "
                    "  FOR UPDATE SKIP LOCKED LIMIT 1)"
                )
            # Worker B tries to claim; the only row is locked by A's open tx.
            async with await psycopg.AsyncConnection.connect(DATABASE_URL) as cb:
                result_b = await claim_one(cb, queue="ingest", worker_id="wB", vis_timeout_s=60)
            assert result_b is None
        finally:
            await ca.rollback()


@pytest.mark.asyncio
async def test_claim_one_respects_run_after(conn: psycopg.AsyncConnection[Any]) -> None:
    """A job with run_after in the future is invisible to claim_one."""
    async with conn.cursor() as cur:
        await cur.execute(
            "INSERT INTO jobs (queue_name, payload, idempotency_key, run_after) "
            "VALUES ('ingest', '{}'::jsonb, 'future-key', now() + interval '1 hour')"
        )
    await conn.commit()
    result = await claim_one(conn, queue="ingest", worker_id="w-1", vis_timeout_s=60)
    assert result is None, "claim_one returned a row whose run_after is still in the future"


@pytest.mark.asyncio
async def test_claim_one_reclaims_expired_lock(conn: psycopg.AsyncConnection[Any]) -> None:
    """ADR-0019 §D6 expired-lock-reclaim: a row stuck at
    state='in_progress' with locked_until in the past (prior worker died
    before mark_*) is claimable again by a fresh worker.

    Negative-assertion shape (code-CR M2, 2026-05-26): if the predicate
    were ``state='queued'`` only (omitting the ``OR (state='in_progress'
    AND locked_until < now())`` clause), this test would fail — the
    dead-worker's row would stay stuck in_progress with no way back to
    claimable. The previous version of this test pre-flipped state to
    'queued' before calling claim_one, which made it tautological — the
    predicate's reclaim arm was untested. Fixed: the test now leaves the
    row at state='in_progress' so only the reclaim arm of the predicate
    can match.
    """
    job_id = await _seed_job(conn)
    async with conn.cursor() as cur:
        await cur.execute(
            "UPDATE jobs SET state='in_progress', "
            "locked_until=now() - interval '10 seconds', "
            "locked_by='dead-worker', updated_at=now() "
            "WHERE id=%s",
            (job_id,),
        )
    await conn.commit()
    result = await claim_one(conn, queue="ingest", worker_id="fresh-worker", vis_timeout_s=60)
    assert result is not None, "expired-lock row was not re-claimable"
    assert result.locked_by == "fresh-worker"
    assert result.id == job_id
    # attempts NOT bumped by a reclaim — the prior worker's bump-on-failure
    # would have done that. A reclaim is the "no mark_failed ever ran"
    # path, so the counter stays where it was.
    assert result.attempts == 0


# -----------------------------------------------------------------------
# mark_done
# -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mark_done_clears_lock_and_writes_audit(
    conn: psycopg.AsyncConnection[Any],
) -> None:
    job_id = await _seed_job(conn)
    await claim_one(conn, queue="ingest", worker_id="w-1", vis_timeout_s=60)
    await mark_done(conn, job_id=job_id, worker_id="w-1")

    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT state, locked_until, locked_by FROM jobs WHERE id=%s",
            (job_id,),
        )
        row = await cur.fetchone()
        assert row is not None
        assert row[0] == "done"
        assert row[1] is None
        assert row[2] is None
        await cur.execute("SELECT 1 FROM audit_log WHERE kind='job_done'")
        assert (await cur.fetchone()) is not None


# -----------------------------------------------------------------------
# mark_failed
# -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mark_failed_below_max_writes_job_failed_audit_and_keeps_queued(
    conn: psycopg.AsyncConnection[Any],
) -> None:
    """First failure: attempts goes 0 → 1; row returns to 'queued' for
    retry; audit_log kind='job_failed'.
    """
    job_id = await _seed_job(conn, max_attempts=3)
    await claim_one(conn, queue="ingest", worker_id="w-1", vis_timeout_s=60)
    await mark_failed(conn, job_id=job_id, worker_id="w-1", error="transient")

    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT state, attempts, last_error, locked_until, locked_by FROM jobs WHERE id=%s",
            (job_id,),
        )
        row = await cur.fetchone()
        assert row is not None
        assert row[0] == "queued"
        assert row[1] == 1
        assert row[2] == "transient"
        # locked_until + locked_by MUST be cleared so the next claim_one
        # sees the row as available. Per ADR-0019 §F.
        assert row[3] is None
        assert row[4] is None
        await cur.execute("SELECT kind FROM audit_log WHERE kind='job_failed'")
        assert (await cur.fetchone()) is not None
        await cur.execute("SELECT kind FROM audit_log WHERE kind='job_dead'")
        assert (await cur.fetchone()) is None


@pytest.mark.asyncio
async def test_mark_failed_at_max_promotes_to_dead_writes_job_dead_audit(
    conn: psycopg.AsyncConnection[Any],
) -> None:
    """Last failure: attempts hits max_attempts; row promotes to 'dead';
    audit_log kind='job_dead' (NOT 'job_failed') — different terminal
    discriminator per ADR-0019 Amendment §A.
    """
    job_id = await _seed_job(conn, max_attempts=2)
    # First failure: 0 → 1, still queued.
    await claim_one(conn, queue="ingest", worker_id="w-1", vis_timeout_s=60)
    await mark_failed(conn, job_id=job_id, worker_id="w-1", error="first")
    # Second failure: 1 → 2 (= max), promotes to dead.
    await claim_one(conn, queue="ingest", worker_id="w-2", vis_timeout_s=60)
    await mark_failed(conn, job_id=job_id, worker_id="w-2", error="final")

    async with conn.cursor() as cur:
        await cur.execute("SELECT state, attempts FROM jobs WHERE id=%s", (job_id,))
        row = await cur.fetchone()
        assert row is not None
        assert row[0] == "dead"
        assert row[1] == 2
        # Exactly one dead row (not two — only the final attempt promotes).
        await cur.execute("SELECT count(*) FROM audit_log WHERE kind='job_dead'")
        cnt = await cur.fetchone()
        assert cnt is not None
        assert cnt[0] == 1
        # job_failed row from the first attempt is still present (only the
        # terminal promotion writes job_dead; the bump-attempts step writes
        # job_failed regardless).
        await cur.execute("SELECT count(*) FROM audit_log WHERE kind='job_failed'")
        cnt2 = await cur.fetchone()
        assert cnt2 is not None
        assert cnt2[0] == 1


# -----------------------------------------------------------------------
# Ownership guard (code-CR B2, 2026-05-26)
# -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mark_done_no_op_when_worker_lost_lock(
    conn: psycopg.AsyncConnection[Any],
) -> None:
    """If the visibility timeout expired and another worker reclaimed
    the row between claim and mark_done, the original worker's
    mark_done MUST NOT mark the row done — only the current owner can.

    Negative-assertion shape: without ``AND locked_by=%s`` in the
    UPDATE, this test would fail — the wrong-owner mark_done would
    succeed and overwrite the new owner's lock. The assertion that
    state is still 'in_progress' and locked_by is still the new owner
    proves the ownership guard fired.
    """
    job_id = await _seed_job(conn)
    await claim_one(conn, queue="ingest", worker_id="w-original", vis_timeout_s=60)
    # Simulate another worker reclaiming after a visibility-timeout expiry.
    async with conn.cursor() as cur:
        await cur.execute(
            "UPDATE jobs SET locked_by='w-other', updated_at=now() WHERE id=%s",
            (job_id,),
        )
    await conn.commit()
    # Original worker tries to mark_done — must no-op.
    await mark_done(conn, job_id=job_id, worker_id="w-original")
    async with conn.cursor() as cur:
        await cur.execute("SELECT state, locked_by FROM jobs WHERE id=%s", (job_id,))
        row = await cur.fetchone()
        assert row is not None
        assert row[0] == "in_progress"
        assert row[1] == "w-other"
        await cur.execute("SELECT count(*) FROM audit_log WHERE kind='job_done'")
        cnt = await cur.fetchone()
        assert cnt is not None
        assert cnt[0] == 0


@pytest.mark.asyncio
async def test_mark_failed_no_op_when_row_vanished(
    conn: psycopg.AsyncConnection[Any],
) -> None:
    """Code-CR B5 (2026-05-26): the row-vanished branch of mark_failed.

    If the row is deleted between claim and mark_failed (e.g., cleanup
    cron raced), mark_failed must roll back and return without raising
    — the row's gone, attribute nothing.

    Negative-assertion shape: if the function raised on row-vanished
    (previous shape), an OCR error during a cleanup race would crash
    the worker. The post-fix shape is a logged no-op.
    """
    job_id = await _seed_job(conn)
    await claim_one(conn, queue="ingest", worker_id="w-1", vis_timeout_s=60)
    # Delete the row (simulating the cleanup-cron race or an operator
    # surgery).
    async with conn.cursor() as cur:
        await cur.execute("DELETE FROM jobs WHERE id=%s", (job_id,))
    await conn.commit()
    # Must not raise.
    await mark_failed(conn, job_id=job_id, worker_id="w-1", error="orphaned")
    # No job_failed / job_dead row should be present — the function bailed
    # before writing audit. (job_dispatched from claim_one is still there.)
    async with conn.cursor() as cur:
        await cur.execute("SELECT count(*) FROM audit_log WHERE kind IN ('job_failed','job_dead')")
        cnt = await cur.fetchone()
        assert cnt is not None
        assert cnt[0] == 0


# -----------------------------------------------------------------------
# SIGTERM handler (worker.py)
# -----------------------------------------------------------------------


@pytest.fixture
def sigterm_teardown() -> Iterator[None]:
    """Restore SIGTERM to SIG_DFL after each test that installs a handler.

    Code-CR M4 (2026-05-26): without teardown, the installed handler
    leaks across tests and may behave differently under pytest ordering.
    """
    yield
    signal.signal(signal.SIGTERM, signal.SIG_DFL)


@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM semantics differ on Windows")
def test_sigterm_handler_flips_shutdown_flag(sigterm_teardown: None) -> None:
    """ADR-0019 §D6: SIGTERM during in-flight job marks it 'failed' (not a
    graceful release). The handler itself only flips a flag — DB work
    runs in the poll loop's outer guard. This test exercises the flag-
    flip half; the DB-write half is exercised by the full-loop test
    below.

    Negative-assertion shape: if install_signal_handler never wired a
    handler (or wired it to the wrong signal), state.shutdown_requested
    would stay False after signal.raise_signal(SIGTERM).
    """
    state = WorkerState()
    install_signal_handler(state)
    assert state.shutdown_requested is False
    signal.raise_signal(signal.SIGTERM)
    # Give the signal handler a tick to run. signal.raise_signal is
    # synchronous on Unix; on Windows the SIGTERM delivery semantics
    # differ but pytest typically runs on Linux in CI.
    assert state.shutdown_requested is True


@pytest.mark.skipif(sys.platform == "win32", reason="SIGTERM semantics differ on Windows")
@pytest.mark.asyncio
async def test_sigterm_during_in_flight_marks_job_failed(
    conn: psycopg.AsyncConnection[Any],
    sigterm_teardown: None,
) -> None:
    """ADR-0019 §D6 + plan-CR M4: the race between claim and handler
    completion. We simulate the SIGTERM by raising it AFTER claim_one
    commits but BEFORE the handler invocation begins — the interposed-
    signal shape.

    Negative-assertion: if the handler did NOT inspect current_job_id
    on shutdown (e.g., only called sys.exit(0)), the row would stay in
    'in_progress' state indefinitely — a stuck row only the lock-
    expiry sweep could rescue. The assertion that the row is in
    'queued' state with attempts=1 proves the shutdown coordination
    fired.
    """
    job_id = await _seed_job(conn, max_attempts=3)

    state = WorkerState()
    install_signal_handler(state)

    assert DATABASE_URL is not None

    def conn_factory() -> Any:
        return psycopg.AsyncConnection.connect(DATABASE_URL)

    # Stand-in for the worker's claim phase.
    async with await psycopg.AsyncConnection.connect(DATABASE_URL) as claim_conn:
        claimed = await claim_one(
            claim_conn, queue="ingest", worker_id="w-sigterm", vis_timeout_s=60
        )
    assert claimed is not None

    # Interpose the signal between claim and "handler start" — set
    # current_job_id + current_worker_id (the worker would do both,
    # per the ownership-guard contract from code-CR B2), then raise
    # SIGTERM before any handler runs.
    state.current_job_id = claimed.id
    state.current_worker_id = "w-sigterm"
    signal.raise_signal(signal.SIGTERM)
    assert state.shutdown_requested is True

    # Invoke the shutdown coordination directly — the poll loop would
    # observe the flag at the top of its next iteration.
    from api.worker import _handle_shutdown

    await _handle_shutdown(state, conn_factory)

    # The in-flight row should now be 'queued' (attempt counted, retry
    # eligible) with audit_log kind='job_failed' written.
    async with (
        await psycopg.AsyncConnection.connect(DATABASE_URL) as verify_conn,
        verify_conn.cursor() as cur,
    ):
        await cur.execute(
            "SELECT state, attempts, last_error FROM jobs WHERE id=%s",
            (job_id,),
        )
        row = await cur.fetchone()
        assert row is not None
        assert row[0] == "queued"
        assert row[1] == 1
        assert row[2] is not None
        assert "SIGTERM" in row[2]


# -----------------------------------------------------------------------
# LogEvent emission (ADR-0020 §D4 wire-point matrix)
# -----------------------------------------------------------------------
#
# Sink-capture fixture swaps api.log_event._sink with a list-appender so
# each test can assert exact NDJSON shape (per WORKFLOW.md negative-
# assertion-tests rule — existence-only checks are too weak; the strongest
# form proves the SHAPE of the emitted record).
#
# Rule under test: audit_log row written ⇔ LogEventJob line emitted.
# The lost-ownership, row-vanished, and empty-queue branches MUST NOT
# emit; the four happy-path branches (claimed/done/failed/dead) MUST.
# -----------------------------------------------------------------------


class _LiveView:
    """Adapter exposing parsed view of the captured NDJSON line list.

    Reading ``.events`` re-parses each line on every access so a test
    that inspects events after multiple emissions sees the full set
    (lazy snapshot, no pre-parse to allow mid-test additions).
    """

    def __init__(self, lines: list[str]) -> None:
        self._lines = lines

    @property
    def events(self) -> list[dict[str, Any]]:
        return [json.loads(line) for line in self._lines]

    def __len__(self) -> int:
        return len(self._lines)


@pytest.fixture
def captured_events() -> Iterator[_LiveView]:
    """Capture every LogEvent NDJSON line emitted during the test.

    Yields a ``_LiveView`` whose ``.events`` property re-parses the captured
    NDJSON lines on each access. The module sink is restored on teardown.
    """
    lines: list[str] = []
    le.set_sink(lines.append)
    try:
        yield _LiveView(lines)
    finally:
        le.reset_sink()


@pytest.mark.asyncio
async def test_claim_one_emits_logevent_with_exact_shape(
    conn: psycopg.AsyncConnection[Any],
    captured_events: _LiveView,
) -> None:
    """ADR-0020 §D4 wire-point matrix row 1: claim_one success branch
    emits ``transition="claimed"`` with exact field set.

    Negative-assertion: if the emit were dropped, ``captured_events.events``
    would be empty; if the emit had the wrong transition, the assertion
    on ``transition == "claimed"`` would fail. The exact-shape check
    proves both presence and correctness.
    """
    job_id = await _seed_job(conn)
    claimed = await claim_one(conn, queue="ingest", worker_id="w-1", vis_timeout_s=60)
    assert claimed is not None
    events = captured_events.events
    assert len(events) == 1
    evt = events[0]
    assert evt["kind"] == "job"
    assert evt["queue_name"] == "ingest"
    assert evt["job_id"] == str(job_id)
    assert evt["transition"] == "claimed"
    assert isinstance(evt["latency_ms"], (int, float))
    assert evt["latency_ms"] >= 0
    # cost_usd is None per ADR-0019 §D7 + ADR-0005 carve-out — the
    # omit-None pass drops it from the payload entirely.
    assert "cost_usd" not in evt
    # error_class None at M2b #3 sites per ADR-0020 §D8 → omitted.
    assert "error_class" not in evt
    assert evt["attempts"] == 0
    assert evt["status"] == "ok"
    assert "ts" in evt


@pytest.mark.asyncio
async def test_claim_one_emits_no_logevent_on_empty_queue(
    conn: psycopg.AsyncConnection[Any],
    captured_events: _LiveView,
) -> None:
    """ADR-0020 §D4 wire-point matrix row 2: empty-queue branch emits no
    LogEvent (and writes no audit row — the two-row rule).

    Negative-assertion: if the emit fired unconditionally (before the
    None-row check), this test would see a phantom event with no
    corresponding audit row, violating the matrix invariant.
    """
    result = await claim_one(conn, queue="ingest", worker_id="w-1", vis_timeout_s=60)
    assert result is None
    assert captured_events.events == []


@pytest.mark.asyncio
async def test_mark_done_emits_done_logevent_with_exact_shape(
    conn: psycopg.AsyncConnection[Any],
    captured_events: _LiveView,
) -> None:
    """ADR-0020 §D4 wire-point matrix row 3: mark_done success branch
    emits ``transition="done"`` with queue_name read from RETURNING.
    """
    job_id = await _seed_job(conn)
    await claim_one(conn, queue="ingest", worker_id="w-1", vis_timeout_s=60)
    await mark_done(conn, job_id=job_id, worker_id="w-1")
    # Two events: claimed + done. Inspect the second.
    events = captured_events.events
    assert len(events) == 2
    done = events[1]
    assert done["kind"] == "job"
    assert done["queue_name"] == "ingest"
    assert done["job_id"] == str(job_id)
    assert done["transition"] == "done"
    assert done["status"] == "ok"
    # attempts intentionally None on mark_done (the success path does not
    # bump attempts) — omitted from the NDJSON line.
    assert "attempts" not in done
    # error_class=None per ADR-0020 §D8 → omitted. Negative-assertion
    # pin (code-CR M2, 2026-05-27): if a future implementer changes
    # error_class=None to error_class=error (the free-text), this
    # assertion fails — guards the JSDoc contract on
    # LogEventJob.error_class beyond author discipline.
    assert "error_class" not in done


@pytest.mark.asyncio
async def test_mark_done_lost_ownership_emits_no_logevent(
    conn: psycopg.AsyncConnection[Any],
    captured_events: _LiveView,
) -> None:
    """ADR-0020 §D4 wire-point matrix row 4: mark_done lost-ownership
    branch writes no audit row and emits no LogEvent.

    Negative-assertion: if the emit fired before the ownership check,
    this test would see a phantom ``done`` event for a row this worker
    no longer owns — credit misattribution to a non-owner.
    """
    job_id = await _seed_job(conn)
    await claim_one(conn, queue="ingest", worker_id="w-original", vis_timeout_s=60)
    pre_count = len(captured_events)
    assert pre_count == 1, "claim_one should have emitted exactly one LogEvent baseline"
    # Simulate another worker reclaiming.
    async with conn.cursor() as cur:
        await cur.execute(
            "UPDATE jobs SET locked_by='w-other', updated_at=now() WHERE id=%s",
            (job_id,),
        )
    await conn.commit()
    await mark_done(conn, job_id=job_id, worker_id="w-original")
    # No new event emitted by the lost-ownership branch.
    assert len(captured_events) == pre_count


@pytest.mark.asyncio
async def test_mark_failed_below_max_emits_failed_logevent(
    conn: psycopg.AsyncConnection[Any],
    captured_events: _LiveView,
) -> None:
    """ADR-0020 §D4 wire-point matrix row 5: mark_failed queued-retry
    branch emits ``transition="failed"`` with attempts=new value,
    status=error, error_class=None per §D8.
    """
    job_id = await _seed_job(conn, max_attempts=3)
    await claim_one(conn, queue="ingest", worker_id="w-1", vis_timeout_s=60)
    await mark_failed(conn, job_id=job_id, worker_id="w-1", error="transient")
    events = captured_events.events
    assert len(events) == 2
    failed = events[1]
    assert failed["kind"] == "job"
    assert failed["queue_name"] == "ingest"
    assert failed["job_id"] == str(job_id)
    assert failed["transition"] == "failed"
    assert failed["attempts"] == 1
    assert failed["status"] == "error"
    # error_class is None per ADR-0020 §D8 → omitted from NDJSON.
    assert "error_class" not in failed


@pytest.mark.asyncio
async def test_mark_failed_at_max_emits_dead_logevent(
    conn: psycopg.AsyncConnection[Any],
    captured_events: _LiveView,
) -> None:
    """ADR-0020 §D4 wire-point matrix row 6: mark_failed dead branch
    emits ``transition="dead"`` (NOT ``"failed"``) — terminal
    discriminator matches the audit_log kind=``job_dead`` per ADR-0019
    Amendment §A.
    """
    job_id = await _seed_job(conn, max_attempts=2)
    await claim_one(conn, queue="ingest", worker_id="w-1", vis_timeout_s=60)
    await mark_failed(conn, job_id=job_id, worker_id="w-1", error="first")
    await claim_one(conn, queue="ingest", worker_id="w-2", vis_timeout_s=60)
    await mark_failed(conn, job_id=job_id, worker_id="w-2", error="final")
    events = captured_events.events
    # 4 events: claimed, failed, claimed, dead.
    assert len(events) == 4
    assert events[3]["transition"] == "dead"
    assert events[3]["attempts"] == 2
    assert events[3]["status"] == "error"
    # error_class=None per ADR-0020 §D8 → omitted on the dead branch
    # too. Negative-assertion pin (code-CR M2, 2026-05-27): catches a
    # future implementer who flips error_class=None to error_class=error
    # for the dead-only branch (sibling of the failed-branch pin).
    assert "error_class" not in events[3]


@pytest.mark.asyncio
async def test_mark_failed_row_vanished_emits_no_logevent(
    conn: psycopg.AsyncConnection[Any],
    captured_events: _LiveView,
) -> None:
    """ADR-0020 §D4 wire-point matrix row 7: row-vanished branch rolls
    back, returns no-op, emits no LogEvent.
    """
    job_id = await _seed_job(conn)
    await claim_one(conn, queue="ingest", worker_id="w-1", vis_timeout_s=60)
    pre_count = len(captured_events)
    async with conn.cursor() as cur:
        await cur.execute("DELETE FROM jobs WHERE id=%s", (job_id,))
    await conn.commit()
    await mark_failed(conn, job_id=job_id, worker_id="w-1", error="orphaned")
    # No new event from the vanished branch.
    assert len(captured_events) == pre_count


# -----------------------------------------------------------------------
# ADR-0021 §D8 — mark_failed(error_class=...) threading.
# The OCR-handler taxonomy trigger satisfied at M2b #5 (ADR-0020 §D8
# deferral closed). These tests pin both legs (queued-retry + dead) of
# the audit_log.payload + LogEventJob 1:1 contract.
# -----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mark_failed_with_error_class_threads_to_audit_log_and_logevent_failed_branch(
    conn: psycopg.AsyncConnection[Any],
    captured_events: _LiveView,
) -> None:
    """ADR-0021 §D8: supplying error_class lands it in audit_log.payload
    AND in LogEventJob.error_class on the queued-retry branch.

    Negative-assertion: dropping the audit_payload["error_class"] = ...
    line in api/jobs.py would fail the audit_log check; dropping the
    error_class=error_class kwarg on LogEventJob(...) would fail the
    NDJSON check. Both branches gated.
    """
    job_id = await _seed_job(conn, max_attempts=3)
    await claim_one(conn, queue="ingest", worker_id="w-1", vis_timeout_s=60)
    await mark_failed(
        conn,
        job_id=job_id,
        worker_id="w-1",
        error="ingest_api 5xx",
        error_class="ingest_api_5xx",
    )

    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT payload FROM audit_log WHERE kind='job_failed' AND payload->>'job_id'=%s",
            (str(job_id),),
        )
        row = await cur.fetchone()
        assert row is not None
        assert row[0]["error_class"] == "ingest_api_5xx"
        assert row[0]["last_error"] == "ingest_api 5xx"

    # claimed event + failed event = 2; failed is the second one.
    assert len(captured_events.events) == 2
    failed = captured_events.events[1]
    assert failed["transition"] == "failed"
    assert failed["error_class"] == "ingest_api_5xx"
    assert failed["status"] == "error"


@pytest.mark.asyncio
async def test_mark_failed_with_error_class_threads_to_audit_log_and_logevent_dead_branch(
    conn: psycopg.AsyncConnection[Any],
    captured_events: _LiveView,
) -> None:
    """ADR-0021 §D8: same threading on the dead branch — `job_dead`
    audit row + LogEventJob `transition=dead` both carry the supplied
    error_class. Symmetric to the failed-branch pin above.
    """
    job_id = await _seed_job(conn, max_attempts=2)
    await claim_one(conn, queue="ingest", worker_id="w-1", vis_timeout_s=60)
    await mark_failed(
        conn,
        job_id=job_id,
        worker_id="w-1",
        error="first attempt",
        error_class="parse_failed",
    )
    await claim_one(conn, queue="ingest", worker_id="w-2", vis_timeout_s=60)
    await mark_failed(
        conn,
        job_id=job_id,
        worker_id="w-2",
        error="final attempt",
        error_class="parse_failed",
    )

    async with conn.cursor() as cur:
        await cur.execute(
            "SELECT payload FROM audit_log WHERE kind='job_dead' AND payload->>'job_id'=%s",
            (str(job_id),),
        )
        row = await cur.fetchone()
        assert row is not None
        assert row[0]["error_class"] == "parse_failed"
        assert row[0]["last_error"] == "final attempt"

    # 4 events: claimed, failed, claimed, dead.
    assert len(captured_events.events) == 4
    dead = captured_events.events[3]
    assert dead["transition"] == "dead"
    assert dead["error_class"] == "parse_failed"
    assert dead["status"] == "error"
