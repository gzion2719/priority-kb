"""ADR-0022 M2b #6 — OCR adapter surface.

Vendor-agnostic OCR contract + Azure Document Intelligence implementation
+ deterministic stub. Mirrors the `api/parsers/` package shape.

Iron-rule footprint (package surface):
    #2  No public route; called only from the worker handler (next slice).
    #6  No KB entry written here; sensitivity tag dispatch N/A.
    #8  Azure DI is OCR, NOT embedding/agent — not added to FORBIDDEN
        list (ADR-0022 D7).
    #9  Does not write chunks; provenance lives on OcrResult, recorded
        by the next-slice worker handler.
    #10 No agent invocation.
    #12 Production-time fallback CLOSED (ADR-0022 A9): an Azure DI outage
        degrades to local Tesseract via FallbackOcrAdapter; the stub
        remains the no-Azure / test-time adapter.

Exported surface:
    OcrAdapter            — structural Protocol; any object exposing
                            ocr_bytes(data, content_type) -> OcrResult.
    OcrResult             — frozen dataclass; vendor-agnostic output.
    OcrError              — exception with stable .code taxonomy.
    StubOcrAdapter        — deterministic; no-Azure / test-time adapter.
    TesseractOcrAdapter   — local OCR; the production-time degraded fallback.
    FallbackOcrAdapter    — primary-then-fallback chain (Azure -> Tesseract).
    get_ocr_adapter()     — factory: stub-by-default; Azure wrapped in a
                            Tesseract fallback when env present.
"""

from __future__ import annotations

from api.ocr.factory import get_ocr_adapter
from api.ocr.fallback import FallbackOcrAdapter
from api.ocr.stub import StubOcrAdapter
from api.ocr.tesseract import TesseractOcrAdapter
from api.ocr.types import OcrAdapter, OcrError, OcrResult

# Canonical MIME allowlist for OCR-eligible content types. Single source
# of truth per ADR-0022 Amendment A3 — stub.py + azure.py + the worker
# handler all import this constant. Extension requires an ADR-0022
# amendment (D3 contract).
OCR_ALLOWED_CONTENT_TYPES: frozenset[str] = frozenset({"image/png", "image/jpeg", "image/webp"})


__all__ = [
    "OCR_ALLOWED_CONTENT_TYPES",
    "FallbackOcrAdapter",
    "OcrAdapter",
    "OcrError",
    "OcrResult",
    "StubOcrAdapter",
    "TesseractOcrAdapter",
    "get_ocr_adapter",
]
