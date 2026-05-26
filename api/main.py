"""FastAPI worker entry point — scaffold for M2b ingestion / OCR / embedding jobs.

This module is the M2b #2 scaffold; subsequent M2b items add the job queue
(item 3), file upload + blob storage (item 4), document parsing (item 5),
OCR pipeline (item 6), image processing (item 7), and stronger PII scrub
(item 8). See ``docs/ROADMAP.md`` §M2b.
"""

from __future__ import annotations

from fastapi import FastAPI

from api.log import init_logging

init_logging()

app = FastAPI(title="priority-kb-api", version="0.0.1")


@app.get("/healthz")
def healthz() -> dict[str, object]:
    """Liveness endpoint. No DB, no SDK, no auth.

    Returns a stable shape so a smoke test (``curl /healthz``) confirms
    the worker is running without exercising any downstream dependency.
    """
    return {"ok": True, "service": "priority-kb-api"}
