"""StubOcrAdapter tests — see ADR-0022.

The stub is the test-time fallback used by every consumer that hasn't
configured Azure. Determinism, allowlist behavior, and error-code
contract are the load-bearing assertions.
"""

from __future__ import annotations

import pytest

from api.ocr import OcrError, OcrResult, StubOcrAdapter


def test_stub_returns_deterministic_result_for_same_bytes() -> None:
    """Same input → same output. Two calls, byte-equal OcrResult."""
    adapter = StubOcrAdapter()
    data = b"the same bytes"
    r1 = adapter.ocr_bytes(data, "image/png")
    r2 = adapter.ocr_bytes(data, "image/png")
    assert r1 == r2


def test_stub_returns_different_text_for_different_bytes() -> None:
    """Different input → different output. Content-addressed sanity check."""
    adapter = StubOcrAdapter()
    r1 = adapter.ocr_bytes(b"input-a", "image/png")
    r2 = adapter.ocr_bytes(b"input-b", "image/png")
    assert r1.text != r2.text
    assert r1.paragraphs != r2.paragraphs


def test_stub_segments_into_multiple_paragraphs() -> None:
    """Stub must return ≥ 2 paragraphs so paragraph-aware tests have signal."""
    adapter = StubOcrAdapter()
    result = adapter.ocr_bytes(b"some bytes", "image/png")
    assert len(result.paragraphs) >= 2
    # text is paragraphs joined by "\n\n" — the join must round-trip.
    assert result.text == "\n\n".join(result.paragraphs)


def test_stub_returns_expected_provenance_fields() -> None:
    """OcrResult.model + api_version are the stub identifiers."""
    adapter = StubOcrAdapter()
    result = adapter.ocr_bytes(b"some bytes", "image/png")
    assert result.model == "stub-azure-di"
    assert result.api_version == "v1"
    # Confidence is intentionally None — the stub does not synthesize one.
    assert result.confidence is None


@pytest.mark.parametrize("content_type", ["image/png", "image/jpeg", "image/webp"])
def test_stub_accepts_allowlisted_image_mimes(content_type: str) -> None:
    """All three allowlisted image MIMEs must pass."""
    adapter = StubOcrAdapter()
    result = adapter.ocr_bytes(b"x", content_type)
    assert isinstance(result, OcrResult)


@pytest.mark.parametrize(
    "content_type",
    [
        "application/pdf",  # PDFs route through parse_pdf, not OCR.
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "text/plain",
        "image/tiff",  # Not in spike's evaluated set; out-of-allowlist.
        "image/gif",
        "",
    ],
)
def test_stub_rejects_unsupported_content_type(content_type: str) -> None:
    """Non-allowlisted MIMEs must raise OcrError('unsupported_content_type').

    Negative-assertion test: matches on the .code field, not just on
    `raises(OcrError)` — a future regression that silently rewrites the
    code label (e.g., to "invalid_mime") would pass `raises` and fail
    here, which is the intent.
    """
    adapter = StubOcrAdapter()
    with pytest.raises(OcrError) as exc_info:
        adapter.ocr_bytes(b"x", content_type)
    assert exc_info.value.code == "unsupported_content_type"


def test_stub_rejects_zero_byte_input() -> None:
    """Empty input is an empty_result, not an unsupported_content_type."""
    adapter = StubOcrAdapter()
    with pytest.raises(OcrError) as exc_info:
        adapter.ocr_bytes(b"", "image/png")
    assert exc_info.value.code == "empty_result"


def test_stub_exposes_ocr_bytes_signature() -> None:
    """StubOcrAdapter exposes the `ocr_bytes` method the factory relies on.

    Smoke check — the structural conformance to `OcrAdapter` (Protocol,
    not @runtime_checkable) is enforced by mypy at typecheck time. This
    test only catches the cruder regression of removing the method
    entirely or renaming it.
    """
    adapter = StubOcrAdapter()
    assert hasattr(adapter, "ocr_bytes")
    assert callable(adapter.ocr_bytes)
