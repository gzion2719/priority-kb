"""Worker handler for the `ingest` queue — M2b #5 parsers + M2b #6 OCR.

Per [ADR-0021](../../docs/adr/0021-worker-http-callback-architecture.md)
and [ADR-0022 Amendment 2026-05-27](../../docs/adr/0022-ocr-adapter.md):
    1. Classify `payload.content_type` against the parser allowlist
       (PDF/DOCX) and the OCR allowlist (PNG/JPEG/WEBP from api.ocr).
    2. Read blob from `BLOB_STORAGE_DIR` + `payload.blob_storage_path`.
    3. Parser path → `parse_pdf`/`parse_docx`; OCR path →
       `asyncio.to_thread(ocr_adapter.ocr_bytes, ...)` (sync adapter,
       async bridge — see ADR-0022 A2).
    4. On empty result → `mark_failed(ParseEmpty)` or `mark_failed(OcrEmpty)`.
    5. SELECT current entry metadata (preserves title/category/tags/etc.).
    6. PUT to `INGEST_API_BASE_URL/api/ingest/<entry_id>` with the parsed
       body + preserved metadata + worker headers (sensitivity omitted
       so Node preserves the freshest value).
    7. On 2xx → `mark_done`. On 4xx/5xx/timeout → `mark_failed` with the
       stable `WorkerErrorClass` taxonomy.

Top-level `try/except Exception` maps unexpected escapes to
`HandlerCrashed` so a buggy library call or environment fault never
leaves a job stuck in `in_progress` (visibility-timeout reclaim would
eventually pick it up, but the loud-fail-now posture is preferable —
mirrors `_default_handler`'s explicit-fail discipline from
[ADR-0019 §D6](../../docs/adr/0019-job-queue.md)).

Iron-rule footprint:
    #2  Calls Node's existing admin endpoint (not a raw DB insert).
    #4  Worker → Node call carries `x-stub-user-role: admin` header so
        the Node `withAdmin` HOF gates the PUT the same way it gates a
        human-admin browser PUT. M5 hardens auth (ADR-0021 §D5).
    #6  Reads sensitivity from DB via `get_entry_metadata`; omits the
        field from the PUT body so Node preserves the post-dispatch
        freshest value (ADR-0021 §D4).
    #8  No live API SDK imports — Voyage stays Node-side under Option Y.
    #9  Does not write chunks; satisfied via Node delegation downstream.
    #10 No agent invocation.
    #12 Voyage outage surfaces as Node 5xx → `mark_failed(IngestApi5xx)`
        → retry per ADR-0019 attempts.
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx

from api.entries import EntryMetadata, get_entry_metadata
from api.handlers.types import WorkerErrorClass
from api.jobs import Job, mark_done, mark_failed
from api.ocr import OCR_ALLOWED_CONTENT_TYPES, OcrAdapter, OcrError
from api.parsers import ParserError, parse_docx, parse_pdf

logger = logging.getLogger(__name__)

# Content-type → parser function dispatch (M2b #5 parsers). Keys are
# lower-case; the dispatch code-folds at lookup time. Image MIMEs route
# through `OCR_ALLOWED_CONTENT_TYPES` (from api.ocr) instead — see
# ADR-0022 Amendment A4.
ParserFn = Callable[[bytes], str]
_PARSERS: dict[str, ParserFn] = {
    "application/pdf": parse_pdf,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": parse_docx,
}

# Truncate Node error response bodies at this many chars before they
# land in `audit_log.last_error` — bound chosen to fit a typical Node
# error response without bloating the table on adversarial / runaway
# 5xx bodies. The full response body lives in the Node side's own
# structured log row (lib/log.ts route variant); the worker's
# `last_error` is just the operator-facing crumb. Code-CR m4 (2026-05-27).
_RESPONSE_TRUNCATE = 500


def make_handler(
    *,
    conn_factory: Any,
    worker_id: str,
    http_client: httpx.AsyncClient,
    ingest_api_base_url: str,
    blob_root: str,
    ocr_adapter: OcrAdapter,
) -> Callable[[Job], Awaitable[None]]:
    """Construct the closure the worker's poll loop will call as `handler(job)`.

    Injecting via factory keeps the worker's startup config (DB conn,
    HTTP client, env paths, OCR adapter) out of module-level state and
    lets tests substitute stubs trivially.

    `ocr_adapter` is **required** (not defaulted to `get_ocr_adapter()`)
    so tests inject a hermetic stub and production startup resolves env
    once at boot. See ADR-0022 Amendment A5.

    Sized for caller side `api/worker.py main()`; not normally called
    directly from production code.
    """

    async def handler(job: Job) -> None:
        await _handle(
            job,
            conn_factory=conn_factory,
            worker_id=worker_id,
            http_client=http_client,
            ingest_api_base_url=ingest_api_base_url,
            blob_root=blob_root,
            ocr_adapter=ocr_adapter,
        )

    return handler


async def _handle(
    job: Job,
    *,
    conn_factory: Any,
    worker_id: str,
    http_client: httpx.AsyncClient,
    ingest_api_base_url: str,
    blob_root: str,
    ocr_adapter: OcrAdapter,
) -> None:
    """Single-job execution. All failure paths land in mark_done or mark_failed."""
    try:
        await _run(
            job,
            conn_factory=conn_factory,
            worker_id=worker_id,
            http_client=http_client,
            ingest_api_base_url=ingest_api_base_url,
            blob_root=blob_root,
            ocr_adapter=ocr_adapter,
        )
    except Exception as e:
        # Top-level safety net. Any escape that isn't already mapped
        # to a WorkerErrorClass by `_run` lands here. The handler
        # never lets a job rot in `in_progress`.
        logger.exception(
            "media_ingest handler crashed",
            extra={"job_id": str(job.id), "error": str(e)},
        )
        # The cleanup path itself can fail (DB unreachable, conn_factory
        # broken). Catch + log + return — never propagate a cleanup error
        # back into the poll loop. Worst-case: the visibility-timeout
        # reclaim picks the job up later. Code-CR M4 (2026-05-27).
        try:
            await _mark_failed_isolated(
                conn_factory=conn_factory,
                job_id=job.id,
                worker_id=worker_id,
                error=f"handler_crashed: {type(e).__name__}: {e}",
                error_class=WorkerErrorClass.HandlerCrashed,
            )
        except Exception as cleanup_err:
            logger.exception(
                "media_ingest cleanup mark_failed also crashed; "
                "relying on visibility-timeout reclaim",
                extra={
                    "job_id": str(job.id),
                    "original_error": str(e),
                    "cleanup_error": str(cleanup_err),
                },
            )


async def _run(
    job: Job,
    *,
    conn_factory: Any,
    worker_id: str,
    http_client: httpx.AsyncClient,
    ingest_api_base_url: str,
    blob_root: str,
    ocr_adapter: OcrAdapter,
) -> None:
    """Happy-path implementation. Each terminal branch ends in mark_done /
    mark_failed; exceptions escape to the top-level catch in `_handle`."""
    payload = job.payload
    entry_id_str = payload.get("entry_id")
    content_type = payload.get("content_type")
    blob_path_rel = payload.get("blob_storage_path")
    if (
        not isinstance(entry_id_str, str)
        or not isinstance(content_type, str)
        or not isinstance(blob_path_rel, str)
    ):
        await _mark_failed_isolated(
            conn_factory=conn_factory,
            job_id=job.id,
            worker_id=worker_id,
            error="job payload missing required fields (entry_id, content_type, blob_storage_path)",
            error_class=WorkerErrorClass.HandlerCrashed,
        )
        return
    # Code-CR B2 (2026-05-27): UUID() raises ValueError on malformed
    # input — without an explicit guard the exception escapes _run and
    # lands on the top-level except as `HandlerCrashed`, which fires the
    # dashboard alert intended for genuine handler bugs. A malformed
    # entry_id in payload is a caller / schema issue, so it stays under
    # HandlerCrashed (no new enum value per ADR-0021 §D8's closed-enum
    # contract) BUT the error message is structured so dashboards
    # filtering by `last_error LIKE 'malformed_entry_id_uuid%'` can
    # distinguish it.
    try:
        entry_id = UUID(entry_id_str)
    except ValueError as e:
        await _mark_failed_isolated(
            conn_factory=conn_factory,
            job_id=job.id,
            worker_id=worker_id,
            error=f"malformed_entry_id_uuid: {entry_id_str!r}: {e}",
            error_class=WorkerErrorClass.HandlerCrashed,
        )
        return

    # ---------- Step 1: classify content_type ----------
    # Content-types from the upload route are stored verbatim
    # (`fileField.type` per app/api/ingest/upload/route.ts:207). We
    # case-fold defensively here so a non-conforming browser that sends
    # `Application/PDF` doesn't silently route to UnsupportedContentType.
    # The upload route's allowlist is itself case-sensitive, so this is
    # belt-and-suspenders; the test surface pins the lower-case keys.
    ct_normalized = content_type.lower()
    is_parser_type = ct_normalized in _PARSERS
    is_ocr_type = ct_normalized in OCR_ALLOWED_CONTENT_TYPES
    if not (is_parser_type or is_ocr_type):
        await _mark_failed_isolated(
            conn_factory=conn_factory,
            job_id=job.id,
            worker_id=worker_id,
            error=f"unsupported content_type: {content_type}",
            error_class=WorkerErrorClass.UnsupportedContentType,
        )
        return

    # ---------- Step 2: read blob ----------
    blob_full_path = Path(blob_root) / blob_path_rel
    try:
        blob_bytes = blob_full_path.read_bytes()
    except OSError as e:
        await _mark_failed_isolated(
            conn_factory=conn_factory,
            job_id=job.id,
            worker_id=worker_id,
            error=f"blob read failed at {blob_full_path}: {type(e).__name__}: {e}",
            error_class=WorkerErrorClass.BlobReadFailed,
        )
        return

    # ---------- Step 3: parse OR ocr ----------
    if is_parser_type:
        parser = _PARSERS[ct_normalized]
        try:
            parsed_text = parser(blob_bytes)
        except ParserError as e:
            await _mark_failed_isolated(
                conn_factory=conn_factory,
                job_id=job.id,
                worker_id=worker_id,
                error=f"parse_failed: code={e.code}: {e}",
                error_class=WorkerErrorClass.ParseFailed,
            )
            return
        empty_error_class = WorkerErrorClass.ParseEmpty
        empty_error_msg = (
            f"parser returned empty text for {content_type} (image-only or empty doc?)"
        )
    else:
        # OCR path. ADR-0022 Amendment A2 — OcrAdapter.ocr_bytes is sync;
        # bridge to the event loop via asyncio.to_thread so the worker's
        # poll loop doesn't stall during the Azure DI HTTP round-trip.
        try:
            ocr_result = await asyncio.to_thread(ocr_adapter.ocr_bytes, blob_bytes, ct_normalized)
        except OcrError as e:
            if e.code == "ocr_failed":
                error_class = WorkerErrorClass.OcrFailed
                error_msg = f"ocr_failed: {e}"
            elif e.code == "empty_result":
                error_class = WorkerErrorClass.OcrEmpty
                error_msg = f"ocr_empty_result: {e}"
            else:
                # Defensive — Amendment A1. The pre-dispatch allowlist
                # filter at Step 1 already ensures ct_normalized is in
                # OCR_ALLOWED_CONTENT_TYPES, so the adapter raising
                # "unsupported_content_type" (or any other unknown code)
                # means the handler's allowlist and the adapter's
                # allowlist drifted — that's a bug, not an OCR failure.
                error_class = WorkerErrorClass.HandlerCrashed
                error_msg = f"ocr_dispatch_allowlist_mismatch: code={e.code}: {e}"
            await _mark_failed_isolated(
                conn_factory=conn_factory,
                job_id=job.id,
                worker_id=worker_id,
                error=error_msg,
                error_class=error_class,
            )
            return
        parsed_text = ocr_result.text
        empty_error_class = WorkerErrorClass.OcrEmpty
        empty_error_msg = f"ocr returned empty text for {content_type} (whitespace-only result)"

    # ---------- Step 4: empty-result short-circuit ----------
    # Belt-and-suspenders: parsers can return "" without raising; OCR can
    # return whitespace-only text without raising empty_result.
    if not parsed_text.strip():
        await _mark_failed_isolated(
            conn_factory=conn_factory,
            job_id=job.id,
            worker_id=worker_id,
            error=empty_error_msg,
            error_class=empty_error_class,
        )
        return

    # ---------- Step 5: SELECT current entry metadata ----------
    metadata: EntryMetadata | None
    async with await conn_factory() as conn:
        metadata = await get_entry_metadata(conn, entry_id=entry_id)
    if metadata is None:
        await _mark_failed_isolated(
            conn_factory=conn_factory,
            job_id=job.id,
            worker_id=worker_id,
            error=f"entry metadata not found: {entry_id}",
            error_class=WorkerErrorClass.EntryMetadataNotFound,
        )
        return

    # ---------- Step 6: PUT to Node ----------
    # `sensitivity` intentionally omitted from the body per ADR-0021 §D4
    # — Node's PUT route preserves the current `entries.sensitivity` value
    # when the field is absent, closing the dispatch-to-PUT downgrade race.
    put_body: dict[str, Any] = {
        "title": metadata.title,
        "category": metadata.category,
        "tags": metadata.tags,
        "body": parsed_text,
        "source_pointer": metadata.source_pointer,
        "last_verified_at": metadata.last_verified_at.isoformat(),
    }
    put_url = f"{ingest_api_base_url.rstrip('/')}/api/ingest/{entry_id}"
    headers = {
        # ADR-0021 §D5 — dev-stub admin auth. M5 hardens.
        "x-stub-user-role": "admin",
        # ADR-0021 §D3 — worker attribution logged into audit_log.payload.
        "x-worker-id": worker_id,
        "x-worker-job-id": str(job.id),
    }
    try:
        response = await http_client.put(put_url, json=put_body, headers=headers)
    except httpx.TimeoutException as e:
        await _mark_failed_isolated(
            conn_factory=conn_factory,
            job_id=job.id,
            worker_id=worker_id,
            error=f"ingest_api timeout: {type(e).__name__}: {e}",
            error_class=WorkerErrorClass.IngestApiTimeout,
        )
        return
    except httpx.HTTPError as e:
        await _mark_failed_isolated(
            conn_factory=conn_factory,
            job_id=job.id,
            worker_id=worker_id,
            error=f"ingest_api http error: {type(e).__name__}: {e}",
            error_class=WorkerErrorClass.IngestApi5xx,
        )
        return

    # ---------- Step 7: map response ----------
    if 200 <= response.status_code < 300:
        async with await conn_factory() as conn:
            await mark_done(conn, job_id=job.id, worker_id=worker_id)
        return
    if response.status_code == 404:
        await _mark_failed_isolated(
            conn_factory=conn_factory,
            job_id=job.id,
            worker_id=worker_id,
            error=f"ingest_api 404 for entry {entry_id}",
            error_class=WorkerErrorClass.IngestApiNotFound,
        )
        return
    if 400 <= response.status_code < 500:
        await _mark_failed_isolated(
            conn_factory=conn_factory,
            job_id=job.id,
            worker_id=worker_id,
            error=f"ingest_api {response.status_code}: {response.text[:_RESPONSE_TRUNCATE]}",
            error_class=WorkerErrorClass.IngestApi4xx,
        )
        return
    # 5xx (and any other unmapped status — defensive).
    await _mark_failed_isolated(
        conn_factory=conn_factory,
        job_id=job.id,
        worker_id=worker_id,
        error=f"ingest_api {response.status_code}: {response.text[:_RESPONSE_TRUNCATE]}",
        error_class=WorkerErrorClass.IngestApi5xx,
    )


async def _mark_failed_isolated(
    *,
    conn_factory: Any,
    job_id: UUID,
    worker_id: str,
    error: str,
    error_class: WorkerErrorClass,
) -> None:
    """Open a fresh conn just for the mark_failed transition.

    The handler's main flow may open + close multiple conns (one for
    `get_entry_metadata`, one for `mark_done`/`mark_failed`); each
    `mark_failed` call needs its own short-lived transaction so a
    failed flush doesn't poison a later one. Passes the
    `WorkerErrorClass.value` string through to keep `api.jobs`
    decoupled from the enum.
    """
    async with await conn_factory() as conn:
        await mark_failed(
            conn,
            job_id=job_id,
            worker_id=worker_id,
            error=error,
            error_class=error_class.value,
        )


def resolve_blob_root() -> str:
    """Read `BLOB_STORAGE_DIR` env, fail loudly if absent.

    Per ADR-0021 §D11: no silent default — the Node side's default
    (`./blob-storage/dev`) lives in TypeScript; the Python worker must
    inherit the operator's choice explicitly so a mismatched FS root
    surfaces immediately rather than as a stream of `BlobReadFailed`
    error_class rows.
    """
    value = os.environ.get("BLOB_STORAGE_DIR")
    if not value:
        raise RuntimeError(
            "BLOB_STORAGE_DIR env var is required for the media-ingest handler "
            "(set it to the same path the Node upload route uses; default is "
            "./blob-storage/dev)."
        )
    return value


def resolve_ingest_api_base_url() -> str:
    """Read `INGEST_API_BASE_URL` env, fail loudly if absent."""
    value = os.environ.get("INGEST_API_BASE_URL")
    if not value:
        raise RuntimeError(
            "INGEST_API_BASE_URL env var is required for the media-ingest handler "
            "(e.g., http://localhost:3000 in dev)."
        )
    return value
