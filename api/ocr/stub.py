"""Deterministic stub OCR adapter — see ADR-0022 D5.

Mirrors the `createStubEmbedder` precedent in `lib/embedding.ts`: produces
a deterministic OcrResult derived from input bytes so test assertions can
pin exact paragraph content without monkeypatching.

The stub is the **test-time** fallback. Production-time fallback to
Tesseract when Azure DI is unreachable is a follow-up slice per ADR-0022
D6 — the factory does NOT fall back to the stub when Azure credentials
are present but the call fails (that bubbles `OcrError("ocr_failed")`).
"""

from __future__ import annotations

import hashlib

from api.ocr.types import OcrError, OcrResult

# Image-only allowlist for this increment. PDF routes through parse_pdf
# (ADR-0021); DOCX has no image dispatch yet. Extension requires ADR-0022
# amendment.
_ALLOWED_CONTENT_TYPES: frozenset[str] = frozenset({"image/png", "image/jpeg", "image/webp"})

# Paragraph segmentation knob. The stub splits its synthetic text into
# fixed-width chunks; ≥ 2 paragraphs lets paragraph-aware tests assert on
# segmentation behavior without depending on a hash collision.
_STUB_PARAGRAPH_WIDTH = 32
_STUB_PARAGRAPH_COUNT = 4


class StubOcrAdapter:
    """Deterministic OCR adapter; produces synthetic text from input hash.

    Implements the `OcrAdapter` protocol structurally — no nominal
    inheritance, mirroring Python's duck-typing precedent in the project.
    """

    def ocr_bytes(self, data: bytes, content_type: str) -> OcrResult:
        """Return a deterministic OcrResult for the given bytes.

        Raises:
            OcrError("unsupported_content_type") — MIME not in allowlist.
            OcrError("empty_result")             — zero-byte input.
        """
        if content_type not in _ALLOWED_CONTENT_TYPES:
            raise OcrError(
                "unsupported_content_type",
                f"stub does not accept content_type={content_type!r}",
            )
        if not data:
            raise OcrError("empty_result", "stub received zero-byte input")

        # Hash-derived synthetic text. Hex-encoded sha256 gives 64 chars
        # of stable, content-addressed output — enough to fill the
        # configured 4 × 32 char paragraph layout deterministically.
        digest = hashlib.sha256(data).hexdigest()
        total_width = _STUB_PARAGRAPH_WIDTH * _STUB_PARAGRAPH_COUNT
        # Tile the digest to fill the layout; sha256 hex is 64 chars and the
        # layout is 128. The `+ 1` guards against integer-division truncation
        # if width or count change; the slice trims the over-tile back to
        # exact width. Content-stable for any input.
        tiled = (digest * ((total_width // len(digest)) + 1))[:total_width]
        paragraphs = [
            tiled[i : i + _STUB_PARAGRAPH_WIDTH]
            for i in range(0, total_width, _STUB_PARAGRAPH_WIDTH)
        ]
        text = "\n\n".join(paragraphs)
        return OcrResult(
            text=text,
            paragraphs=paragraphs,
            confidence=None,  # Stub does not synthesize a confidence value.
            model="stub-azure-di",
            api_version="v1",
        )
