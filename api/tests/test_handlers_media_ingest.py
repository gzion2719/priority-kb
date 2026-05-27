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
from api.ocr import OcrError, OcrResult, StubOcrAdapter

# Module-level stub OCR adapter — stateless, deterministic, reused across
# all tests that don't need a custom OCR behavior. Tests asserting on
# OCR-specific branches (failures, empty results, allowlist drift) build
# their own per-test stub inline. Threaded into every `_handle` call as
# `ocr_adapter=stub_ocr_adapter` per ADR-0022 Amendment A5 (required kwarg).
stub_ocr_adapter = StubOcrAdapter()


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
        ocr_adapter=stub_ocr_adapter,
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
        ocr_adapter=stub_ocr_adapter,
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
    """Non-image, non-PDF/DOCX MIME → UnsupportedContentType, no work done.

    Migrated post ADR-0022 Amendment: image MIMEs are now supported via
    OCR (was the original test case). `application/zip` is the canonical
    never-supported MIME the worker must reject without running a parser,
    calling OCR, or hitting the network.
    """
    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "application/zip",
            "blob_storage_path": "ignored/path.zip",
            "original_filename": "x.zip",
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
        ocr_adapter=stub_ocr_adapter,
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
        ocr_adapter=stub_ocr_adapter,
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
        ocr_adapter=stub_ocr_adapter,
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
        ocr_adapter=stub_ocr_adapter,
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
        ocr_adapter=stub_ocr_adapter,
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
        ocr_adapter=stub_ocr_adapter,
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
        ocr_adapter=stub_ocr_adapter,
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
        ocr_adapter=stub_ocr_adapter,
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
        ocr_adapter=stub_ocr_adapter,
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
        ocr_adapter=stub_ocr_adapter,
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
        ocr_adapter=stub_ocr_adapter,
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
        ocr_adapter=stub_ocr_adapter,
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
        ocr_adapter=stub_ocr_adapter,
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
        ocr_adapter=stub_ocr_adapter,
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


# --- ADR-0022 Amendment A4 — OCR dispatch branch tests ---


class _RecordingOcrAdapter:
    """Test-time adapter that returns a caller-supplied OcrResult OR raises.

    Mirrors the StubOcrAdapter shape (sync `ocr_bytes`) so the handler's
    `asyncio.to_thread(...)` bridge exercises the same control flow as
    production. Stateful only in the sense that calls are recorded for
    assertion; the adapter itself is otherwise deterministic.
    """

    def __init__(
        self,
        *,
        result: OcrResult | None = None,
        raises: OcrError | None = None,
    ) -> None:
        self._result = result
        self._raises = raises
        self.calls: list[tuple[bytes, str]] = []

    def ocr_bytes(self, data: bytes, content_type: str) -> OcrResult:
        self.calls.append((data, content_type))
        if self._raises is not None:
            raise self._raises
        assert self._result is not None
        return self._result


@pytest.mark.asyncio
async def test_image_png_ocr_happy_path_puts_ocr_text_in_body(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    """image/png → OCR adapter → PUT body contains OCR-extracted text → mark_done.

    Negative-assertion: the body MUST be the OCR text, not the parser's
    output, not the placeholder. If the dispatch branch wired backward
    and routed the image through parse_pdf, the body would be empty (or
    explode) and this assertion fails.
    """
    blob_rel = "img/screenshot.png"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes(b"\x89PNG\r\n\x1a\nfake-png-content")

    entry_id = uuid4()
    job = _make_job(
        {
            "entry_id": str(entry_id),
            "content_type": "image/png",
            "blob_storage_path": blob_rel,
            "original_filename": "screenshot.png",
            "byte_length": blob_full.stat().st_size,
        }
    )

    ocr_text = "Hebrew form label\n\nvalue from screenshot"
    ocr = _RecordingOcrAdapter(
        result=OcrResult(
            text=ocr_text,
            paragraphs=["Hebrew form label", "value from screenshot"],
            confidence=0.95,
            model="prebuilt-layout",
            api_version="2024-11-30",
        )
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
        ocr_adapter=ocr,
    )

    assert len(capture_marks["done"]) == 1
    assert capture_marks["failed"] == []
    # Adapter was invoked with the blob bytes + lower-cased content type.
    assert len(ocr.calls) == 1
    assert ocr.calls[0][0] == b"\x89PNG\r\n\x1a\nfake-png-content"
    assert ocr.calls[0][1] == "image/png"
    # PUT body carries the OCR text, NOT the placeholder.
    body = http_client.put.await_args.kwargs["json"]
    assert body["body"] == ocr_text


@pytest.mark.asyncio
async def test_image_ocr_failed_marks_failed_with_ocr_failed_class(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    """OcrError('ocr_failed') (Azure outage, etc.) → mark_failed(OcrFailed)."""
    blob_rel = "img/down.png"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes(b"\x89PNG\r\n\x1a\nbytes")

    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "image/png",
            "blob_storage_path": blob_rel,
            "original_filename": "down.png",
            "byte_length": blob_full.stat().st_size,
        }
    )
    ocr = _RecordingOcrAdapter(raises=OcrError("ocr_failed", "Azure 503 ServiceUnavailable"))
    http_client = _stub_http_client(response=httpx.Response(200))

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
        ocr_adapter=ocr,
    )

    assert capture_marks["done"] == []
    assert len(capture_marks["failed"]) == 1
    failed = capture_marks["failed"][0]
    assert failed.error_class == WorkerErrorClass.OcrFailed.value
    assert "ocr_failed" in failed.error
    http_client.put.assert_not_called()


@pytest.mark.asyncio
async def test_image_ocr_empty_result_marks_failed_with_ocr_empty_class(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    """OcrError('empty_result') (no paragraphs surfaced) → mark_failed(OcrEmpty)."""
    blob_rel = "img/blank.png"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes(b"\x89PNG\r\n\x1a\nbytes")

    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "image/png",
            "blob_storage_path": blob_rel,
            "original_filename": "blank.png",
            "byte_length": blob_full.stat().st_size,
        }
    )
    ocr = _RecordingOcrAdapter(raises=OcrError("empty_result", "Azure returned 0 paragraphs"))
    http_client = _stub_http_client(response=httpx.Response(200))

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
        ocr_adapter=ocr,
    )

    assert len(capture_marks["failed"]) == 1
    failed = capture_marks["failed"][0]
    assert failed.error_class == WorkerErrorClass.OcrEmpty.value
    http_client.put.assert_not_called()


@pytest.mark.asyncio
async def test_image_ocr_allowlist_mismatch_maps_to_handler_crashed(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    """Defensive: adapter raises 'unsupported_content_type' despite pre-dispatch filter.

    This should never happen in practice — the handler's allowlist and
    the adapter's allowlist (both from OCR_ALLOWED_CONTENT_TYPES) are
    sourced from the same constant. If they ever drift, the failure is
    a *bug*, not an OCR failure, so we map to HandlerCrashed with a
    structured `last_error` prefix per ADR-0022 Amendment A1.
    """
    blob_rel = "img/x.png"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes(b"\x89PNG\r\n\x1a\nbytes")

    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "image/png",
            "blob_storage_path": blob_rel,
            "original_filename": "x.png",
            "byte_length": blob_full.stat().st_size,
        }
    )
    ocr = _RecordingOcrAdapter(raises=OcrError("unsupported_content_type", "adapter says no"))
    http_client = _stub_http_client(response=httpx.Response(200))

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
        ocr_adapter=ocr,
    )

    assert len(capture_marks["failed"]) == 1
    failed = capture_marks["failed"][0]
    assert failed.error_class == WorkerErrorClass.HandlerCrashed.value
    # Structured prefix is the discriminator for this specific bug class
    # (mirrors malformed_entry_id_uuid: precedent).
    assert failed.error.startswith("ocr_dispatch_allowlist_mismatch:")
    http_client.put.assert_not_called()


@pytest.mark.asyncio
async def test_image_ocr_whitespace_only_result_marks_failed_ocr_empty(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    """OCR returns text but it's all whitespace → mark_failed(OcrEmpty).

    Belt-and-suspenders: the adapter raised empty_result on zero
    paragraphs but a vendor variant might return whitespace-only text
    (e.g., scanned blank page with only newline characters). The
    handler's strip-then-check guards against silently sending a
    whitespace body to Node.
    """
    blob_rel = "img/whitespace.png"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes(b"\x89PNG\r\n\x1a\nbytes")

    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "image/png",
            "blob_storage_path": blob_rel,
            "original_filename": "whitespace.png",
            "byte_length": blob_full.stat().st_size,
        }
    )
    ocr = _RecordingOcrAdapter(
        result=OcrResult(
            text="   \n\n  \t  ",
            paragraphs=["   ", "  \t  "],
            confidence=None,
            model="prebuilt-layout",
            api_version="2024-11-30",
        )
    )
    http_client = _stub_http_client(response=httpx.Response(200))

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
        ocr_adapter=ocr,
    )

    assert len(capture_marks["failed"]) == 1
    failed = capture_marks["failed"][0]
    assert failed.error_class == WorkerErrorClass.OcrEmpty.value
    assert "whitespace-only" in failed.error
    http_client.put.assert_not_called()


@pytest.mark.asyncio
async def test_image_content_type_case_folded_to_lowercase_before_ocr(
    tmp_path: Path,
    capture_marks: dict[str, list[Any]],
    patch_metadata_found: EntryMetadata,
) -> None:
    """`Image/PNG` from a non-conforming browser still routes to OCR.

    Mirrors the existing parser-path case-folding test at the bottom of
    this file — the dispatch lower-cases content_type before allowlist
    membership check. Without this, an Application/PDF would route to
    UnsupportedContentType; same shape applies to image MIMEs.
    """
    blob_rel = "img/upper.png"
    blob_full = tmp_path / blob_rel
    blob_full.parent.mkdir(parents=True)
    blob_full.write_bytes(b"\x89PNG\r\n\x1a\nbytes")

    job = _make_job(
        {
            "entry_id": str(uuid4()),
            "content_type": "Image/PNG",  # uppercase variant
            "blob_storage_path": blob_rel,
            "original_filename": "upper.png",
            "byte_length": blob_full.stat().st_size,
        }
    )
    ocr = _RecordingOcrAdapter(
        result=OcrResult(
            text="case folded OK",
            paragraphs=["case folded OK"],
            confidence=None,
            model="prebuilt-layout",
            api_version="2024-11-30",
        )
    )
    response = httpx.Response(
        200,
        json={"id": job.payload["entry_id"], "version_no": 2, "chunk_count": 1},
        request=httpx.Request("PUT", f"http://node/api/ingest/{job.payload['entry_id']}"),
    )
    http_client = _stub_http_client(response=response)

    await media_ingest_module._handle(
        job,
        conn_factory=_conn_factory_stub,
        worker_id="w",
        http_client=http_client,
        ingest_api_base_url="http://node",
        blob_root=str(tmp_path),
        ocr_adapter=ocr,
    )

    assert len(capture_marks["done"]) == 1
    # Adapter was called with the lower-cased MIME.
    assert ocr.calls[0][1] == "image/png"


def test_ocr_allowed_content_types_includes_expected_mimes() -> None:
    """py-registry-test-sweep: the canonical OCR allowlist contains the three image MIMEs.

    If a new MIME is added to OCR_ALLOWED_CONTENT_TYPES, the dispatch
    branch in media_ingest._run automatically picks it up — no separate
    code change required. This test pins the current allowlist so a
    silent shrink (e.g., dropping image/webp) surfaces here.
    """
    from api.ocr import OCR_ALLOWED_CONTENT_TYPES

    assert frozenset({"image/png", "image/jpeg", "image/webp"}) == OCR_ALLOWED_CONTENT_TYPES


def test_worker_error_class_taxonomy_includes_ocr_codes() -> None:
    """py-registry-test-sweep: WorkerErrorClass exposes OcrFailed + OcrEmpty.

    Pins the ADR-0022 Amendment A1 enum extension. Renaming or removing
    either value silently breaks downstream dashboards; this test is the
    canary.
    """
    assert WorkerErrorClass.OcrFailed.value == "ocr_failed"
    assert WorkerErrorClass.OcrEmpty.value == "ocr_empty_result"
