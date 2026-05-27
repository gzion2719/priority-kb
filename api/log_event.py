"""Structured JSON LogEvent emitter for the Python worker.

Mirrors ``lib/log.ts`` ``logEvent``. Emits one NDJSON line per call event to
the module-level sink (default: ``sys.stdout``). The wire format is locked in
[ADR-0005](../docs/adr/0005-log-event-schema.md); the Python emitter ships the
``LogEventJob`` variant first per [ADR-0020](../docs/adr/0020-python-log-event-emitter.md),
with vendor variants (Voyage, Claude, RetrievalPipeline, Route) landing
alongside their first Python call site at M2b #5/#6/#7.

Distinct from ``api.log`` (application runtime logger per ADR-0018). That
module writes free-form messages with caller-controlled ``extra={}``; this
module writes typed structured records with mandatory fields.

Sink contract: ``log_event`` is synchronous-write-by-contract — the sink is
called exactly once per invocation with one NDJSON-terminated line. Sink
errors are caught and swallowed: **observability MUST NEVER break the API
call path** (mirrors lib/log.ts:493-496). A serialization failure (e.g. a
non-JSON-encodable value smuggled through ``dataclasses.asdict``) degrades to
the minimal ``{"ts":..,"kind":..,"status":"error","error":"log serialization
failed"}`` line (mirrors lib/log.ts:480-490).

Runtime guards (pre-emission, fail-loudly):
- ``latency_ms`` must be a finite non-negative number; NaN, ±Infinity, or
  negative values raise ``TypeError``.
- ``cost_usd`` must be ``None`` or a number; anything else raises
  ``TypeError``.

These guards mirror lib/log.ts:450-459 — the caller bug at the type level is
fail-loudly, the sink error at the I/O level is swallow-silently.

Variant scope (per ADR-0020 §D3): ``LogEvent`` today is an alias for
``LogEventJob``. When M2b #5/#6/#7 wires the first Voyage embedding call, the
alias widens to ``LogEventJob | LogEventVoyage`` and that PR ports the
``redactSecrets`` regex set from lib/log.ts:347-360. Until then, no
redaction primitive lives here — ``LogEventJob`` declares ``error?: never``
on the Node side and the Python mirror has no free-text caller field to
redact.
"""

from __future__ import annotations

import contextlib
import json
import math
import sys
from collections.abc import Callable
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Literal

JobTransition = Literal["enqueued", "claimed", "done", "failed", "dead"]


@dataclass(frozen=True)
class LogEventJob:
    """Job-queue state-transition event mirror of ``lib/log.ts:289-335``.

    Field set is byte-equivalent to the TypeScript ``LogEventJob`` interface;
    SESSION_PROTOCOL.md ``py-internal-type-grep`` is the author-side discipline
    floor backing the cross-language alignment (ADR-0020 §D9).

    Frozen so an emitted event can't be mutated by subsequent code; matches
    the immutable-record posture of the Node interface (which is read-only by
    construction via TypeScript's structural typing).

    Fields:
        kind: Always ``"job"``. Discriminator for the LogEvent union.
        queue_name: Logical queue name — ``"ingest"``, ``"ocr"``, etc.
            Matches ``jobs.queue_name``.
        job_id: UUID of the row in the ``jobs`` table, as a string.
        transition: State-machine transition. ``"failed"`` is the
            non-terminal bump-attempts step; ``"dead"`` is the terminal
            max-attempts promotion (audit_log row shapes differ —
            ``job_failed`` vs ``job_dead``).
        latency_ms: Finite non-negative float. Measures wall-time from
            the calling function's entry to the post-commit observability
            tee — i.e., the UPDATE + audit INSERT + ``conn.commit()``
            roundtrip plus any Python overhead. NOT a pure commit-only
            measurement; the broader "transition phase" reading is the
            useful one for dashboards correlating slow transitions.
            (M1 from 2026-05-27 code-CR — docstring tightened.)
        cost_usd: Always ``None`` for this variant — no vendor invoked, no
            cost. Field is present so the runtime cost-type guard permits
            the line uniformly across variants (when vendor variants ship,
            the guard fires the same way).
        attempts: Current ``jobs.attempts`` value after the transition
            committed. Optional — omitted from the NDJSON line when ``None``.
        error_class: Short class/category label (e.g. ``"OcrTimeout"``,
            ``"NetworkError"``). Per ADR-0020 §D8, ``None`` at all M2b #3
            transition sites — the taxonomy lands when M2b #5/#6/#7 ships
            the first OCR handler. **Caller-controlled stable label, NOT
            free-text** — the Node JSDoc at lib/log.ts:305-310 names this
            invariant explicitly.
        status: ``"ok"`` for successful transitions, ``"error"`` for the
            failed/dead transitions. Optional.
    """

    kind: Literal["job"]
    queue_name: str
    job_id: str
    transition: JobTransition
    latency_ms: float
    cost_usd: float | None
    attempts: int | None = None
    error_class: str | None = None
    status: Literal["ok", "error"] | None = None


# Variant alias — widens at M2b #5+ first Python vendor call site per
# ADR-0020 §D3. Caller signatures using ``LogEvent`` stay stable across the
# widening; existing test mocks continue to work. PEP 695 ``type`` keyword
# makes the intent (alias, not variable reassignment) explicit to readers
# and to mypy (code-CR m5, 2026-05-27; ruff UP040 prefers PEP 695 over
# PEP 613 ``TypeAlias`` under Python 3.12+).
type LogEvent = LogEventJob


Writer = Callable[[str], None]


def _default_sink(chunk: str) -> None:
    """Default sink: one ``sys.stdout.write`` call.

    Mirrors lib/log.ts:362-368. The trailing newline is included in
    ``chunk`` by ``log_event``; the sink does not append one.
    """
    sys.stdout.write(chunk)


_sink: Writer = _default_sink


def set_sink(fn: Writer) -> None:
    """Swap the log sink. Intended for tests; production code uses the default.

    Mirrors lib/log.ts:374-376. Pair every ``set_sink`` with a
    ``reset_sink`` in test teardown to avoid leaking the swap into sibling
    tests.
    """
    global _sink
    _sink = fn


def reset_sink() -> None:
    """Restore the default sink (writes one NDJSON line to ``sys.stdout``).

    Mirrors lib/log.ts:379-381.
    """
    global _sink
    _sink = _default_sink


def _validate_latency(latency_ms: float) -> None:
    """Pre-emission guard: latency must be finite non-negative.

    Mirrors lib/log.ts:450-454. NaN, ±Infinity, and negative values raise
    ``TypeError`` so the caller bug surfaces loudly at the call site
    rather than as a malformed dashboard record downstream.
    """
    if not isinstance(latency_ms, (int, float)) or isinstance(latency_ms, bool):
        raise TypeError(
            f"log_event: latency_ms must be a finite non-negative number, "
            f"got {type(latency_ms).__name__}",
        )
    if math.isnan(latency_ms) or math.isinf(latency_ms) or latency_ms < 0:
        raise TypeError(
            f"log_event: latency_ms must be a finite non-negative number, got {latency_ms!r}",
        )


def _validate_cost(cost_usd: float | None) -> None:
    """Pre-emission guard: cost must be None or a number.

    Mirrors lib/log.ts:455-459. Booleans are explicitly excluded — ``True``
    and ``False`` are technically ``int`` subclasses in Python, and a caller
    smuggling a boolean cost is a bug worth surfacing.
    """
    if cost_usd is None:
        return
    if isinstance(cost_usd, bool) or not isinstance(cost_usd, (int, float)):
        raise TypeError(
            f"log_event: cost_usd must be a number or None, got {type(cost_usd).__name__}",
        )


def _now_iso() -> str:
    """Module-injected timestamp; matches lib/log.ts:464 ``new Date().toISOString()``.

    The helper-injected timestamp is the only ``ts`` value emitted — the
    LogEventJob dataclass has no ``ts`` field, so callers cannot supply one
    (mirrors the TypeScript ``ts?: never`` ban on caller-supplied
    timestamps at lib/log.ts:88-91).
    """
    return datetime.now(UTC).isoformat()


def log_event(event: LogEvent) -> None:
    """Emit one structured-JSON log line for a LogEvent.

    Pre-emission guards (raise on caller bug):
        - ``latency_ms`` must be a finite non-negative number.
        - ``cost_usd`` must be None or a number.

    Post-emission behavior (swallow on I/O bug):
        - Sink exceptions are caught silently — observability MUST NEVER
          break the API path.
        - Serialization failures degrade to a minimal error line; the
          attempted ``kind`` and a ``"log serialization failed"`` marker
          land instead of dropping the line entirely.

    Raises:
        TypeError: when ``latency_ms`` is not finite non-negative, or
            ``cost_usd`` is neither ``None`` nor a number.
    """
    _validate_latency(event.latency_ms)
    _validate_cost(event.cost_usd)

    # Spread event first, ``ts`` last → helper-injected timestamp always
    # wins over any caller-supplied value (which the dataclass schema
    # doesn't permit anyway, but the explicit ordering matches lib/log.ts:
    # 462-465 and documents the precedence).
    payload: dict[str, object] = {**asdict(event), "ts": _now_iso()}

    # Drop fields whose value is None to keep the NDJSON line equivalent
    # to the TS variant where optional fields are absent (not ``null``)
    # when unset. Mirrors the JSON.stringify behavior on optional fields
    # in lib/log.ts where ``foo: undefined`` is omitted entirely.
    payload = {k: v for k, v in payload.items() if v is not None}

    try:
        line = json.dumps(payload, ensure_ascii=False) + "\n"
    except (TypeError, ValueError):
        # Serialization failure fallback — mirrors lib/log.ts:480-490.
        # Emit a degraded line carrying the kind + error marker so
        # dashboards see the failure rather than dropping the event.
        line = (
            json.dumps(
                {
                    "ts": _now_iso(),
                    "kind": event.kind,
                    "status": "error",
                    "error": "log serialization failed",
                },
                ensure_ascii=False,
            )
            + "\n"
        )

    # Observability MUST NEVER break the API call path (mirrors
    # lib/log.ts:493-496). Any sink-side exception — file descriptor
    # closed, broken pipe, custom test sink raising — is swallowed
    # silently. ``contextlib.suppress(Exception)`` is the ruff-preferred
    # shape (SIM105); the wide net is deliberate and matches the
    # Node-side swallow contract on every sink invocation.
    with contextlib.suppress(Exception):
        _sink(line)
