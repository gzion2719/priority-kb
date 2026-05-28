"""Shared types for the OCR adapter surface — see ADR-0022.

Mirrors `api/parsers/types.py` shape so the worker handler's
`WorkerErrorClass` mapping (extended in the next slice) lines up against
both surfaces without special-casing.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True, slots=True)
class OcrResult:
    """Vendor-agnostic OCR output. See ADR-0022 D1.

    Fields:
        text: All paragraphs joined by "\\n\\n". Convenience for the
            worker handler's body-submit path.
        paragraphs: Order-preserving paragraph segmentation. The chunker
            uses paragraph boundaries as natural cut points (the spike's
            evidence at BACKLOG:63 — labels and values land in adjacent
            paragraphs).
        confidence: Mean per-word confidence in [0, 1], or None when the
            vendor doesn't surface a confidence score. Reported only; no
            adapter-side threshold gating (downstream worker policy).
        model: Adapter identity. "prebuilt-layout" for Azure DI;
            "stub-azure-di" for the stub.
        api_version: Wire-protocol pin. "2024-11-30" for Azure; "v1" for
            the stub. Kept separate from `model` because Azure's model
            name and API version evolve independently — conflating them
            into a single `model_version` field invites future
            misattribution under iron-rule #9-style provenance tracking.
    """

    text: str
    paragraphs: list[str]
    confidence: float | None
    model: str
    api_version: str


class OcrError(Exception):
    """Failure raised by the OCR adapter surface.

    `code` is a short stable label so the next-slice worker handler can
    map it to the `WorkerErrorClass` taxonomy without parsing the message.
    Mirror of `ParserError` shape (api/parsers/types.py).

    Stable codes (extend only via ADR-0022 amendment):
        "unsupported_content_type" — caller passed a MIME outside the
            adapter's allowlist. The image-only allowlist for this
            increment is PNG/JPEG/WEBP (ADR-0022 D3).
        "ocr_failed"               — vendor SDK raised (Azure outage,
            transient 5xx, quota error, credential error), OR the Tesseract
            fallback's own failure. This is the code that triggers the
            Azure→Tesseract fallback in FallbackOcrAdapter (ADR-0022 A9).
        "empty_result"             — vendor returned 0 paragraphs / empty
            content. Likely a blank image or all-non-text glyphs; the
            worker handler maps this to mark_failed in the next slice.
    """

    def __init__(self, code: str, message: str | None = None) -> None:
        super().__init__(message or code)
        self.code = code


class OcrAdapter(Protocol):
    """Structural contract for OCR adapters — see ADR-0022 D1.

    Implementations:
        - StubOcrAdapter (api.ocr.stub)
        - AzureDocumentIntelligenceAdapter (api.ocr.azure)
        - TesseractOcrAdapter (api.ocr.tesseract) — degraded-mode fallback
        - FallbackOcrAdapter (api.ocr.fallback) — primary→fallback chain
    """

    def ocr_bytes(self, data: bytes, content_type: str) -> OcrResult: ...
