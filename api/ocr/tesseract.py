"""Tesseract OCR fallback adapter — see ADR-0022 Amendment A9.

Production-time degraded-mode fallback (iron-rule #12): when Azure DI is
unreachable the worker degrades to local Tesseract OCR instead of hard-failing.
Lower quality than Azure `prebuilt-layout`; engaged only on an Azure outage via
`FallbackOcrAdapter`.

`pytesseract` is imported at module scope — the import itself does NOT require
the native `tesseract` binary (pytesseract shells out only at call time). The
binary is needed inside `ocr_bytes`; a missing binary surfaces there as
`OcrError("ocr_failed")`, never as an import-time crash (code-CR B2).

Iron-rule footprint:
    #8  Tesseract/Pillow are OCR libs, NOT embedding/agent SDKs — not on the
        FORBIDDEN list (same rationale as Azure DI, ADR-0022 D7).
    #9  Does not write chunks; provenance (model/api_version) on OcrResult.
    #12 This is the production-time fallback that closes the degraded-mode leg.
"""

from __future__ import annotations

import io
import re

import pytesseract
from PIL import Image, UnidentifiedImageError

from api.ocr.types import OcrError, OcrResult

_MODEL = "tesseract"
_LANG = "heb+eng"

# Exceptions from the PIL load + Tesseract call that mean "this OCR attempt
# failed" (a recoverable outage), vs. a programming error. Mapped to
# OcrError("ocr_failed") so the fallback chain / worker handler treats them as
# an outage, NOT a HandlerCrashed dashboard alert. Membership rationale:
#   - TesseractNotFoundError: binary absent. Subclasses OSError, NOT
#     TesseractError — must be named explicitly or it escapes (code-CR B3).
#   - TesseractError: any tesseract-side failure (missing lang pack, etc.).
#   - UnidentifiedImageError + DecompressionBombError: PIL decode failures on a
#     corrupt or adversarial (decompression-bomb) image. DecompressionBombError
#     subclasses neither OSError nor ValueError, so it must be named or it
#     escapes to HandlerCrashed.
#   - OSError: truncated-image reads (UnidentifiedImageError's parent; covers
#     the broad decode-IO failure surface). Bare ValueError is intentionally
#     NOT caught — no known raise path, and it would mask programming bugs.
_OCR_FAILURE_EXCEPTIONS = (
    pytesseract.TesseractNotFoundError,
    pytesseract.TesseractError,
    UnidentifiedImageError,
    Image.DecompressionBombError,
    OSError,
)

# Paragraph boundary: a run of 2+ newlines (Tesseract emits single newlines
# between lines, blank lines between blocks). Flat pattern — no nested
# quantifier, so no catastrophic-backtracking surface.
_PARAGRAPH_SPLIT_RE = re.compile(r"\n[ \t]*\n+")


def _allowed_content_types() -> frozenset[str]:
    # Local import-at-use to avoid the api.ocr -> tesseract import cycle
    # (api.ocr.__init__ imports this module transitively via factory.py).
    from api.ocr import OCR_ALLOWED_CONTENT_TYPES

    return OCR_ALLOWED_CONTENT_TYPES


class TesseractOcrAdapter:
    """Local Tesseract OCR; structural implementation of OcrAdapter.

    The fallback engine when Azure DI is unreachable (ADR-0022 A9 un-defers
    D6). Engaged only on outage; quality is lower than Azure prebuilt-layout.
    """

    def __init__(self, *, lang: str = _LANG) -> None:
        self._lang = lang
        # Probed lazily and cached: get_tesseract_version() shells out to the
        # binary, so resolving it at __init__/module scope would crash wherever
        # the binary is absent (factory.py imports this module unconditionally).
        # See code-CR B2.
        self._api_version: str | None = None

    def ocr_bytes(self, data: bytes, content_type: str) -> OcrResult:
        """Run Tesseract on `data`; return OcrResult.

        Raises:
            OcrError("unsupported_content_type") — MIME not in allowlist.
            OcrError("ocr_failed")               — binary missing, undecodable
                image, or any Tesseract failure (recoverable outage).
            OcrError("empty_result")             — whitespace-only extraction.
        """
        if content_type not in _allowed_content_types():
            raise OcrError(
                "unsupported_content_type",
                f"Tesseract adapter does not accept content_type={content_type!r}",
            )
        if not data:
            raise OcrError("empty_result", "Tesseract adapter received zero-byte input")

        try:
            image = Image.open(io.BytesIO(data))
            text = pytesseract.image_to_string(image, lang=self._lang)
        except _OCR_FAILURE_EXCEPTIONS as e:
            raise OcrError("ocr_failed", f"tesseract: {type(e).__name__}: {e}") from e

        paragraphs = _segment_paragraphs(text)
        if not paragraphs:
            raise OcrError("empty_result", "Tesseract returned whitespace-only text")

        # Resolve provenance only after a non-empty result — avoids a wasted
        # get_tesseract_version() subprocess on a blank image. The binary is
        # present here (image_to_string just succeeded), so this won't raise.
        api_version = self._resolve_api_version()

        return OcrResult(
            text="\n\n".join(paragraphs),
            paragraphs=paragraphs,
            confidence=None,  # Per-word confidence (image_to_data) deferred — see A9.
            model=_MODEL,
            api_version=api_version,
        )

    def _resolve_api_version(self) -> str:
        # Only reached after a successful image_to_string, so the binary is
        # present and get_tesseract_version() will not raise.
        if self._api_version is None:
            self._api_version = f"tesseract-{pytesseract.get_tesseract_version()}"
        return self._api_version


def _segment_paragraphs(text: str) -> list[str]:
    """Split OCR text into order-preserving paragraphs on blank-line boundaries.

    Falls back to a single paragraph when the text has no blank-line breaks.
    Empty / whitespace-only segments are dropped.
    """
    blocks = _PARAGRAPH_SPLIT_RE.split(text.strip())
    return [b.strip() for b in blocks if b.strip()]
