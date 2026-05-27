"""ADR-0021 M2b #5 — PDF + DOCX text extractors for the worker handler.

This package owns the deterministic bytes→str transforms the worker handler
calls before submitting the parsed body back to Node's PUT /api/ingest/[id]
under the Option Y architecture.

Iron-rule footprint (this module surface):
    #2  No public route; called only from the worker handler.
    #6  No sensitivity touched here.
    #8  No live API imports — pypdf + python-docx are pure parsing libraries.
    #9  Does not write chunks; satisfied via Node delegation downstream.
    #10 No agent invocation here.
    #12 Pure CPU; no vendor dependency.

Exported surface:
    parse_pdf(data: bytes) -> str
    parse_docx(data: bytes) -> str
    ParserError — wraps upstream pypdf / python-docx / zipfile exceptions
                  with a stable .code taxonomy so the worker handler can map
                  failures to its WorkerErrorClass enum (PR pair 2).
"""

from __future__ import annotations

from api.parsers.docx import parse_docx
from api.parsers.pdf import parse_pdf
from api.parsers.types import ParserError

__all__ = ["ParserError", "parse_docx", "parse_pdf"]
