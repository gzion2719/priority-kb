"""ADR-0021 — registry + WorkerErrorClass enum stability tests.

The registry is the worker layer's dispatch mechanism (queue_name →
handler). The enum is the closed taxonomy backing
`mark_failed(error_class=...)`; new entries require ADR amendment.
"""

from __future__ import annotations

from collections.abc import Awaitable

import pytest

from api.handlers import HandlerFn, WorkerErrorClass, build_registry
from api.jobs import Job


def test_registry_keys_ingest_to_provided_handler() -> None:
    """build_registry maps `ingest` to the injected handler exactly once.

    Negative-assertion: an empty registry would silently route every
    ingest job to `_default_handler` — passing this test confirms the
    happy-path key wiring is live.
    """

    async def _stub(_job: Job) -> None:
        return None

    registry = build_registry(media_ingest_handler=_stub)
    assert set(registry.keys()) == {"ingest"}
    assert registry["ingest"] is _stub


def test_registry_lookup_returns_none_for_unknown_queue() -> None:
    """Unknown queue → None (worker falls back to _default_handler)."""

    async def _stub(_job: Job) -> None:
        return None

    registry = build_registry(media_ingest_handler=_stub)
    assert registry.get("unknown-queue") is None


@pytest.mark.asyncio
async def test_handler_fn_alias_accepts_async_callable() -> None:
    """HandlerFn alias permits an `async def` callable; mypy enforces.

    Awaiting the returned coroutine confirms call shape AND consumes the
    coroutine cleanly (no `coroutine was never awaited` warning).
    """

    async def _ok(_job: Job) -> None:
        return None

    fn: HandlerFn = _ok
    coro = fn(None)  # type: ignore[arg-type]
    assert isinstance(coro, Awaitable)
    await coro


# ----- WorkerErrorClass enum -----


def test_worker_error_class_values_are_stable_strings() -> None:
    """ADR-0021 §D8 — the enum is closed; this test pins the exact set so
    a rename/drop trips the gate before dashboards drift."""
    expected = {
        "parse_failed",
        "parse_empty_result",
        "unsupported_content_type",
        "blob_read_failed",
        "ingest_api_not_found",
        "ingest_api_4xx",
        "ingest_api_5xx",
        "ingest_api_timeout",
        "entry_metadata_not_found",
        "handler_crashed",
        # M2b #6 — ADR-0022 Amendment A1.
        "ocr_failed",
        "ocr_empty_result",
    }
    actual = {member.value for member in WorkerErrorClass}
    assert actual == expected, (
        f"WorkerErrorClass drift — gained {actual - expected} / lost {expected - actual}; "
        "any taxonomy change requires an ADR amendment per ADR-0021 §D8."
    )


def test_worker_error_class_str_serialization_matches_value() -> None:
    """StrEnum: str(member) == member.value — load-bearing for mark_failed
    which threads the .value string through to LogEventJob.error_class."""
    for member in WorkerErrorClass:
        assert str(member) == member.value


@pytest.mark.parametrize(
    "name",
    [
        "ParseFailed",
        "ParseEmpty",
        "UnsupportedContentType",
        "BlobReadFailed",
        "IngestApiNotFound",
        "IngestApi4xx",
        "IngestApi5xx",
        "IngestApiTimeout",
        "EntryMetadataNotFound",
        "HandlerCrashed",
        # M2b #6 — ADR-0022 Amendment A1.
        "OcrFailed",
        "OcrEmpty",
    ],
)
def test_worker_error_class_member_accessible_by_name(name: str) -> None:
    """Per-member access guard — catches renames in code that imports
    `WorkerErrorClass.X` directly (e.g., the handler's error mapping)."""
    member = getattr(WorkerErrorClass, name)
    assert isinstance(member, WorkerErrorClass)
