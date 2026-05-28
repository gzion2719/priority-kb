"""OCR fallback chain — see ADR-0022 Amendment A9.

`FallbackOcrAdapter` tries a primary adapter; on an OUTAGE (an
`OcrError` whose `.code == "ocr_failed"`) it retries with a fallback adapter.
Deterministic non-outage outcomes (`unsupported_content_type`, `empty_result`)
are NOT retried — re-running a second engine on an unsupported MIME or a
genuinely blank image wastes a call and can mask the real outcome. The
`ocr_failed`-only trigger is a recorded decision; see ADR-0022 A9 (Q1).

Iron-rule #12: this is the wiring that lets an Azure DI outage degrade to a
local engine rather than hard-fail.
"""

from __future__ import annotations

import logging

from api.ocr.types import OcrAdapter, OcrError, OcrResult

logger = logging.getLogger(__name__)

# Only this OcrError code triggers the fallback. Every other code is a
# deterministic outcome, not an outage.
_FALLBACK_TRIGGER_CODE = "ocr_failed"


class FallbackOcrAdapter:
    """Primary-then-fallback OCR chain; structural implementation of OcrAdapter.

    Transparent to the worker handler: it calls `ocr_bytes` and either gets a
    result (from primary or fallback) or a final `OcrError`. The handler's
    existing `ocr_failed -> mark_failed(OcrFailed)` mapping now fires only when
    BOTH engines fail.
    """

    def __init__(self, *, primary: OcrAdapter, fallback: OcrAdapter) -> None:
        self._primary = primary
        self._fallback = fallback

    @property
    def primary(self) -> OcrAdapter:
        return self._primary

    @property
    def fallback(self) -> OcrAdapter:
        return self._fallback

    def ocr_bytes(self, data: bytes, content_type: str) -> OcrResult:
        try:
            return self._primary.ocr_bytes(data, content_type)
        except OcrError as primary_err:
            if primary_err.code != _FALLBACK_TRIGGER_CODE:
                # Deterministic outcome (unsupported / empty) — not an outage.
                raise
            # Durable operator signal: a silent Azure outage is detectable by
            # grepping this stable prefix. The worker discards OcrResult.model
            # today (ADR-0022 A6), so this WARN is the degrade signal. See A9.
            logger.warning(
                "ocr_fallback_engaged: primary=%s failed (%s); retrying with fallback=%s",
                type(self._primary).__name__,
                primary_err,
                type(self._fallback).__name__,
            )
            try:
                return self._fallback.ocr_bytes(data, content_type)
            except OcrError as fallback_err:
                logger.warning(
                    "ocr_fallback_failed: fallback=%s also failed (%s)",
                    type(self._fallback).__name__,
                    fallback_err,
                )
                # Re-raise the fallback's error (the primary's is logged above).
                # Net result is a terminal OcrError, same shape the handler maps
                # to mark_failed today.
                raise
