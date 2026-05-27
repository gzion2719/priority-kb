"""Tests for api.log_event — LogEvent emitter mirror of lib/log.ts.

Surface coverage mirrors lib/log.test.ts: runtime guards (latency, cost),
sink swap, JSON shape, serialization fallback, sink-error swallow, default-
ts injection, optional-field omission, dataclass immutability.

The runtime-guard tests are negative-assertion shaped per WORKFLOW.md
"Negative-assertion tests distinguish from the regression": the assertion
constructs a scenario where the guard's *absence* would produce a different
result, and asserts on the result that distinguishes the two worlds.
"""

from __future__ import annotations

import json
import math
import types
from collections.abc import Iterator
from dataclasses import FrozenInstanceError
from typing import Any

import pytest

from api import log_event as le


@pytest.fixture(autouse=True)
def _reset_sink() -> Iterator[None]:
    """Reset the module sink around each test so swaps don't leak."""
    yield
    le.reset_sink()


def _capture() -> tuple[list[str], le.Writer]:
    """Return (lines_list, sink_fn) pair for capturing emitted NDJSON lines."""
    captured: list[str] = []

    def sink(chunk: str) -> None:
        captured.append(chunk)

    return captured, sink


def _make_job_event(**overrides: object) -> le.LogEventJob:
    """Factory for a baseline valid LogEventJob; tests override single fields."""
    defaults: dict[str, object] = {
        "kind": "job",
        "queue_name": "ingest",
        "job_id": "00000000-0000-0000-0000-000000000001",
        "transition": "claimed",
        "latency_ms": 12.5,
        "cost_usd": None,
        "attempts": 1,
        "error_class": None,
        "status": "ok",
    }
    defaults.update(overrides)
    return le.LogEventJob(**defaults)  # type: ignore[arg-type]


# ----------------------------- shape + ts injection -----------------------------


def test_emit_writes_one_ndjson_line_with_trailing_newline() -> None:
    lines, sink = _capture()
    le.set_sink(sink)
    le.log_event(_make_job_event())
    assert len(lines) == 1
    assert lines[0].endswith("\n")
    assert lines[0].count("\n") == 1  # exactly one terminator, no embedded newlines


def test_emitted_line_is_valid_json_roundtrip() -> None:
    lines, sink = _capture()
    le.set_sink(sink)
    le.log_event(_make_job_event(queue_name="ocr", attempts=3, latency_ms=42.0))
    parsed = json.loads(lines[0])
    assert parsed["kind"] == "job"
    assert parsed["queue_name"] == "ocr"
    assert parsed["attempts"] == 3
    assert parsed["latency_ms"] == 42.0


def test_ts_is_injected_and_iso8601_utc() -> None:
    lines, sink = _capture()
    le.set_sink(sink)
    le.log_event(_make_job_event())
    parsed = json.loads(lines[0])
    assert "ts" in parsed
    # ISO8601 UTC: ends with "+00:00" since datetime.now(UTC).isoformat() emits it.
    assert parsed["ts"].endswith("+00:00")


def test_none_fields_are_omitted_from_payload() -> None:
    """Optional fields with value None are dropped, mirroring TS optional-field
    JSON.stringify semantics where ``undefined`` is omitted (not ``null``).

    Negative-assertion shape: if the omit-None logic were dropped, ``cost_usd``
    + ``error_class`` would appear in the payload as ``null``; the assertion
    confirms they are absent, which only the omit logic produces.
    """
    lines, sink = _capture()
    le.set_sink(sink)
    le.log_event(_make_job_event(cost_usd=None, error_class=None, attempts=None))
    parsed = json.loads(lines[0])
    assert "cost_usd" not in parsed
    assert "error_class" not in parsed
    assert "attempts" not in parsed


def test_present_optional_fields_survive_serialization() -> None:
    """Inverse of the above: when optionals carry values, they appear in payload."""
    lines, sink = _capture()
    le.set_sink(sink)
    le.log_event(_make_job_event(attempts=2, error_class="OcrTimeout"))
    parsed = json.loads(lines[0])
    assert parsed["attempts"] == 2
    assert parsed["error_class"] == "OcrTimeout"


# ----------------------------- runtime guards -----------------------------


def test_latency_negative_raises_typeerror() -> None:
    """Negative-assertion: a guard's absence would emit the line; presence raises.

    The test asserts on the RAISE (which only the guard produces), not on
    "no line was emitted" (which both guard and a silent-drop would satisfy).
    """
    lines, sink = _capture()
    le.set_sink(sink)
    with pytest.raises(TypeError, match="latency_ms"):
        le.log_event(_make_job_event(latency_ms=-1.0))
    assert lines == []  # No emission on guard-raised event


def test_latency_nan_raises_typeerror() -> None:
    with pytest.raises(TypeError, match="latency_ms"):
        le.log_event(_make_job_event(latency_ms=math.nan))


def test_latency_positive_infinity_raises_typeerror() -> None:
    with pytest.raises(TypeError, match="latency_ms"):
        le.log_event(_make_job_event(latency_ms=math.inf))


def test_latency_negative_infinity_raises_typeerror() -> None:
    with pytest.raises(TypeError, match="latency_ms"):
        le.log_event(_make_job_event(latency_ms=-math.inf))


def test_latency_non_numeric_raises_typeerror() -> None:
    with pytest.raises(TypeError, match="latency_ms"):
        le.log_event(_make_job_event(latency_ms="12.5"))


def test_latency_zero_is_allowed() -> None:
    """Zero is finite and non-negative; the guard permits it."""
    lines, sink = _capture()
    le.set_sink(sink)
    le.log_event(_make_job_event(latency_ms=0.0))
    assert len(lines) == 1
    assert json.loads(lines[0])["latency_ms"] == 0.0


def test_cost_non_numeric_raises_typeerror() -> None:
    with pytest.raises(TypeError, match="cost_usd"):
        le.log_event(_make_job_event(cost_usd="free"))


def test_cost_boolean_raises_typeerror() -> None:
    """Booleans are int subclasses in Python; the guard explicitly rejects them.

    Negative-assertion shape: without the ``isinstance(..., bool)`` carve-out,
    ``True`` would pass the ``isinstance(..., (int, float))`` check and the
    line would emit with ``cost_usd: true`` — which is a bug worth surfacing.
    """
    with pytest.raises(TypeError, match="cost_usd"):
        le.log_event(_make_job_event(cost_usd=True))


def test_cost_none_is_allowed() -> None:
    lines, sink = _capture()
    le.set_sink(sink)
    le.log_event(_make_job_event(cost_usd=None))
    assert len(lines) == 1


def test_cost_finite_number_is_allowed() -> None:
    """A non-None cost (when vendor variants ship) survives the guard."""
    lines, sink = _capture()
    le.set_sink(sink)
    le.log_event(_make_job_event(cost_usd=0.0001))
    assert len(lines) == 1
    assert json.loads(lines[0])["cost_usd"] == 0.0001


# ----------------------------- sink swap + reset -----------------------------


def test_set_sink_routes_emit_to_new_writer() -> None:
    lines, sink = _capture()
    le.set_sink(sink)
    le.log_event(_make_job_event())
    assert len(lines) == 1


def test_reset_sink_restores_default(capsys: pytest.CaptureFixture[str]) -> None:
    """After reset_sink, emission flows back to sys.stdout (capsys captures).

    Negative-assertion: if reset didn't actually restore _sink, the previously-
    set capture sink would still be active and the captured stdout would be
    empty. The assertion proves stdout received the line — only the reset path
    produces this.
    """
    sentinel: list[str] = []
    le.set_sink(lambda c: sentinel.append(c))
    le.reset_sink()
    le.log_event(_make_job_event(queue_name="resettest"))
    captured = capsys.readouterr()
    assert "resettest" in captured.out
    assert sentinel == []  # The pre-reset sink received nothing post-reset


# ----------------------------- sink-error swallow -----------------------------


def test_sink_exception_is_swallowed_silently() -> None:
    """Sink raising MUST NOT raise out of log_event (observability MUST NOT
    break the API call path).

    Negative-assertion: if the try/except around the sink call were dropped,
    this test would raise RuntimeError; instead it completes normally.
    """

    def bad_sink(_chunk: str) -> None:
        raise RuntimeError("simulated sink failure (e.g., broken pipe)")

    le.set_sink(bad_sink)
    # Must not raise.
    le.log_event(_make_job_event())


def test_sink_keyerror_is_swallowed_silently() -> None:
    """Cover a different exception class to confirm the catch is not raise-class-specific."""

    def bad_sink(_chunk: str) -> None:
        raise KeyError("simulated sink dict mutation race")

    le.set_sink(bad_sink)
    le.log_event(_make_job_event())


# ----------------------------- serialization fallback -----------------------------


def test_serialization_failure_falls_back_to_minimal_error_line(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If json.dumps raises on the payload, log_event emits a degraded line
    carrying kind + an explicit ``log serialization failed`` marker.

    Construction: monkey-patch json.dumps to raise on the first call (the
    payload dump) but not on the second (the fallback dump). This proves the
    fallback is the path actually exercised on serialization failure, not the
    sink-error swallow (which is a different defense).
    """
    lines, sink = _capture()
    le.set_sink(sink)

    original_dumps = json.dumps
    call_count = {"n": 0}

    def flaky_dumps(*args: Any, **kwargs: Any) -> str:
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise TypeError("simulated unserializable payload value")
        return original_dumps(*args, **kwargs)

    # Swap api.log_event's bound ``json`` for a SimpleNamespace shim
    # exposing only ``dumps``. The module's first dumps call raises (forcing
    # the fallback branch); the second dumps call (inside the fallback)
    # succeeds via the closure's ``original_dumps`` reference. monkeypatch
    # restores the attribute on teardown; string-target form bypasses
    # mypy's not-explicitly-exported attribute complaint.
    monkeypatch.setattr("api.log_event.json", types.SimpleNamespace(dumps=flaky_dumps))
    le.log_event(_make_job_event())

    assert len(lines) == 1
    parsed = json.loads(lines[0])
    assert parsed["kind"] == "job"
    assert parsed["status"] == "error"
    assert parsed["error"] == "log serialization failed"
    # Confirm the fallback branch invoked dumps a second time — without
    # this assertion the test could pass for the wrong reason (e.g., if a
    # future refactor moved the degraded-line construction out of the
    # except block). code-CR m2, 2026-05-27.
    assert call_count["n"] == 2


# ----------------------------- dataclass immutability -----------------------------


def test_log_event_job_is_frozen() -> None:
    """Frozen-dataclass posture: an emitted event cannot be mutated post-construction.

    Negative-assertion: without ``frozen=True``, assigning to a field would
    succeed silently and a downstream consumer could mutate the event between
    audit-write and dashboard-emit. The assertion proves mutation raises.
    """
    event = _make_job_event()
    with pytest.raises(FrozenInstanceError):
        event.transition = "done"  # type: ignore[misc]


def test_emit_does_not_leak_kind_field_typing() -> None:
    """The ``kind`` field always emits as the literal ``"job"`` string —
    no Python type-coercion smuggling.
    """
    lines, sink = _capture()
    le.set_sink(sink)
    le.log_event(_make_job_event())
    parsed = json.loads(lines[0])
    assert parsed["kind"] == "job"
    assert isinstance(parsed["kind"], str)
