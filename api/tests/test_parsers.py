"""ADR-0021 M2b #5 — parser surface tests.

Covers `api.parsers.parse_pdf` and `api.parsers.parse_docx` against the
committed fixtures in `api/tests/fixtures/`. Fixture generation is
documented in the M2b #5 ADR; regenerate via the reportlab + python-docx
helper script if fixtures need to change.

Iron-rule footprint of this test surface:
    #8 — no live API imports (pypdf + python-docx + zipfile only).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from api.parsers import ParserError, parse_docx, parse_pdf

FIXTURES = Path(__file__).parent / "fixtures"

# Iron rule #8 mirror — `api/parsers/*.py` modules are scanned by the existing
# `test_iron_rule_8_no_live_api_imports.py` floor (which iterates every
# production `api/` module via `API_DIR.rglob("*.py")`). No redundant
# parser-local scan needed here.


# ---------- PDF ----------


def test_parse_pdf_extracts_each_page_in_order() -> None:
    """Three-page PDF — text from page 1, 2, 3 appears in document order."""
    data = (FIXTURES / "sample.pdf").read_bytes()
    text = parse_pdf(data)
    assert isinstance(text, str)
    # All three pages' distinguishing text must appear and in order.
    p1 = text.find("Page one content")
    p2 = text.find("Page two content")
    p3 = text.find("Page three content")
    assert p1 != -1, f"page 1 text missing: {text!r}"
    assert p2 != -1, f"page 2 text missing: {text!r}"
    assert p3 != -1, f"page 3 text missing: {text!r}"
    assert p1 < p2 < p3, f"page order broken: {p1} {p2} {p3} in {text!r}"


def test_parse_pdf_empty_pages_returns_no_text() -> None:
    """Blank-page PDF returns empty-ish string (no extractable text)."""
    data = (FIXTURES / "sample-empty.pdf").read_bytes()
    text = parse_pdf(data)
    assert isinstance(text, str)
    # Empty page may produce only whitespace / page separator; the worker
    # handler treats len(text.strip())==0 as ParseEmpty.
    assert text.strip() == "", f"expected empty result, got {text!r}"


def test_parse_pdf_encrypted_raises_encrypted_code() -> None:
    """Password-protected PDF raises ParserError with stable code."""
    data = (FIXTURES / "sample-encrypted.pdf").read_bytes()
    with pytest.raises(ParserError) as exc:
        parse_pdf(data)
    # Distinguish encrypted from corrupt — dropping the is_encrypted check
    # would surface FileNotDecryptedError ("not decrypted" suggests we
    # tried) and a different code; the test would then fail with a
    # mismatched code, not pass with the wrong reason. This makes the
    # check non-tautological per WORKFLOW.md "Negative-assertion tests
    # distinguish from the regression."
    assert exc.value.code == "encrypted", f"unexpected code: {exc.value.code}"


def test_parse_pdf_corrupt_bytes_raises_corrupt_code() -> None:
    """Random non-PDF bytes raise ParserError('corrupt')."""
    with pytest.raises(ParserError) as exc:
        parse_pdf(b"not a pdf at all, just some random bytes")
    assert exc.value.code == "corrupt"


def test_parse_pdf_empty_bytes_raises_empty_file_code() -> None:
    """Zero-length input raises ParserError('empty_file').

    This is a distinct code from `"corrupt"` because the worker handler
    may want to dashboard empty-file uploads separately (upload form bug
    vs adversarial corruption attempt).
    """
    with pytest.raises(ParserError) as exc:
        parse_pdf(b"")
    assert exc.value.code == "empty_file"


def test_parse_pdf_returns_str_not_bytes() -> None:
    data = (FIXTURES / "sample.pdf").read_bytes()
    result = parse_pdf(data)
    assert isinstance(result, str), f"expected str, got {type(result).__name__}"


# ---------- DOCX ----------


def test_parse_docx_extracts_paragraphs_and_table_cells() -> None:
    """Document with 2 paragraphs + 1 two-cell table — all surfaces extracted."""
    data = (FIXTURES / "sample.docx").read_bytes()
    text = parse_docx(data)
    assert isinstance(text, str)
    assert "First paragraph English" in text
    assert "Second paragraph content" in text
    assert "Cell A" in text
    assert "Cell B" in text


def test_parse_docx_preserves_hebrew_and_bidirectional_text() -> None:
    """Hebrew + mixed bidirectional paragraphs survive byte-for-byte.

    DOCX text comes from the document XML, so RTL runs and mixed bidi
    are preserved without reordering. (PDF Hebrew is a separate concern —
    see api/parsers/pdf.py module docstring; covered by M2b #6 OCR path.)
    """
    data = (FIXTURES / "sample-hebrew.docx").read_bytes()
    text = parse_docx(data)
    assert "English heading" in text
    assert "שלום עולם" in text
    assert "hello שלום world" in text


def test_parse_docx_empty_document_returns_empty_string() -> None:
    """Empty doc (no paragraphs, no tables) → empty string."""
    data = (FIXTURES / "sample-empty.docx").read_bytes()
    text = parse_docx(data)
    assert text == "", f"expected empty string, got {text!r}"


def test_parse_docx_corrupt_bytes_raises_corrupt_code() -> None:
    """Random non-zip bytes raise ParserError('corrupt')."""
    with pytest.raises(ParserError) as exc:
        parse_docx(b"not a docx, not even a zip")
    assert exc.value.code == "corrupt"


def test_parse_docx_returns_str_not_bytes() -> None:
    data = (FIXTURES / "sample.docx").read_bytes()
    result = parse_docx(data)
    assert isinstance(result, str), f"expected str, got {type(result).__name__}"


# ---------- ParserError contract ----------


def test_parser_error_carries_code_attribute() -> None:
    """`ParserError` exposes a `.code` string for downstream taxonomy mapping.

    Per ADR-0021, the worker handler maps `.code` → `WorkerErrorClass`
    without parsing exception messages. The contract test is
    non-tautological because a hypothetical regression (renaming `.code`
    to `.error_code` or losing the attribute entirely) would fail here
    rather than at the worker-handler integration test surface.
    """
    err = ParserError("encrypted", "PDF is password-protected")
    assert err.code == "encrypted"
    assert "PDF is password-protected" in str(err)
    # Allows the worker handler's `except ParserError` to type-narrow.
    assert isinstance(err, Exception)


def test_parser_error_code_is_only_param_required() -> None:
    """Message defaults to the code itself when omitted."""
    err = ParserError("corrupt")
    assert err.code == "corrupt"
    assert str(err) == "corrupt"
