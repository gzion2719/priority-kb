"""M2b #10 — synthetic-fixture media-ingestion smoke (development-stage).

Exercises the full media pipeline end-to-end against a LIVE local stack:

    POST /api/ingest/upload (admin)             # placeholder entry + queued job
      -> python -m api.worker claims the job
        -> parse_pdf / stub-OCR                 # body text
          -> PUT /api/ingest/<id> (worker, admin header)
            -> updateEntry: entries_versions v2 + re-chunk + re-embed (stub)
    POST /api/retrieve (user)                   # entry surfaces in `candidates`

This is a *pipeline-wiring* smoke, NOT a retrieval-quality measurement:
  - No Azure creds -> the OCR adapter is the STUB (deterministic hash text),
    so the PNG leg proves OCR *dispatch + worker wiring* only. The PDF leg
    (real `parse_pdf`) is the meaningful, keyword-retrievable target.
  - The stub embedder + stub reranker are not semantic, AND the stub
    synthesizer cites a sentinel UUID that fails citation-validation -> the
    retrieve terminal event is `chunks_only` / `citation_validation_failed`,
    which is the EXPECTED stub outcome, not a failure. The pass signal is
    "the entry appears in the `candidates` event" (fed by the deterministic
    keyword lane), not "done.citation_ids contains it" (structurally always
    empty under the stub synth) and not a semantic top-3 rank.
  Semantic top-3 / recall stays gated on the real Voyage embedder, exactly
  as M3 Acceptance already states. Real-data smoke is deferred to the
  production-stage transition gate (ADR-0011 Amendment 2026-05-27).

Prerequisites (see docs/runbooks/media-smoke.md for the full sequence):
  - docker compose up -d  (Postgres + pgvector healthy)
  - npm run db:migrate
  - npm run dev            (Next on :3000)
  - python -m api.worker   (with BLOB_STORAGE_DIR + INGEST_API_BASE_URL +
                            DATABASE_URL exported into ITS process env;
                            the worker does NOT read .env.local)

Usage:
  python scripts/media_smoke.py \
      --base-url http://localhost:3000 \
      --database-url "<DATABASE_URL>"

Exit 0 = both legs passed. Non-zero = a leg failed (job failed/dead, upload
rejected, or the entry never reached the candidates set).
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
import time
import zlib
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import httpx
import psycopg

# A distinctive bareword present verbatim in the PDF body. The keyword lane
# (`websearch_to_tsquery('simple', unaccent(...))`) does not stem, so the
# query token must appear EXACTLY in the stored body. "requisition" tokenizes
# to {requisition} and the seed body contains it as a standalone word; the
# keyword lane therefore guarantees the PDF entry enters the candidate set
# regardless of the non-semantic stub embedding. (WORKFLOW.md
# Production-tokenization-mirror sub-rule.)
PDF_QUERY_TOKEN = "requisition"


# --------------------------------------------------------------------------
# Fixture generation
# --------------------------------------------------------------------------
def _hebrew_font_name() -> str | None:
    """Register a Hebrew-capable TTF from the Windows font dir if present.

    Hebrew RTL glyph SHAPING in reportlab is unreliable, but `parse_pdf`
    extracts the embedded Unicode codepoints regardless of visual order, so
    an unshaped Hebrew run is still extractable. Best-effort: if no Hebrew
    font is found we fall back to English-only (the smoke does not depend on
    Hebrew extraction — the English `PDF_QUERY_TOKEN` is the assertion).
    """
    from reportlab.pdfbase import pdfmetrics  # type: ignore[import-untyped]
    from reportlab.pdfbase.ttfonts import TTFont  # type: ignore[import-untyped]

    candidates = [
        r"C:\Windows\Fonts\arial.ttf",
        r"C:\Windows\Fonts\david.ttf",
        r"C:\Windows\Fonts\tahoma.ttf",
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                pdfmetrics.registerFont(TTFont("HebrewSmoke", path))
                return "HebrewSmoke"
            except Exception:
                continue
    return None


def generate_pdf(path: Path, nonce: str) -> None:
    """Write a 5-page synthetic Priority-shaped PDF.

    English-primary (guaranteed extractable). A Hebrew section is added
    best-effort if a Hebrew-capable font registers.
    """
    from reportlab.lib.pagesizes import A4  # type: ignore[import-untyped]
    from reportlab.pdfgen import canvas  # type: ignore[import-untyped]

    heb_font = _hebrew_font_name()

    pages_en = [
        (
            "Priority ERP — Purchase Requisition Workflow (synthetic fixture)",
            [
                f"Synthetic smoke fixture. Run nonce: {nonce}.",
                "This document describes the standard purchase requisition",
                "approval flow in Priority ERP. A requisition is raised by a",
                "department, routed through approval stages, and converted to a",
                "purchase order once fully approved.",
                "The requisition form (PORDERS) carries the requester, cost",
                "center, and line items. Each line references a catalog part.",
            ],
        ),
        (
            "Stage 1 — Raising a requisition",
            [
                "Open Procurement > Purchase Requisitions > New Requisition.",
                "Select the requesting department and cost center. Add one line",
                "per part with quantity and required-by date.",
                "Save the requisition to assign it a running number. The status",
                "is set to 'Draft' until submitted for approval.",
            ],
        ),
        (
            "Stage 2 — Approval routing",
            [
                "Submitting a requisition routes it to the approval matrix",
                "defined for the cost center. Approvers act in sequence; a",
                "rejection at any stage returns the requisition to the",
                "requester with the rejection note.",
                "Approval thresholds are amount-based: lines above the cost",
                "center limit escalate to the next approver tier.",
            ],
        ),
        (
            "Stage 3 — Conversion to a purchase order",
            [
                "A fully approved requisition can be converted to a purchase",
                "order. Priority preserves the requisition-to-order link so the",
                "audit trail from requisition through receipt is reproducible.",
                "Partial conversion is allowed: some lines become an order now,",
                "the remainder stay open for a later order.",
            ],
        ),
        (
            "Common pitfalls and reconciliation",
            [
                "A requisition stuck 'Pending Approval' usually means an",
                "approver tier has no active user assigned in the matrix.",
                "Reconcile open requisitions monthly against open purchase",
                "orders to catch lines that were approved but never converted.",
                "Do not delete a converted requisition — the order link breaks",
                "the procurement audit trail.",
            ],
        ),
    ]

    heb_lines = [
        "נספח עברית (אופציונלי): בקשת רכש בפריוריטי.",
        "בקשת רכש מנותבת דרך מטריצת אישורים והופכת להזמנת רכש.",
    ]

    c = canvas.Canvas(str(path), pagesize=A4)
    width, height = A4
    for title, body_lines in pages_en:
        y = height - 60
        c.setFont("Helvetica-Bold", 14)
        c.drawString(50, y, title)
        y -= 30
        c.setFont("Helvetica", 11)
        for line in body_lines:
            c.drawString(50, y, line)
            y -= 18
        if heb_font is not None:
            y -= 12
            c.setFont(heb_font, 11)
            for line in heb_lines:
                c.drawString(50, y, line)
                y -= 18
        c.showPage()
    c.save()


def generate_png(path: Path, nonce: str) -> None:
    """Write a small valid 8x8 PNG (stub OCR ignores pixel content).

    The `nonce` is embedded as a PNG `tEXt` chunk so each run produces unique
    bytes → a unique content hash → a fresh upload job. Without it, a
    byte-identical PNG re-run against a persisted DB would dedupe on
    `idempotencyKey: contentHash` and orphan a fresh placeholder entry at v1.
    """
    width = height = 8
    raw = b""
    for _ in range(height):
        raw += b"\x00" + bytes([200, 200, 200] * width)  # filter byte + RGB row
    compressed = zlib.compress(raw, 9)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit RGB
    # tEXt chunk: keyword "smoke-nonce" + NUL + value. Per-run-unique bytes.
    text_data = b"smoke-nonce\x00" + nonce.encode("ascii")
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"tEXt", text_data)
        + chunk(b"IDAT", compressed)
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


# --------------------------------------------------------------------------
# Pipeline steps
# --------------------------------------------------------------------------
@dataclass
class UploadResult:
    entry_id: str
    job_id: str
    created: bool
    blob_storage_path: str


def upload(
    client: httpx.Client,
    base_url: str,
    file_path: Path,
    content_type: str,
    metadata: Mapping[str, object],
) -> UploadResult:
    with file_path.open("rb") as fh:
        resp = client.post(
            f"{base_url}/api/ingest/upload",
            headers={"x-stub-user-role": "admin"},
            files={"file": (file_path.name, fh, content_type)},
            data={"metadata": json.dumps(metadata)},
        )
    if resp.status_code != 201:
        raise SystemExit(
            f"FAIL upload {file_path.name}: HTTP {resp.status_code}: {resp.text[:500]}"
        )
    body = resp.json()
    return UploadResult(
        entry_id=body["entry_id"],
        job_id=body["job_id"],
        created=bool(body.get("created", True)),
        blob_storage_path=body.get("blob_storage_path", ""),
    )


def poll_job(database_url: str, job_id: str, timeout_s: float = 120.0) -> dict[str, object]:
    """Bounded poll. Returns the row dict on `done`; raises on failed/dead/timeout."""
    deadline = time.monotonic() + timeout_s
    last_state = None
    while time.monotonic() < deadline:
        with psycopg.connect(database_url) as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT state, attempts, last_error, locked_by FROM jobs WHERE id = %s",
                (job_id,),
            )
            row = cur.fetchone()
        if row is None:
            raise SystemExit(f"FAIL poll: job {job_id} not found")
        state, attempts, last_error, locked_by = row
        if state != last_state:
            print(
                f"    job {job_id[:8]} -> state={state} attempts={attempts} locked_by={locked_by}"
            )
            last_state = state
        if state == "done":
            return {"state": state, "attempts": attempts, "locked_by": locked_by}
        if state in ("failed", "dead"):
            raise SystemExit(
                f"FAIL poll: job {job_id} reached state={state} "
                f"attempts={attempts} last_error={last_error}"
            )
        time.sleep(1.5)
    raise SystemExit(
        f"FAIL poll: job {job_id} still '{last_state}' after {timeout_s}s "
        f"(is the worker running with all 3 env vars exported into ITS process?)"
    )


@dataclass
class RetrieveResult:
    candidate_ids: list[str] = field(default_factory=list)
    chunks_only_ids: list[str] = field(default_factory=list)
    terminal_kind: str | None = None
    terminal_payload: dict[str, object] | None = None


def retrieve(client: httpx.Client, base_url: str, query: str) -> RetrieveResult:
    """POST /api/retrieve as `user`; parse the SSE stream."""
    result = RetrieveResult()
    with client.stream(
        "POST",
        f"{base_url}/api/retrieve",
        headers={"x-stub-user-role": "user"},
        json={"query": query},
    ) as resp:
        if resp.status_code != 200:
            body = resp.read().decode("utf-8", "replace")
            raise SystemExit(f"FAIL retrieve: HTTP {resp.status_code}: {body[:500]}")
        for line in resp.iter_lines():
            if not line or not line.startswith("data: "):
                continue  # skip ': keepalive' comments + blank separators
            try:
                ev = json.loads(line[len("data: ") :])
            except json.JSONDecodeError:
                continue
            kind = ev.get("kind")
            if kind == "candidates":
                result.candidate_ids = [e["entry_id"] for e in ev.get("entries", [])]
            elif kind in ("done", "chunks_only", "no_content", "error"):
                result.terminal_kind = kind
                result.terminal_payload = ev
                if kind == "chunks_only":
                    result.chunks_only_ids = [e["entry_id"] for e in ev.get("entries", [])]
    return result


@dataclass
class Evidence:
    versions: list[tuple[int, int]]  # (version_no, body_len)
    chunk_count: int
    embedding_model: str | None
    embedding_version: str | None
    entry_audit: list[tuple[str, str | None]]  # (kind, worker_id)
    job_audit: list[str]  # kinds, in occurred order


def sql_evidence(database_url: str, entry_id: str, job_id: str) -> Evidence:
    """Collect the M2b Acceptance evidence for one entry."""
    with psycopg.connect(database_url) as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT version_no, length(body) FROM entries_versions "
            "WHERE entry_id = %s ORDER BY version_no",
            (entry_id,),
        )
        versions = [(int(r[0]), int(r[1])) for r in cur.fetchall()]
        cur.execute(
            "SELECT count(*), min(embedding_model), min(embedding_version) "
            "FROM chunks WHERE entry_id = %s",
            (entry_id,),
        )
        chunk_row = cur.fetchone()
        assert chunk_row is not None  # COUNT(*) always returns one row
        chunk_count, emb_model, emb_version = chunk_row
        # audit_log carries entry_id as a top-level FK column (not in payload);
        # worker attribution lives in payload.worker_id. occurred_at is the
        # timestamp column (verified against the live schema 2026-05-29).
        cur.execute(
            "SELECT kind, payload->>'worker_id' FROM audit_log "
            "WHERE entry_id = %s ORDER BY occurred_at",
            (entry_id,),
        )
        entry_audit = [(str(r[0]), r[1]) for r in cur.fetchall()]
        # Job-lifecycle rows (job_enqueued/job_dispatched/job_done) carry
        # job_id in payload only, no entry_id FK (reviewer m4).
        cur.execute(
            "SELECT kind FROM audit_log WHERE payload->>'job_id' = %s ORDER BY occurred_at",
            (job_id,),
        )
        job_audit = [str(r[0]) for r in cur.fetchall()]
    return Evidence(
        versions=versions,
        chunk_count=int(chunk_count),
        embedding_model=emb_model,
        embedding_version=emb_version,
        entry_audit=entry_audit,
        job_audit=job_audit,
    )


# --------------------------------------------------------------------------
# Orchestration
# --------------------------------------------------------------------------
def run_leg(
    *,
    label: str,
    client: httpx.Client,
    base_url: str,
    database_url: str,
    file_path: Path,
    content_type: str,
    metadata: Mapping[str, object],
    assert_query: str | None,
) -> bool:
    print(f"\n=== LEG: {label} ===")
    up = upload(client, base_url, file_path, content_type, metadata)
    print(f"  uploaded -> entry_id={up.entry_id} job_id={up.job_id} created={up.created}")
    poll_job(database_url, up.job_id)
    ev = sql_evidence(database_url, up.entry_id, up.job_id)
    print(f"  entries_versions: {ev.versions}  (expect v2 after worker PUT)")
    print(
        f"  chunks: count={ev.chunk_count} model={ev.embedding_model} "
        f"version={ev.embedding_version}"
    )
    print(f"  audit (entry): {ev.entry_audit}")
    print(f"  audit (job):   {ev.job_audit}")

    ok = True
    version_nos = [v[0] for v in ev.versions]
    if max(version_nos, default=0) < 2:
        print("  FAIL: expected entries_versions v2 (placeholder v1 + worker PUT v2)")
        ok = False
    if ev.chunk_count < 1 or not ev.embedding_model:
        print("  FAIL: expected >=1 re-embedded chunk with embedding_model/version")
        ok = False

    if assert_query is not None:
        r = retrieve(client, base_url, assert_query)
        in_cand = up.entry_id in r.candidate_ids
        in_chunks = up.entry_id in r.chunks_only_ids
        print(
            f"  retrieve('{assert_query}') terminal={r.terminal_kind} "
            f"candidates={len(r.candidate_ids)} entry_in_candidates={in_cand}"
        )
        # `chunks_only` / `citation_validation_failed` is the EXPECTED stub
        # terminal; the pass signal is candidate-set membership.
        if not (in_cand or in_chunks):
            print(f"  FAIL: entry {up.entry_id} not in candidates/chunks_only set")
            ok = False
    print(f"  LEG {label}: {'PASS' if ok else 'FAIL'}")
    return ok


def main() -> int:
    # Windows consoles default to cp1252; force UTF-8 so any non-ASCII in
    # output (entry titles, future markers) can't raise UnicodeEncodeError.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(description="M2b #10 media-ingestion smoke")
    ap.add_argument("--base-url", default="http://localhost:3000")
    ap.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    ap.add_argument("--out-dir", default="./.smoke-fixtures")
    ap.add_argument("--nonce", default=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"))
    args = ap.parse_args()

    if not args.database_url:
        print("FAIL: --database-url or DATABASE_URL env required")
        return 1

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    pdf_path = out / "priority-requisition.pdf"
    png_path = out / "priority-screenshot.png"
    print(f"Generating fixtures (nonce={args.nonce}) ...")
    generate_pdf(pdf_path, args.nonce)
    generate_png(png_path, args.nonce)
    print(f"  PDF={pdf_path} ({pdf_path.stat().st_size} bytes)")
    print(f"  PNG={png_path} ({png_path.stat().st_size} bytes)")

    last_verified = "2026-05-20T00:00:00Z"  # safely past — clears the now+24h cap
    pdf_meta = {
        "title": "Synthetic Priority purchase-requisition workflow (PDF smoke)",
        "category": "procedural",
        "tags": ["procurement", "requisition", "smoke"],
        "source_pointer": f"synthetic-fixture-2026-05-29-media-smoke-pdf-{args.nonce}",
        "last_verified_at": last_verified,
        "sensitivity": "internal",
    }
    png_meta = {
        "title": "Synthetic Priority screenshot (PNG OCR-dispatch smoke)",
        "category": "diagnostic",
        "tags": ["screenshot", "ocr", "smoke"],
        "source_pointer": f"synthetic-fixture-2026-05-29-media-smoke-png-{args.nonce}",
        "last_verified_at": last_verified,
        "sensitivity": "internal",
    }

    with httpx.Client(timeout=60.0) as client:
        pdf_ok = run_leg(
            label="PDF (parse_pdf, keyword-retrievable)",
            client=client,
            base_url=args.base_url,
            database_url=args.database_url,
            file_path=pdf_path,
            content_type="application/pdf",
            metadata=pdf_meta,
            assert_query=PDF_QUERY_TOKEN,
        )
        png_ok = run_leg(
            label="PNG (stub-OCR dispatch + worker wiring)",
            client=client,
            base_url=args.base_url,
            database_url=args.database_url,
            file_path=png_path,
            content_type="image/png",
            metadata=png_meta,
            assert_query=None,  # stub-OCR body is hash text — wiring-only leg
        )

    print(f"\n=== SMOKE RESULT: {'PASS' if (pdf_ok and png_ok) else 'FAIL'} ===")
    return 0 if (pdf_ok and png_ok) else 1


if __name__ == "__main__":
    sys.exit(main())
