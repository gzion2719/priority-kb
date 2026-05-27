"""PDF text extraction via pypdf.

Pure CPU; no DB, no network, no agent (iron rules #8, #9, #10 inapplicable).
Concatenates per-page text with `\\n\\n` separators preserving page order.

Failure modes mapped to `ParserError.code`:
    - Encrypted PDFs → `"encrypted"` (caught from `reader.is_encrypted` check
      so we never trip `FileNotDecryptedError` from `extract_text`).
    - Corrupt / truncated PDFs → `"corrupt"` (wraps `PdfReadError` family).
    - Empty input bytes → `"empty_file"` (wraps `EmptyFileError`).

Hebrew PDF handling is intentionally NOT asserted as a happy path here.
Real Priority Hebrew PDFs are typically image-based screenshot exports
without ToUnicode mappings — pypdf returns `(cid:NNN)` glyph tokens on
those rather than real text. The M2b #6 OCR pipeline (Azure Document
Intelligence) is the canonical Hebrew-PDF path; this module's PDF support
covers the text-extractable subset only. See ADR-0021 §"Out of scope" for
the cross-handler routing rationale.
"""

from __future__ import annotations

import io

import pypdf
from pypdf.errors import EmptyFileError, PdfReadError

from api.parsers.types import ParserError


def parse_pdf(data: bytes) -> str:
    """Extract text from a PDF byte buffer.

    Returns the concatenated text of all pages, separated by `\\n\\n`.
    A PDF whose pages contain no extractable text (e.g., image-only
    scans) returns `""` — the worker handler maps this to
    `WorkerErrorClass.ParseEmpty` and marks the job failed so an admin
    can re-upload with OCR.

    Raises:
        ParserError("encrypted") — PDF is password-protected.
        ParserError("corrupt")   — bytes are not a valid PDF.
        ParserError("empty_file") — bytes are zero-length.
    """
    try:
        reader = pypdf.PdfReader(io.BytesIO(data))
    except EmptyFileError as e:
        raise ParserError("empty_file", str(e)) from e
    except PdfReadError as e:
        raise ParserError("corrupt", str(e)) from e

    # Check encryption flag BEFORE extracting — `extract_text` on an
    # encrypted reader raises FileNotDecryptedError, which is misleading
    # ("not decrypted" implies we tried; we didn't). The flag-check produces
    # a clearer failure code.
    if reader.is_encrypted:
        raise ParserError("encrypted", "PDF is password-protected")

    parts: list[str] = []
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except PdfReadError as e:
            # Per-page extraction can fail on a malformed content stream
            # even when the catalog is intact. Surface as corrupt rather
            # than partial silent dropping.
            raise ParserError("corrupt", f"page extract failed: {e}") from e
        parts.append(text)

    return "\n\n".join(parts)
