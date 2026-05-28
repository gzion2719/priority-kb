"""TesseractOcrAdapter tests — see ADR-0022 A9.

Two layers:
  1. Hermetic error-mapping tests (run everywhere, no native binary): exercise
     the OcrError taxonomy via monkeypatched pytesseract + a real PIL decode.
  2. Real-binary smokes (CI only, @skipif): render text with PIL and round-trip
     it through the actual `tesseract` binary — English (plumbing) + Hebrew
     (proves the `heb` traineddata is installed and Hebrew round-trips). The
     sandbox has no Tesseract, so these run only in the CI python job, which is
     the platform-runtime gate (SESSION_PROTOCOL Platform-runtime-matching).
"""

from __future__ import annotations

import io
import os

import pytesseract
import pytest
from PIL import Image

from api.ocr import OcrError
from api.ocr.tesseract import TesseractOcrAdapter

_PNG = "image/png"


def _blank_png() -> bytes:
    """A valid (decodable) PNG with no text — for monkeypatched-call tests."""
    buf = io.BytesIO()
    Image.new("RGB", (12, 12), "white").save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Layer 1 — hermetic error mapping (no native binary required)
# ---------------------------------------------------------------------------


def test_unsupported_content_type_rejected_before_binary() -> None:
    """A MIME outside the allowlist raises before any binary call."""
    with pytest.raises(OcrError) as exc:
        TesseractOcrAdapter().ocr_bytes(b"whatever", "application/pdf")
    assert exc.value.code == "unsupported_content_type"


def test_zero_byte_input_is_empty_result() -> None:
    with pytest.raises(OcrError) as exc:
        TesseractOcrAdapter().ocr_bytes(b"", _PNG)
    assert exc.value.code == "empty_result"


def test_undecodable_image_maps_to_ocr_failed() -> None:
    """Allowlisted MIME but non-image bytes → PIL UnidentifiedImageError →
    ocr_failed (NOT an escape to HandlerCrashed). Covers code-CR B3/Q4."""
    with pytest.raises(OcrError) as exc:
        TesseractOcrAdapter().ocr_bytes(b"this is not a PNG", _PNG)
    assert exc.value.code == "ocr_failed"


def test_missing_binary_maps_to_ocr_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    """TesseractNotFoundError (binary absent) must map to ocr_failed.

    Negative-assertion for code-CR B3: TesseractNotFoundError is NOT a subclass
    of TesseractError, so a narrow except would let it escape to the worker's
    top-level catch as HandlerCrashed. This pins the explicit catch.
    """

    def _raise_not_found(*_args: object, **_kwargs: object) -> str:
        raise pytesseract.TesseractNotFoundError()

    monkeypatch.setattr(pytesseract, "image_to_string", _raise_not_found)
    with pytest.raises(OcrError) as exc:
        TesseractOcrAdapter().ocr_bytes(_blank_png(), _PNG)
    assert exc.value.code == "ocr_failed"


def test_tesseract_error_maps_to_ocr_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    """A generic TesseractError (e.g. missing language pack) → ocr_failed."""

    def _raise_tess(*_args: object, **_kwargs: object) -> str:
        raise pytesseract.TesseractError(1, "synthetic tesseract failure")

    monkeypatch.setattr(pytesseract, "image_to_string", _raise_tess)
    with pytest.raises(OcrError) as exc:
        TesseractOcrAdapter().ocr_bytes(_blank_png(), _PNG)
    assert exc.value.code == "ocr_failed"


def test_whitespace_only_extraction_is_empty_result(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tesseract returning whitespace-only text → empty_result."""

    def _return_blank(*_args: object, **_kwargs: object) -> str:
        return "   \n  \n\t "

    monkeypatch.setattr(pytesseract, "image_to_string", _return_blank)
    # No get_tesseract_version stub needed: the empty-result check runs BEFORE
    # the api_version probe, so the (absent) binary is never shelled out to.
    with pytest.raises(OcrError) as exc:
        TesseractOcrAdapter().ocr_bytes(_blank_png(), _PNG)
    assert exc.value.code == "empty_result"


def test_result_shape_with_stubbed_tesseract(monkeypatch: pytest.MonkeyPatch) -> None:
    """Happy path with stubbed pytesseract: OcrResult fields + paragraph split.

    Verifies model/api_version provenance and blank-line paragraph segmentation
    without needing the native binary.
    """

    def _two_paragraphs(*_args: object, **_kwargs: object) -> str:
        return "first block line one\nfirst block line two\n\nsecond block"

    monkeypatch.setattr(pytesseract, "image_to_string", _two_paragraphs)
    monkeypatch.setattr(pytesseract, "get_tesseract_version", lambda: "5.3.0")

    result = TesseractOcrAdapter().ocr_bytes(_blank_png(), _PNG)
    assert result.model == "tesseract"
    assert result.api_version == "tesseract-5.3.0"
    assert result.confidence is None
    assert result.paragraphs == ["first block line one\nfirst block line two", "second block"]
    assert result.text == "first block line one\nfirst block line two\n\nsecond block"


# ---------------------------------------------------------------------------
# Layer 2 — real-binary smokes (CI only)
# ---------------------------------------------------------------------------

_FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
)


def _tesseract_available() -> bool:
    try:
        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False


def _find_font() -> str | None:
    return next((p for p in _FONT_CANDIDATES if os.path.exists(p)), None)


_SKIP_REASON = "tesseract binary or a Hebrew-glyph font not available (CI-only smoke)"
_real_ocr = pytest.mark.skipif(
    not _tesseract_available() or _find_font() is None, reason=_SKIP_REASON
)


def _render_png(text: str, *, size: int = 64) -> bytes:
    from PIL import ImageDraw, ImageFont

    font_path = _find_font()
    assert font_path is not None  # guarded by the skipif marker
    font = ImageFont.truetype(font_path, size)
    img = Image.new("RGB", (1000, 220), "white")
    ImageDraw.Draw(img).text((20, 70), text, fill="black", font=font)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@_real_ocr
def test_real_binary_english_round_trip() -> None:
    """End-to-end through the real binary: English text is extracted."""
    out = TesseractOcrAdapter().ocr_bytes(_render_png("HELLO WORLD"), _PNG)
    assert "HELLO" in out.text.upper() or "WORLD" in out.text.upper()
    assert out.model == "tesseract"
    assert out.api_version.startswith("tesseract-")


@_real_ocr
def test_real_binary_hebrew_langpack_round_trips() -> None:
    """The `heb` traineddata is installed and Hebrew round-trips to Hebrew text.

    Asserts the extraction contains at least one Hebrew-block codepoint. If the
    heb pack were absent, lang="heb+eng" would raise inside tesseract →
    ocr_failed → this test fails (it expects a result), so the assertion also
    guards the CI apt install of tesseract-ocr-heb.
    """
    out = TesseractOcrAdapter().ocr_bytes(_render_png("שלום עולם"), _PNG)
    assert any("֐" <= ch <= "׿" for ch in out.text)
