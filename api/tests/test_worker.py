"""ADR-0019 M2b — worker orchestration tests (poll loop + SIGTERM + dispatch).

The media-ingest handler branches are covered in
``test_handlers_media_ingest.py``; this file covers the orchestration layer
in ``api/worker.py`` that sits *above* the handler:

    - ``make_worker_id``          — operator-readable identity shape.
    - ``install_signal_handler``  — SIGTERM flips the shutdown flag only.
    - ``poll_loop``               — claim → run handler → clear state;
                                    empty-queue sleep; finally-clears on raise.
    - ``_handle_shutdown``        — in-flight job → mark_failed; no-op when
                                    idle; swallows cleanup exceptions.
    - ``_default_handler``        — explicit-fail for an unwired queue.
    - ``dispatch``                — known queue → handler; unknown queue →
                                    _default_handler (ADR-0019 §D6
                                    "no silently rotting jobs" invariant).

Stubs at the seams (no live DB, no live APIs):
    - ``conn_factory`` is an async callable returning an async-context-manager
      stub; none of the real psycopg primitives run.
    - ``claim_one`` / ``mark_failed`` are monkeypatched on ``api.worker``
      (NOT ``api.jobs`` — worker.py binds local names via ``from api.jobs
      import ...``).
    - ``asyncio.sleep`` is monkeypatched on the stdlib ``asyncio`` module
      (the same module object worker.py imports) for the empty-queue test so
      the loop terminates deterministically.
    - ``signal.signal`` is intercepted so no real process-global SIGTERM
      disposition is mutated.

Iron-rule footprint (test surface):
    #8 — no live API SDK imports here.
"""

from __future__ import annotations

import asyncio
import re
import signal
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import pytest

from api import worker
from api.jobs import Job

# --- shared helpers ---


def _make_job(*, queue_name: str = "ingest") -> Job:
    """Minimal Job. Orchestration tests only read ``id`` and ``queue_name``."""
    return Job(
        id=uuid4(),
        queue_name=queue_name,
        payload={"entry_id": str(uuid4())},
        idempotency_key="test-idem-key",
        state="in_progress",
        attempts=1,
        max_attempts=3,
        run_after=datetime.now(UTC),
        locked_until=datetime.now(UTC),
        locked_by="worker-test-0-aaaa",
        last_error=None,
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )


class _StubConn:
    """Async-context-manager stub for the conn yielded by ``conn_factory``.

    Matches the shape ``async with await conn_factory() as conn:`` without
    needing the real psycopg driver.
    """

    async def __aenter__(self) -> _StubConn:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None


async def _conn_factory_stub() -> _StubConn:
    return _StubConn()


@dataclass
class _CapturedMarkFailed:
    job_id: UUID
    worker_id: str
    error: str
    error_class: str | None


@pytest.fixture
def capture_mark_failed(monkeypatch: pytest.MonkeyPatch) -> list[_CapturedMarkFailed]:
    """Replace ``api.worker.mark_failed`` with a capturing async stub."""
    calls: list[_CapturedMarkFailed] = []

    async def _fake_mark_failed(
        _conn: Any,
        *,
        job_id: UUID,
        worker_id: str,
        error: str,
        error_class: str | None = None,
    ) -> None:
        calls.append(
            _CapturedMarkFailed(
                job_id=job_id, worker_id=worker_id, error=error, error_class=error_class
            )
        )

    monkeypatch.setattr(worker, "mark_failed", _fake_mark_failed)
    return calls


# --- make_worker_id ---


def test_make_worker_id_matches_documented_shape() -> None:
    """``worker-<hostname>-<pid>-<4hex>`` per ADR-0019 §D6.

    Splits on the last two hyphens so the pid and random suffix are pinned
    independently of hostname content (hostnames may contain hyphens/digits).
    A single greedy ``.+`` regex would backtrack and let a wider random suffix
    (e.g. ``token_hex(8)``) still match — this asserts exactly four hex chars.
    """
    wid = worker.make_worker_id()
    prefix, pid, rand = wid.rsplit("-", 2)
    assert prefix.startswith("worker-")
    assert pid.isdigit()
    assert re.fullmatch(r"[0-9a-f]{4}", rand), rand


# --- install_signal_handler ---


def test_install_signal_handler_registers_sigterm_handler_that_flips_flag(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SIGTERM handler sets ``shutdown_requested`` and nothing else.

    ``signal.signal`` is intercepted so the real process-global SIGTERM
    disposition is never mutated (M2 — avoids leaking a handler bound to a
    dead WorkerState into the rest of the suite). Sync test — the registered
    handler is a plain function, so it is NOT decorated with asyncio.
    """
    captured: dict[str, Any] = {}

    def _fake_signal(sig: int, hdlr: Any) -> None:
        captured["sig"] = sig
        captured["handler"] = hdlr

    monkeypatch.setattr(signal, "signal", _fake_signal)

    state = worker.WorkerState()
    worker.install_signal_handler(state)

    assert captured["sig"] == signal.SIGTERM
    # Distinguishing: the flag must START False, so the post-invoke True is
    # caused by the handler, not by construction.
    assert state.shutdown_requested is False
    captured["handler"](signal.SIGTERM, None)
    assert state.shutdown_requested is True


# --- poll_loop ---


@pytest.mark.asyncio
async def test_poll_loop_claims_job_runs_handler_then_clears_state(
    monkeypatch: pytest.MonkeyPatch,
    capture_mark_failed: list[_CapturedMarkFailed],
) -> None:
    """Happy path: claim a job, run the handler, clear in-flight state.

    The stub handler flips ``shutdown_requested`` so the loop exits after one
    iteration. Because the job completed cleanly (state cleared in the
    ``finally``), the loop-exit ``_handle_shutdown`` at worker.py line ~174
    takes its no-in-flight branch and does NOT call mark_failed — asserting
    that here exercises the loop→_handle_shutdown wiring end-to-end (Q1/Q4).
    """
    job = _make_job()
    handled: list[Job] = []
    state = worker.WorkerState()

    async def _fake_claim_one(
        _conn: Any, *, queue: str, worker_id: str, vis_timeout_s: int
    ) -> Job | None:
        return job

    async def _handler(j: Job) -> None:
        handled.append(j)
        # Inside the handler, state is set; flip shutdown so the loop exits
        # on the next top-of-loop guard check.
        assert state.current_job_id == job.id
        assert state.current_worker_id == "worker-test-1-bbbb"
        state.shutdown_requested = True

    monkeypatch.setattr(worker, "claim_one", _fake_claim_one)

    await worker.poll_loop(
        state,
        queue="ingest",
        worker_id="worker-test-1-bbbb",
        vis_timeout_s=60,
        poll_interval_s=0.01,
        conn_factory=_conn_factory_stub,
        handler=_handler,
    )

    assert handled == [job]
    # Cleared after the iteration.
    assert state.current_job_id is None
    assert state.current_worker_id is None
    # Clean completion → loop-exit _handle_shutdown found no in-flight job.
    assert capture_mark_failed == []


@pytest.mark.asyncio
async def test_poll_loop_empty_queue_sleeps_and_skips_handler(
    monkeypatch: pytest.MonkeyPatch,
    capture_mark_failed: list[_CapturedMarkFailed],
) -> None:
    """claim_one → None → asyncio.sleep, handler never invoked.

    The fake ``asyncio.sleep`` flips ``shutdown_requested`` so the loop
    terminates on the next top-of-loop guard. Patch target is
    ``api.worker.asyncio.sleep`` (worker.py does ``import asyncio``) and the
    fake is ``async def`` because the call site awaits it.
    """
    state = worker.WorkerState()
    sleeps: list[float] = []
    handler_calls: list[Job] = []

    async def _fake_claim_one(
        _conn: Any, *, queue: str, worker_id: str, vis_timeout_s: int
    ) -> Job | None:
        return None

    async def _fake_sleep(secs: float) -> None:
        sleeps.append(secs)
        state.shutdown_requested = True

    async def _handler(j: Job) -> None:
        handler_calls.append(j)

    monkeypatch.setattr(worker, "claim_one", _fake_claim_one)
    monkeypatch.setattr(asyncio, "sleep", _fake_sleep)

    await worker.poll_loop(
        state,
        queue="ingest",
        worker_id="w",
        vis_timeout_s=60,
        poll_interval_s=0.5,
        conn_factory=_conn_factory_stub,
        handler=_handler,
    )

    assert sleeps == [0.5]
    assert handler_calls == []
    assert capture_mark_failed == []


@pytest.mark.asyncio
async def test_poll_loop_clears_state_even_when_handler_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ``finally`` clears in-flight state even when the handler raises.

    Negative-assertion: if the ``try/finally`` were removed, the exception
    would still propagate (no ``except`` in poll_loop), but ``current_job_id``
    would remain set to ``job.id`` instead of None — so this test catches the
    raise via ``pytest.raises`` and asserts the state was cleared. Without the
    ``finally`` the post-raise assertion fails, distinguishing the two worlds.
    """
    job = _make_job()
    state = worker.WorkerState()

    async def _fake_claim_one(
        _conn: Any, *, queue: str, worker_id: str, vis_timeout_s: int
    ) -> Job | None:
        return job

    async def _exploding_handler(_j: Job) -> None:
        # Pin the mid-flight set so the post-raise None can't pass for the
        # wrong reason (e.g. if the assignment at poll_loop were removed).
        assert state.current_job_id == job.id
        assert state.current_worker_id == "w"
        raise RuntimeError("handler boom")

    monkeypatch.setattr(worker, "claim_one", _fake_claim_one)

    with pytest.raises(RuntimeError, match="handler boom"):
        await worker.poll_loop(
            state,
            queue="ingest",
            worker_id="w",
            vis_timeout_s=60,
            poll_interval_s=0.01,
            conn_factory=_conn_factory_stub,
            handler=_exploding_handler,
        )

    assert state.current_job_id is None
    assert state.current_worker_id is None


# --- _handle_shutdown ---


@pytest.mark.asyncio
async def test_handle_shutdown_marks_in_flight_job_failed(
    capture_mark_failed: list[_CapturedMarkFailed],
) -> None:
    """In-flight job at shutdown → mark_failed with a SIGTERM-labelled error.

    error_class is asserted None: the SIGTERM path intentionally omits the
    taxonomy label (api/jobs.py docstring §"Callers that DO NOT thread
    error_class") — a future accidental label would trip this.
    """
    job = _make_job()
    state = worker.WorkerState()
    state.current_job_id = job.id
    state.current_worker_id = "worker-test-2-cccc"

    await worker._handle_shutdown(state, _conn_factory_stub)

    assert len(capture_mark_failed) == 1
    failed = capture_mark_failed[0]
    assert failed.job_id == job.id
    assert failed.worker_id == "worker-test-2-cccc"
    assert "SIGTERM" in failed.error
    # Pins the call site (worker omits error_class), not mark_failed's real
    # signature — the fake replaces the function, so its default is irrelevant.
    assert failed.error_class is None


@pytest.mark.asyncio
async def test_handle_shutdown_noop_when_no_in_flight_job(
    capture_mark_failed: list[_CapturedMarkFailed],
) -> None:
    """No in-flight job (current_job_id None) → mark_failed NOT called.

    Distinguishing: if the guard were dropped, mark_failed would be invoked
    with a None job_id; asserting the empty capture proves the early return
    fired.
    """
    state = worker.WorkerState()
    assert state.current_job_id is None

    await worker._handle_shutdown(state, _conn_factory_stub)

    assert capture_mark_failed == []


@pytest.mark.asyncio
async def test_handle_shutdown_swallows_mark_failed_exception(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If mark_failed itself raises, _handle_shutdown must NOT propagate.

    Seam: ``mark_failed`` raises (not ``conn_factory``) — exercises the
    ``except Exception`` last-ditch swallow so a cleanup failure can't kill
    the worker on its way out. Negative-assertion: remove the except and this
    ``await`` would raise RuntimeError instead of returning cleanly.
    """
    job = _make_job()
    state = worker.WorkerState()
    state.current_job_id = job.id
    state.current_worker_id = "w"

    reached: list[bool] = []

    async def _exploding_mark_failed(
        _conn: Any,
        *,
        job_id: UUID,
        worker_id: str,
        error: str,
        error_class: str | None = None,
    ) -> None:
        reached.append(True)
        raise RuntimeError("mark_failed boom during shutdown")

    monkeypatch.setattr(worker, "mark_failed", _exploding_mark_failed)

    # Must return cleanly — no exception escapes. Asserting mark_failed was
    # actually reached proves the swallow fired on the mark_failed raise (not
    # on an earlier conn_factory failure) — and fails loudly if the except is
    # ever narrowed to a type that no longer catches RuntimeError.
    await worker._handle_shutdown(state, _conn_factory_stub)
    assert reached == [True]


# --- _default_handler ---


@pytest.mark.asyncio
async def test_default_handler_marks_failed_no_handler_wired(
    capture_mark_failed: list[_CapturedMarkFailed],
) -> None:
    """Unwired queue → explicit mark_failed (NOT a silent drop).

    Asserts the distinguishing properties, not just the message: error_class
    is None (operator-misconfig, not a taxonomic failure) and worker_id is the
    passed value.
    """
    job = _make_job()

    await worker._default_handler(
        job, conn_factory=_conn_factory_stub, worker_id="worker-test-3-dddd"
    )

    assert len(capture_mark_failed) == 1
    failed = capture_mark_failed[0]
    assert failed.job_id == job.id
    assert failed.worker_id == "worker-test-3-dddd"
    assert "no handler wired" in failed.error
    assert failed.error_class is None


# --- dispatch ---


@pytest.mark.asyncio
async def test_dispatch_known_queue_routes_to_registered_handler(
    capture_mark_failed: list[_CapturedMarkFailed],
) -> None:
    """A known queue_name routes to its registered handler, NOT _default_handler."""
    job = _make_job(queue_name="ingest")
    handled: list[Job] = []

    async def _registered(j: Job) -> None:
        handled.append(j)

    await worker.dispatch(
        job,
        registry={"ingest": _registered},
        conn_factory=_conn_factory_stub,
        worker_id="w",
    )

    assert handled == [job]
    # Registered handler ran → the default-fail path was NOT taken.
    assert capture_mark_failed == []


@pytest.mark.asyncio
async def test_dispatch_unknown_queue_routes_to_default_handler(
    capture_mark_failed: list[_CapturedMarkFailed],
) -> None:
    """Unknown queue_name → _default_handler (ADR-0019 §D6 invariant).

    Negative-assertion paired with the known-queue test above: if the
    fallback wiring were removed (``registry.get`` result used unguarded),
    dispatch would attempt to call ``None`` and raise TypeError rather than
    marking the job failed. Asserting the "no handler wired" mark_failed —
    AND that the registered ``ingest`` handler did NOT run — proves the
    unknown branch routed correctly.
    """
    job = _make_job(queue_name="nonexistent-queue")
    ingest_calls: list[Job] = []

    async def _registered(j: Job) -> None:
        ingest_calls.append(j)

    await worker.dispatch(
        job,
        registry={"ingest": _registered},
        conn_factory=_conn_factory_stub,
        worker_id="worker-test-4-eeee",
    )

    assert ingest_calls == []
    assert len(capture_mark_failed) == 1
    failed = capture_mark_failed[0]
    assert failed.job_id == job.id
    assert "no handler wired" in failed.error
