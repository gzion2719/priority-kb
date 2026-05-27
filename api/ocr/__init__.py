"""ADR-0022 M2b #6 — OCR adapter surface.

Vendor-agnostic OCR contract + Azure Document Intelligence implementation
+ deterministic stub. Mirrors the `api/parsers/` package shape.

Iron-rule footprint (package surface):
    #2  No public route; called only from the worker handler (next slice).
    #6  No sensitivity touched here.
    #8  Azure DI is OCR, NOT embedding/agent — not added to FORBIDDEN
        list (ADR-0022 D7).
    #9  Does not write chunks; provenance lives on OcrResult, recorded
        by the next-slice worker handler.
    #10 No agent invocation.
    #12 Stub is the test-time fallback; production-time Tesseract
        fallback deferred (ADR-0022 D6).

Exported surface:
    OcrAdapter            — structural Protocol; any object exposing
                            ocr_bytes(data, content_type) -> OcrResult.
    OcrResult             — frozen dataclass; vendor-agnostic output.
    OcrError              — exception with stable .code taxonomy.
    StubOcrAdapter        — deterministic; for tests + degraded fallback.
    get_ocr_adapter()     — factory: stub-by-default, Azure when env present.
"""

from __future__ import annotations

from api.ocr.factory import get_ocr_adapter
from api.ocr.stub import StubOcrAdapter
from api.ocr.types import OcrAdapter, OcrError, OcrResult

__all__ = [
    "OcrAdapter",
    "OcrError",
    "OcrResult",
    "StubOcrAdapter",
    "get_ocr_adapter",
]
