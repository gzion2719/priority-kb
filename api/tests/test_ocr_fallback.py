"""FallbackOcrAdapter chain tests — see ADR-0022 A9.

Exercises the primary-then-fallback logic with hermetic fake adapters (no
native binary, no SDK). The fallback fires ONLY on OcrError code "ocr_failed";
deterministic outcomes (unsupported_content_type / empty_result) are re-raised
without retry.
"""

from __future__ import annotations

import logging

import pytest

from api.ocr import FallbackOcrAdapter, OcrError, OcrResult

_PNG = "image/png"


def _result(model: str) -> OcrResult:
    return OcrResult(
        text="hello",
        paragraphs=["hello"],
        confidence=None,
        model=model,
        api_version="v1",
    )


class _OkAdapter:
    """Records whether it was called; returns a tagged OcrResult."""

    def __init__(self, model: str) -> None:
        self.model = model
        self.called = False

    def ocr_bytes(self, data: bytes, content_type: str) -> OcrResult:
        self.called = True
        return _result(self.model)


class _RaisingAdapter:
    """Raises a fixed OcrError; records whether it was called."""

    def __init__(self, code: str) -> None:
        self.code = code
        self.called = False

    def ocr_bytes(self, data: bytes, content_type: str) -> OcrResult:
        self.called = True
        raise OcrError(self.code, f"boom: {self.code}")


def test_primary_success_does_not_call_fallback() -> None:
    """Happy path: primary returns → fallback is never touched."""
    primary = _OkAdapter("azure")
    fallback = _OkAdapter("tesseract")
    chain = FallbackOcrAdapter(primary=primary, fallback=fallback)

    out = chain.ocr_bytes(b"data", _PNG)

    assert out.model == "azure"
    assert primary.called
    assert not fallback.called


def test_primary_ocr_failed_engages_fallback() -> None:
    """Outage: primary raises ocr_failed → fallback serves the result."""
    primary = _RaisingAdapter("ocr_failed")
    fallback = _OkAdapter("tesseract")
    chain = FallbackOcrAdapter(primary=primary, fallback=fallback)

    out = chain.ocr_bytes(b"data", _PNG)

    assert out.model == "tesseract"
    assert primary.called
    assert fallback.called


@pytest.mark.parametrize("code", ["unsupported_content_type", "empty_result"])
def test_deterministic_outcomes_do_not_engage_fallback(code: str) -> None:
    """Non-outage OcrError codes are re-raised verbatim, fallback untouched.

    Negative-assertion: if the trigger were "any OcrError" rather than
    "ocr_failed only", the fallback would be called here and the assertion on
    `fallback.called` would flip.
    """
    primary = _RaisingAdapter(code)
    fallback = _OkAdapter("tesseract")
    chain = FallbackOcrAdapter(primary=primary, fallback=fallback)

    with pytest.raises(OcrError) as exc:
        chain.ocr_bytes(b"data", _PNG)

    assert exc.value.code == code
    assert primary.called
    assert not fallback.called


def test_both_fail_raises_fallback_error() -> None:
    """Primary ocr_failed + fallback ocr_failed → terminal OcrError raised.

    The fallback's error is what propagates (the primary's is logged). Net
    shape matches the handler's existing mark_failed(OcrFailed) mapping.
    """
    primary = _RaisingAdapter("ocr_failed")
    fallback = _RaisingAdapter("ocr_failed")
    chain = FallbackOcrAdapter(primary=primary, fallback=fallback)

    with pytest.raises(OcrError) as exc:
        chain.ocr_bytes(b"data", _PNG)

    assert exc.value.code == "ocr_failed"
    assert primary.called
    assert fallback.called


def test_fallback_engagement_emits_warn_signal(caplog: pytest.LogCaptureFixture) -> None:
    """Operator signal: engaging the fallback logs a stable greppable prefix."""
    primary = _RaisingAdapter("ocr_failed")
    fallback = _OkAdapter("tesseract")
    chain = FallbackOcrAdapter(primary=primary, fallback=fallback)

    with caplog.at_level(logging.WARNING):
        chain.ocr_bytes(b"data", _PNG)

    assert any("ocr_fallback_engaged:" in r.message for r in caplog.records)


def test_primary_and_fallback_property_accessors() -> None:
    """The chain exposes its legs (used by the factory wiring test + ops)."""
    primary = _OkAdapter("azure")
    fallback = _OkAdapter("tesseract")
    chain = FallbackOcrAdapter(primary=primary, fallback=fallback)

    assert chain.primary is primary
    assert chain.fallback is fallback
