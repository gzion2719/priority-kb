"""ADR-0021 M2b #5 — media_ingest handler branch tests.

Covers every terminal branch of `api.handlers.media_ingest._handle`:
parser success, parser failure, parser empty, unsupported content type,
blob read failure, entry-metadata not found, HTTP 2xx/4xx/5xx/404/timeout,
and the top-level except → HandlerCrashed.

Stubs at the seams (per ADR-0021 §"Verification"):
    - `conn_factory` returns an async-context-manager whose connection
      is itself a stub — none of the real DB primitives run.
    - `mark_done` / `mark_failed` are monkeypatched on the module so we
      capture the arguments the handler would have written to the DB.
    - `get_entry_metadata` is monkeypatched on the module so we don't
      need a real Postgres for unit coverage.
    - `httpx.AsyncClient` is replaced with a stub that returns
      controllable Response objects (or raises the targeted exception).

Iron-rule footprint (test surface):
    #8 — no live API imports here.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock
from uuid import UUID, uuid4

import httpx
import pytest

from api.entries import EntryMetadata
from api.handlers import media_ingest as media_ingest_module
from api.handlers.types import WorkerErrorClass
from api.jobs import Job

# --- shared fixtures ---


def _make_job(payload: dict[str, Any]) -> Job:
    """Construct a minimal Job with caller-controlled payload.

    All non-payload fields are filled with deterministic placeholders;
    none of them are read by the handler's branches under test.
    """
    return Job(
        id=uuid4(),
        queue_name="ingest",
        payload=payload,
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
    """Async-context-manager stub for the connection returned by conn_factory.

    The handler's flow uses `async with await conn_factory() as conn:`.
    The real psycopg connection is async-context-aware itself; this stub
    matches the shape without needing the driver.
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


@dataclass
class _CapturedMarkDone:
    job_id: UUID
    worker_id: str


@pytest.fixture
def capture_marks(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[Any]]:
    """Replace mark_done / mark_failed with capturing AsyncMocks."""
    failed_calls: list[_CapturedMarkFailed] = []
    done_calls: list[_CapturedMarkDone] = []

    async def _fake_mark_failed(
        _conn: Any,
        *,
        job_id: UUID,
        worker_id: str,
        error: str,
        error_class: str | None = None,
    ) -> None:
        failed_calls.append(
            _CapturedMarkFailed(
                job_id=job_id, worker_id=worker_id, error=error, error_class=error_class
            )
        )

    async def _fake_mark_done(_conn: Any, *, job_id: UUID, worker_id: str) -> None:
        done_calls.append(_CapturedMarkDone(job_id=job_id, worker_id=worker_id))

    monkeypatch.setattr(media_ingest_module, "mark_failed", _fake_mark_failed)
    monkeypatch.setattr(media_ingest_module, "mark_done", _fake_mark_done)
    return {"failed": failed_calls, "done": done_calls}


@pytest.fixture
def patch_metadata_found(monkeypatch: pytest.MonkeyPatch) -> EntryMetadata:
    """Default: get_entry_metadata returns a populated EntryMetadata."""
    md = EntryMetadata(
        title="Original Title",
        category="validation",
        tags=["po", "vendor"],
        body="placeholder body",
        source_pointer="ticket://1234",
        last_verified_at=datetime(2026, 5, 1, 10, 0, tzinfo=UTC),
        sensitivity="internal",
    )

    async def _fake_get(_conn: Any, *, entry_id: UUID) -> EntryMetadata:
        return md

    monkeypatch.setattr(media_ingest_module, "get_entry_metadata", _fake_get)
    return md


@pytest.fixture
def patch_metadata_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _fake_get(_conn: Any, *, entry_id: UUID) -> None:
        return None

    monkeypatch.setattr(media_ingest_module, "get_entry_metadata", _fake_get)


def _stub_http_client(
    *, response: httpx.Response | None = None, raises: Exception | None = None
) -> AsyncMock:
    """Build an AsyncMock pretending to be httpx.AsyncClient."""
    client = AsyncMock(spec=httpx.AsyncClient)
    if raises is not None:
        client.put.side_effect = raises
    else:
        assert response is not None
        client.put.return_value = response
    return client


# --- tests ---


@pytest.mark.asyncio
async def test_pdf_happy_path_marks_done_and_puts_full_body(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    """PDF upload → parser succeeds → SELECT metadata → PUT 200 → mark_done."""
    blob_rel = "deadbeef/sample.pdf"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes((Path(__file__).parent / "fixtures" / "sample.pdf").read_bytes())

    entry_id = uuid4()
    job = _make_job(
        {
            "entry_id": str(entry_id),
            "content_type": "application/pdf",
            "blob_storage_path": blob_rel,
            "original_filename": "sample.pdf",
            "byte_length": blob_full.stat().st_size,
        }
    )

    response = httpx.Response(
        200,
        json={"id": str(entry_id), "version_no": 2, "chunk_count": 1},
        request=httpx.Request("PUT", f"http://node/api/ingest/{entry_id}"),
    )
    http_client = _stub_http_client(response=response)

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="worker-test-0-aaaa",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
    )

    assert len(capture_marks["done"]) == 1
    assert capture_marks["done"][0].job_id == job.id
    assert capture_marks["failed"] == []

    # PUT body shape — `sensitivity` omitted per ADR-0021 §D4; metadata
    # propagated; parsed body sent (not the placeholder).
    http_client.put.assert_awaited_once()
    call_kwargs = http_client.put.await_args.kwargs
    body = call_kwargs["json"]
    assert "sensitivity" not in body, "sensitivity must be omitted from PUT body (ADR-0021 §D4)"
    assert body["title"] == patch_metadata_found.title
    assert body["category"] == patch_metadata_found.category
    assert body["tags"] == patch_metadata_found.tags
    assert "Page one content" in body["body"]
    headers = call_kwargs["headers"]
    assert headers["x-stub-user-role"] == "admin"
    assert headers["x-worker-id"] == "worker-test-0-aaaa"
    assert headers["x-worker-job-id"] == str(job.id)


@pytest.mark.asyncio
async def test_docx_happy_path_marks_done(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    """DOCX upload → parser succeeds → PUT 200 → mark_done."""
    blob_rel = "abc123/sample.docx"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes((Path(__file__).parent / "fixtures" / "sample.docx").read_bytes())

    entry_id = uuid4()
    job = _make_job(
        {
            "entry_id": str(entry_id),
            "content_type": (
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ),
            "blob_storage_path": blob_rel,
            "original_filename": "sample.docx",
            "byte_length": blob_full.stat().st_size,
        }
    )

    response = httpx.Response(
        200,
        json={"id": str(entry_id), "version_no": 2, "chunk_count": 1},
        request=httpx.Request("PUT", f"http://node/api/ingest/{entry_id}"),
    )
    http_client = _stub_http_client(response=response)

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="worker-test-0-aaaa",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
    )

    assert len(capture_marks["done"]) == 1
    body = http_client.put.await_args.kwargs["json"]
    assert "First paragraph English" in body["body"]


@pytest.mark.asyncio
async def test_unsupported_content_type_marks_failed_without_http_call(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    """image/png (M2b #6 territory) → UnsupportedContentType, no parser run, no HTTP."""
    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "image/png",
            "blob_storage_path": "ignored/path.png",
            "original_filename": "x.png",
            "byte_length": 0,
        }
    )
    http_client = _stub_http_client(response=httpx.Response(200))

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
    )

    assert capture_marks["done"] == []
    assert len(capture_marks["failed"]) == 1
    failed = capture_marks["failed"][0]
    assert failed.error_class == WorkerErrorClass.UnsupportedContentType.value
    http_client.put.assert_not_called()


@pytest.mark.asyncio
async def test_corrupt_pdf_bytes_map_to_parse_failed(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    """ParserError("corrupt") from parse_pdf → ParseFailed, no HTTP."""
    blob_rel = "bad/sample.pdf"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes(b"not actually a pdf")

    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "application/pdf",
            "blob_storage_path": blob_rel,
            "original_filename": "sample.pdf",
            "byte_length": blob_full.stat().st_size,
        }
    )
    http_client = _stub_http_client(response=httpx.Response(200))

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
    )

    assert len(capture_marks["failed"]) == 1
    assert capture_marks["failed"][0].error_class == WorkerErrorClass.ParseFailed.value
    http_client.put.assert_not_called()


@pytest.mark.asyncio
async def test_empty_parse_result_maps_to_parse_empty(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    """Blank-page PDF (parser returns whitespace-only) → ParseEmpty."""
    blob_rel = "empty/sample-empty.pdf"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes((Path(__file__).parent / "fixtures" / "sample-empty.pdf").read_bytes())

    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "application/pdf",
            "blob_storage_path": blob_rel,
            "original_filename": "sample-empty.pdf",
            "byte_length": blob_full.stat().st_size,
        }
    )
    http_client = _stub_http_client(response=httpx.Response(200))

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
    )

    assert len(capture_marks["failed"]) == 1
    assert capture_marks["failed"][0].error_class == WorkerErrorClass.ParseEmpty.value
    http_client.put.assert_not_called()


@pytest.mark.asyncio
async def test_blob_read_failure_maps_to_blob_read_failed(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    """Missing file on disk → BlobReadFailed (NOT HandlerCrashed)."""
    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "application/pdf",
            "blob_storage_path": "missing/does-not-exist.pdf",
            "original_filename": "x.pdf",
            "byte_length": 0,
        }
    )
    http_client = _stub_http_client(response=httpx.Response(200))

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
    )

    assert len(capture_marks["failed"]) == 1
    assert capture_marks["failed"][0].error_class == WorkerErrorClass.BlobReadFailed.value
    http_client.put.assert_not_called()


@pytest.mark.asyncio
async def test_entry_metadata_missing_maps_to_entry_metadata_not_found(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_missing: None,
) -> None:
    """get_entry_metadata returns None → EntryMetadataNotFound, no HTTP."""
    blob_rel = "ok/sample.pdf"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes((Path(__file__).parent / "fixtures" / "sample.pdf").read_bytes())

    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "application/pdf",
            "blob_storage_path": blob_rel,
            "original_filename": "sample.pdf",
            "byte_length": blob_full.stat().st_size,
        }
    )
    http_client = _stub_http_client(response=httpx.Response(200))

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
    )

    assert len(capture_marks["failed"]) == 1
    assert capture_marks["failed"][0].error_class == WorkerErrorClass.EntryMetadataNotFound.value
    http_client.put.assert_not_called()


@pytest.mark.asyncio
async def test_http_404_maps_to_ingest_api_not_found(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    blob_rel = "ok/sample.pdf"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes((Path(__file__).parent / "fixtures" / "sample.pdf").read_bytes())

    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "application/pdf",
            "blob_storage_path": blob_rel,
            "original_filename": "sample.pdf",
            "byte_length": blob_full.stat().st_size,
        }
    )
    response = httpx.Response(
        404, text="not found", request=httpx.Request("PUT", "http://node/api/ingest/x")
    )
    http_client = _stub_http_client(response=response)

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
    )

    assert len(capture_marks["failed"]) == 1
    assert capture_marks["failed"][0].error_class == WorkerErrorClass.IngestApiNotFound.value


@pytest.mark.asyncio
async def test_http_4xx_other_maps_to_ingest_api_4xx(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    """422 (validation error) → IngestApi4xx (distinct from 404)."""
    blob_rel = "ok/sample.pdf"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes((Path(__file__).parent / "fixtures" / "sample.pdf").read_bytes())

    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "application/pdf",
            "blob_storage_path": blob_rel,
            "original_filename": "sample.pdf",
            "byte_length": blob_full.stat().st_size,
        }
    )
    response = httpx.Response(
        422, text="invalid", request=httpx.Request("PUT", "http://node/api/ingest/x")
    )
    http_client = _stub_http_client(response=response)

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
    )

    assert len(capture_marks["failed"]) == 1
    assert capture_marks["failed"][0].error_class == WorkerErrorClass.IngestApi4xx.value


@pytest.mark.asyncio
async def test_http_5xx_maps_to_ingest_api_5xx(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    blob_rel = "ok/sample.pdf"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes((Path(__file__).parent / "fixtures" / "sample.pdf").read_bytes())

    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "application/pdf",
            "blob_storage_path": blob_rel,
            "original_filename": "sample.pdf",
            "byte_length": blob_full.stat().st_size,
        }
    )
    response = httpx.Response(
        503, text="busy", request=httpx.Request("PUT", "http://node/api/ingest/x")
    )
    http_client = _stub_http_client(response=response)

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
    )

    assert len(capture_marks["failed"]) == 1
    assert capture_marks["failed"][0].error_class == WorkerErrorClass.IngestApi5xx.value


@pytest.mark.asyncio
async def test_http_timeout_maps_to_ingest_api_timeout(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    blob_rel = "ok/sample.pdf"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes((Path(__file__).parent / "fixtures" / "sample.pdf").read_bytes())

    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "application/pdf",
            "blob_storage_path": blob_rel,
            "original_filename": "sample.pdf",
            "byte_length": blob_full.stat().st_size,
        }
    )
    http_client = _stub_http_client(raises=httpx.TimeoutException("read timeout"))

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
    )

    assert len(capture_marks["failed"]) == 1
    assert capture_marks["failed"][0].error_class == WorkerErrorClass.IngestApiTimeout.value


@pytest.mark.asyncio
async def test_payload_missing_required_field_maps_to_handler_crashed(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    """Job payload missing `entry_id` → HandlerCrashed via the early guard,
    NOT propagated as a bare KeyError that escapes the handler."""
    job = _make_job(
        {
            # missing entry_id
            "content_type": "application/pdf",
            "blob_storage_path": "x/y.pdf",
        }
    )
    http_client = _stub_http_client(response=httpx.Response(200))

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
    )

    assert len(capture_marks["failed"]) == 1
    assert capture_marks["failed"][0].error_class == WorkerErrorClass.HandlerCrashed.value


@pytest.mark.asyncio
async def test_unexpected_exception_in_run_caught_by_top_level_except(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A non-ParserError exception inside _run lands on the top-level
    `except Exception` → HandlerCrashed; no exception escapes _handle."""

    async def _exploding_metadata(_conn: Any, *, entry_id: UUID) -> EntryMetadata:
        raise RuntimeError("simulated DB driver crash")

    monkeypatch.setattr(media_ingest_module, "get_entry_metadata", _exploding_metadata)

    blob_rel = "ok/sample.pdf"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes((Path(__file__).parent / "fixtures" / "sample.pdf").read_bytes())

    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "application/pdf",
            "blob_storage_path": blob_rel,
            "original_filename": "sample.pdf",
            "byte_length": blob_full.stat().st_size,
        }
    )
    http_client = _stub_http_client(response=httpx.Response(200))

    # If the top-level except were removed, this would raise RuntimeError
    # — distinguishes the gate from a vacuous pass.
    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
    )

    assert len(capture_marks["failed"]) == 1
    assert capture_marks["failed"][0].error_class == WorkerErrorClass.HandlerCrashed.value


@pytest.mark.asyncio
async def test_payload_with_malformed_entry_id_uuid_maps_to_handler_crashed(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    """Code-CR B2 (2026-05-27): a malformed entry_id (non-UUID string)
    must be caught by the explicit guard, NOT escape as a bare
    ValueError. error_class is HandlerCrashed (no new enum value per
    ADR-0021 §D8 closed-enum contract); error message starts with
    `malformed_entry_id_uuid` so dashboards can distinguish."""
    job = _make_job(
        {
            "entry_id": "definitely-not-a-uuid",
            "content_type": "application/pdf",
            "blob_storage_path": "x/y.pdf",
        }
    )
    http_client = _stub_http_client(response=httpx.Response(200))

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
    )

    assert len(capture_marks["failed"]) == 1
    failed = capture_marks["failed"][0]
    assert failed.error_class == WorkerErrorClass.HandlerCrashed.value
    assert failed.error.startswith("malformed_entry_id_uuid")


@pytest.mark.asyncio
async def test_cleanup_mark_failed_crash_does_not_propagate_from_handle(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Code-CR M4 (2026-05-27): if the top-level safety-net's mark_failed
    ALSO crashes (broken conn_factory, DB unreachable, etc.), the
    exception must NOT escape `_handle` — that would kill the worker's
    poll loop. The visibility-timeout reclaim handles the orphaned job.

    Negative-assertion: if the inner try/except in `_handle` were
    removed, the cleanup RuntimeError would propagate and this test
    would fail with an unhandled exception escaping `await _handle(...)`.
    """

    async def _exploding_metadata(_conn: Any, *, entry_id: UUID) -> EntryMetadata:
        raise RuntimeError("simulated DB driver crash in handler body")

    async def _exploding_conn_factory() -> _StubConn:
        # Force cleanup mark_failed to also fail at the conn-acquisition step.
        raise RuntimeError("simulated DB unreachable during cleanup")

    monkeypatch.setattr(media_ingest_module, "get_entry_metadata", _exploding_metadata)

    blob_rel = "ok/sample.pdf"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes((Path(__file__).parent / "fixtures" / "sample.pdf").read_bytes())

    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "application/pdf",
            "blob_storage_path": blob_rel,
            "original_filename": "sample.pdf",
            "byte_length": blob_full.stat().st_size,
        }
    )
    http_client = _stub_http_client(response=httpx.Response(200))

    # Must NOT raise — _handle's inner try/except swallows the cleanup error.
    await media_ingest_module._handle(
        job,
        conn_factory=_exploding_conn_factory,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
    )
    # No assertions on mark_done/mark_failed — both DB paths failed by
    # design. The test passes by virtue of `await _handle(...)` returning
    # cleanly instead of raising.


@pytest.mark.asyncio
async def test_uppercase_content_type_routes_to_parser_via_case_fold(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    """Code-CR m5 (2026-05-27): `_PARSERS` dict keys are lowercase;
    lookup case-folds defensively. Sending `Application/PDF` must
    still route to parse_pdf, not silently UnsupportedContentType."""
    blob_rel = "ok/sample.pdf"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes((Path(__file__).parent / "fixtures" / "sample.pdf").read_bytes())

    entry_id = uuid4()
    job = _make_job(
        {
            "entry_id": str(entry_id),
            "content_type": "Application/PDF",
            "blob_storage_path": blob_rel,
            "original_filename": "sample.pdf",
            "byte_length": blob_full.stat().st_size,
        }
    )
    response = httpx.Response(
        200,
        json={"id": str(entry_id), "version_no": 2, "chunk_count": 1},
        request=httpx.Request("PUT", f"http://node/api/ingest/{entry_id}"),
    )
    http_client = _stub_http_client(response=response)

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
    )

    assert len(capture_marks["done"]) == 1
    assert capture_marks["failed"] == []


@pytest.mark.asyncio
async def test_resolve_blob_root_raises_when_env_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BLOB_STORAGE_DIR", raising=False)
    with pytest.raises(RuntimeError, match="BLOB_STORAGE_DIR"):
        media_ingest_module.resolve_blob_root()


@pytest.mark.asyncio
async def test_resolve_ingest_api_base_url_raises_when_env_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("INGEST_API_BASE_URL", raising=False)
    with pytest.raises(RuntimeError, match="INGEST_API_BASE_URL"):
        media_ingest_module.resolve_ingest_api_base_url()
