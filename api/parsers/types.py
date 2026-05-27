"""Shared exception type for the parser surface.

Lives in its own module to keep the `api.parsers.pdf` and `api.parsers.docx`
modules importable without cycling through `__init__`.
"""

from __future__ import annotations


class ParserError(Exception):
    """Failure raised by `parse_pdf` / `parse_docx`.

    `code` is a short stable label so the worker handler can map it to the
    `WorkerErrorClass` taxonomy (PR pair 2) without parsing the message.

    Stable codes (extend only via ADR amendment to keep dashboards stable):
        "encrypted"  — PDF is password-protected; pypdf cannot extract text.
        "corrupt"    — bytes are not a valid PDF / DOCX (wraps PdfReadError,
                       BadZipFile, PackageNotFoundError, etc.).
        "empty_file" — zero-byte or sentinel-byte input where the parser
                       cannot construct a reader at all.
    """

    def __init__(self, code: str, message: str | None = None) -> None:
        super().__init__(message or code)
        self.code = code
