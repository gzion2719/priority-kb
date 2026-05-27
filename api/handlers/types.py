"""Closed taxonomy of worker-handler error classes (ADR-0021 §D8).

The enum is intentionally closed — new categories require an ADR
amendment so dashboards stay stable. Values land in two places:

    1. `audit_log.payload.error_class` via `api.jobs.mark_failed`.
    2. `LogEventJob.error_class` via the same call, per ADR-0020 §D4's
       audit_log ⇔ LogEventJob 1:1 contract.

Lives in its own module to avoid an import cycle: `api.jobs` references
the string values via the `mark_failed(error_class=...)` parameter
WITHOUT importing the enum itself (the caller — always a handler —
converts ``WorkerErrorClass.X.value`` to the string).
"""

from __future__ import annotations

from enum import StrEnum


class WorkerErrorClass(StrEnum):
    """Stable error taxonomy for worker-handler failures.

    Adding a value requires an ADR amendment + dashboard regression
    check. Removing or renaming requires a deprecation cycle.
    """

    # Parser surface (api/parsers/*) failures.
    ParseFailed = "parse_failed"
    """`ParserError("corrupt")` or `ParserError("encrypted")` from
    `parse_pdf` / `parse_docx`. Distinct codes (corrupt vs encrypted)
    are NOT collapsed into a single enum value — the worker's
    `mark_failed(error=...)` free-text carries the specific
    `ParserError.code` for forensics."""

    ParseEmpty = "parse_empty_result"
    """Parser returned `""` — document is parseable but contains no
    extractable text (image-only PDF, empty DOCX). Re-upload with
    OCR'd version is the recovery path."""

    UnsupportedContentType = "unsupported_content_type"
    """Job payload `content_type` is not one of the M2b #5 handlers'
    known content types (PDF, DOCX). Image content types — PNG / JPG /
    WEBP — defer to M2b #6 OCR; until that lands they fall here."""

    BlobReadFailed = "blob_read_failed"
    """FS / IO error reading the blob from `BLOB_STORAGE_DIR`. Usually
    a worker-side environment misconfiguration (wrong root, missing
    mount, permission). Retry-eligible because the underlying issue
    may resolve via operator action."""

    IngestApiNotFound = "ingest_api_not_found"
    """Node `PUT /api/ingest/[id]` returned 404 — the placeholder entry
    was deleted between enqueue and dispatch. Retries up to
    max_attempts then lands in `dead` (ADR-0021 §D9 — no
    `force_dead=True` knob in M2b)."""

    IngestApi4xx = "ingest_api_4xx"
    """Other 4xx from Node PUT (validation error, etc.). Retries up to
    max_attempts; usually unrecoverable but kept retry-eligible because
    transient validation failures can occur during admin-initiated
    schema migrations."""

    IngestApi5xx = "ingest_api_5xx"
    """Node PUT returned 5xx — server-side error, retry-eligible."""

    IngestApiTimeout = "ingest_api_timeout"
    """`httpx.TimeoutException` or `httpx.ConnectError` on the Node PUT —
    network or Node-side hang. Retry-eligible."""

    EntryMetadataNotFound = "entry_metadata_not_found"
    """`api.entries.get_entry_metadata` returned None — the entry row
    vanished between enqueue and dispatch. Equivalent to
    `IngestApiNotFound` in failure mode but caught earlier (before the
    PUT) so observability distinguishes the two."""

    HandlerCrashed = "handler_crashed"
    """Top-level `except Exception` catch in the handler — a bug, an
    unexpected library exception, or an environmental fault that
    didn't map to a more specific class. Retry-eligible; deserves
    a dashboard alert."""
