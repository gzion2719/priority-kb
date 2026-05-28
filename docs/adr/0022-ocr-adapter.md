# ADR-0022 — OCR adapter: Azure Document Intelligence + stub-by-default factory (M2b #6)

**Status:** Accepted (M2b #6, first increment).

## Context

[ROADMAP M2b #6](../ROADMAP.md) ships the OCR pipeline that lifts Hebrew text out
of Priority screenshots and image-only PDFs. [ADR-0021 §"Out of scope"](0021-worker-http-callback-architecture.md)
already routes image-PDFs and DOCX-with-images here, since
[api/parsers/pdf.py](../../api/parsers/pdf.py) returns `""` on those (pypdf
cannot extract text without ToUnicode mappings).

The vendor decision was empirically settled at M1 L21 — see
[docs/spikes/hebrew-ocr-spike.md](../spikes/hebrew-ocr-spike.md) +
[docs/BACKLOG.md:52-65](../BACKLOG.md). Azure Document Intelligence v4.0
(api-version `2024-11-30`) was scored on 5 stratified Priority screenshots
against the 4 acceptance criteria: **PASSED 2026-05-20** on all four
(recall, confidence, RTL preservation, label-value adjacency).
`prebuilt-layout` won over `prebuilt-read` on slightly higher confidence on
every image plus paragraph-level structure that the chunker can use.

This ADR is the **first increment** of M2b #6. It ships the adapter module,
contract, factory, and tests. It does **not** ship:

- Worker handler dispatch for image content-types (next slice).
- The `WorkerErrorClass` taxonomy extension for OCR codes (next slice — lands
  with the worker wiring).
- The Tesseract fallback that completes iron-rule #12 wiring (deferred).
- A real Azure DI smoke against user-supplied credentials (production
  validation; next slice).
- MIME-allowlist edits to [app/api/ingest/upload/route.ts](../../app/api/ingest/upload/route.ts)
  (PNG/JPEG/WEBP/PDF already allowed at lines 78-81; DOCX absence is a
  separate drift, tracked outside this ADR).

## Decision

### D1 — Adapter Protocol + frozen `OcrResult` (type skeleton)

```python
# api/ocr/types.py
@dataclass(frozen=True, slots=True)
class OcrResult:
    text: str               # All paragraphs joined by "\n\n".
    paragraphs: list[str]   # Order-preserving paragraph segmentation.
    confidence: float | None  # Mean confidence across paragraphs, [0, 1]; None if N/A.
    model: str              # "prebuilt-layout" | "stub-azure-di".
    api_version: str        # "2024-11-30" for Azure; "v1" for stub.

class OcrError(Exception):
    """Mirrors ParserError shape. __init__(code, message=None); self.code = code."""

class OcrAdapter(Protocol):
    def ocr_bytes(self, data: bytes, content_type: str) -> OcrResult: ...
```

`OcrResult.paragraphs` is `list[str]` for this increment. M2b #7
(image processing — caption extraction + region-attributed chunks) will
amend the contract to add an optional `regions: list[BoundingRegion] | None`
field; the amendment is **expected** and is not a contract churn surprise.

### D2 — `OcrError` stable code taxonomy

```
"unsupported_content_type"  — caller passed a MIME outside the adapter's allowlist.
"ocr_failed"                — vendor SDK raised; Azure outage, transient 5xx,
                              or a credential/quota error. Worker handler will
                              map to mark_failed in the next slice.
"empty_result"              — vendor returned 0 paragraphs / empty content.
                              Likely a blank image or all-non-text glyphs.
```

Constructor mirrors `ParserError` ([api/parsers/types.py:24-26](../../api/parsers/types.py)):

```python
def __init__(self, code: str, message: str | None = None) -> None:
    super().__init__(message or code)
    self.code = code
```

Codes extend **only via ADR amendment** to keep dashboards stable.

### D3 — Content-type allowlist: images only

This increment's allowlist is **PNG, JPEG, WEBP**. PDFs continue routing
through [parse_pdf](../../api/parsers/pdf.py) per ADR-0021. An image-only
PDF that returned `""` from `parse_pdf` will eventually round-trip through
this adapter via the next slice's worker dispatch + re-OCR path; that
routing is **not** in this ADR.

`OcrError("unsupported_content_type")` fires for any MIME outside the
allowlist. Codified now so the next-slice worker handler can rely on the
adapter to reject rather than silently mis-parse.

### D4 — Azure DI configuration (sealed at module init)

| Setting             | Value         | Source                                     |
|---------------------|---------------|--------------------------------------------|
| Model               | `prebuilt-layout` | Spike PASS verdict (BACKLOG:65)        |
| API version         | `2024-11-30`  | Spike script default; Azure DI v4.0        |
| Locale              | auto-detect   | Microsoft recommended default              |
| Endpoint env-var    | `AZURE_DOCINTEL_ENDPOINT` | Spike convention (NOT new names) |
| Key env-var         | `AZURE_DOCINTEL_KEY`      | Spike convention                 |
| Inter-call pacing   | none in adapter | F0-tier pacing belongs to worker, not adapter |

The env-var names **reuse** the spike's existing naming
([scripts/hebrew-ocr-spike.mjs:159-160](../../scripts/hebrew-ocr-spike.mjs)).
A user who already configured the spike does not have to re-key.

### D5 — Factory: `get_ocr_adapter()` (stub-by-default)

Mirrors the [lib/embedding.ts `getEmbedder()`](../../lib/embedding.ts)
precedent: stub-by-default, vendor-when-configured.

```python
# api/ocr/factory.py
def get_ocr_adapter() -> OcrAdapter:
    endpoint = os.environ.get("AZURE_DOCINTEL_ENDPOINT")
    key = os.environ.get("AZURE_DOCINTEL_KEY")
    if endpoint and key:
        from api.ocr.azure import AzureDocumentIntelligenceAdapter
        return AzureDocumentIntelligenceAdapter(endpoint=endpoint, key=key)
    return StubOcrAdapter()
```

The Azure import is **lazy inside the factory branch** so test environments
with neither env var set never resolve the SDK and never pay its import
cost. The `api/ocr/azure.py` module's SDK import is also gated by
`TYPE_CHECKING` at module scope (types only) + runtime `import` inside the
adapter's call method, so mypy --strict gets types without forcing the
import at module load.

### D6 — In-slice production behavior under Azure outage

Until the Tesseract fallback ships, an Azure DI outage produces
`OcrError("ocr_failed")` from `ocr_bytes`. The next-slice worker handler
maps this to `mark_failed(OcrFailed)` per ADR-0019's retry semantics
(jobs reclaim per visibility-timeout). Iron-rule #12 (degraded mode) is
**partially** addressed by this ADR: the stub adapter is the
test-time-only fallback; the production-time fallback to Tesseract is a
follow-up slice. This is documented now, not deferred to discovery.

### D7 — Iron-rule #8 stance (no FORBIDDEN-list extension)

[api/tests/test_iron_rule_8_no_live_api_imports.py](../../api/tests/test_iron_rule_8_no_live_api_imports.py)
scans every `api/**/*.py` for imports of `{voyageai, anthropic, openai}`.
Azure DI is OCR — neither an embedding nor an agent SDK — so it is
**not** added to the FORBIDDEN list. Rationale: iron-rule #8 protects the
embedding + agent path from accidentally calling live model APIs during
test runs (cost + nondeterminism). OCR is a deterministic text-extraction
service in the same category as `pypdf` / `python-docx`; its test-time
guard is the stub-by-default factory, not a source-file-no-import scan.

If a future code-CR proposes adding `azure-ai-documentintelligence` to
the FORBIDDEN list, the rationale above is the counter-argument.

### D8 — SDK pin

`azure-ai-documentintelligence==1.0.2` is added to
[project.dependencies] in [pyproject.toml](../../pyproject.toml), matching
the exact-pin precedent (fastapi==0.136.3, httpx==0.28.1, pypdf==6.12.2,
python-docx==1.2.0). Upgrade requires an ADR amendment.

### D9 — Fixture strategy

`api/tests/test_ocr_azure.py` exercises the Azure-response→OcrResult parse
path against a **real spike-output JSON with PII redacted**, committed at
`api/tests/fixtures/azure_di_layout_real.redacted.json`. Hand-crafted
minimal JSON would drift from Azure DI v4.0's real wire shape. The
redaction excises customer/vendor identifiers per
[ADR-0011](0011-repo-visibility.md); the Priority ERP layout structure
(form labels, paragraph segmentation) is preserved.

The fixture's `analyzeResult.modelId` and `apiVersion` fields are
asserted-on by `test_ocr_azure.py` as the regression anchor for D4.

## Out of scope (deferred)

- **Worker handler dispatch for image content-types.** Next slice; lands
  the `OcrAdapter` integration into [api/handlers/media_ingest.py](../../api/handlers/media_ingest.py)
  alongside `_PARSERS` dispatch.
- **`WorkerErrorClass.{OcrFailed,OcrEmpty}` enum extension.** Next slice;
  ties to D6.
- **Tesseract fallback.** Iron-rule #12 production-time fallback; deferred
  until Azure outage or quality regression triggers it
  (BACKLOG §"Stronger Hebrew OCR — fallback bench (deferred)").
- **Region-attributed chunks / caption extraction (`BoundingRegion`).**
  M2b #7 (Image processing); will amend D1 with optional `regions` field.
- **Per-call cost recording in `audit_log`.** BACKLOG §"M2b OCR pipeline
  wiring" notes this; lands with the next slice's worker handler since
  that's where the audit row is written.
- **F0-tier inter-call pacing.** Worker-orchestrator concern (rate-limit
  shape), not adapter concern. The adapter is single-call-per-invocation;
  pacing is the queue's job.
- **DOCX MIME allowlist addition** to upload route. Separate drift, not
  OCR-shaped.

## Verification

- `make py-check` green: ruff, black --check, mypy --strict, pytest --cov.
- `test_ocr_stub.py` exercises determinism + paragraph segmentation + all
  three error codes.
- `test_ocr_azure.py` exercises the Azure-response→OcrResult parse against
  the redacted real spike fixture (D9): happy path returns ≥ 2 paragraphs,
  empty `paragraphs` raises `OcrError("empty_result")`, non-allowed MIME
  raises `OcrError("unsupported_content_type")`.
- `test_ocr_factory.py` exercises both env-presence branches via
  monkeypatch.
- No live Azure DI call from any test (iron-rule #8 spirit; D7).

## Iron-rule footprint

| Rule | Status | Note |
|------|--------|------|
| #1 (no secret commit) | ✓ | env vars only; fixture redacted per D9 |
| #2 (KB writes via Ingestion Agent) | N/A | OCR is text-extraction, not KB write |
| #6 (sensitivity tagging) | N/A | adapter is pure text |
| #8 (no live API SDK in embed/agent path) | ✓ | D7 — Azure DI not in FORBIDDEN |
| #9 (chunks carry model + version) | N/A | adapter doesn't write chunks; OCR provenance lives in audit_log via next-slice worker |
| #10 (prompt hash) | N/A | no agent invocation |
| #12 (degraded mode) | partial | D6 — stub fallback this slice; Tesseract deferred |

## Consequences

- The first OCR adapter is now a sealed contract that downstream slices
  plug into without reshaping. M2b #7 amends `OcrResult` once
  (`regions` field); the Tesseract follow-up amends D6 once (production
  fallback chain). No other amendments are anticipated pre-M5.
- The factory pattern matches `lib/embedding.ts` exactly, which means the
  next reviewer reading either side of the codebase sees the same shape.
- The "real redacted fixture" decision (D9) costs a one-time user-supplied
  artifact placement but eliminates the Azure-DI-wire-shape-drift class
  of bugs that a hand-crafted fixture would have shipped.

---

## Amendment 2026-05-27 — Worker handler integration

Wires the adapter shipped in D1–D9 into the M2b #5 worker handler at
[api/handlers/media_ingest.py](../../api/handlers/media_ingest.py),
closing the "Worker handler dispatch for image content-types" item from
the original §Out of scope list.

### A1 — `WorkerErrorClass` closed-enum extension

Per [ADR-0021 §D8](0021-worker-http-callback-architecture.md), the
`WorkerErrorClass` enum at [api/handlers/types.py](../../api/handlers/types.py)
is intentionally closed; extensions require this amendment. Two new
values land:

```python
OcrFailed = "ocr_failed"
"""OCR adapter raised OcrError("ocr_failed") — Azure outage, quota,
   credentials, transient 5xx. Retry-eligible (max_attempts then dead)."""

OcrEmpty = "ocr_empty_result"
"""OCR adapter raised OcrError("empty_result") — image OCR'd but no
   paragraphs surfaced. Operator recovery: retry with a clearer image
   (resolution, contrast, occlusion); OcrEmpty does NOT imply the source
   has no text — only that the vendor couldn't extract any."""
```

The defensive case where the adapter raises
`OcrError("unsupported_content_type")` despite the pre-dispatch
allowlist filter is mapped to `HandlerCrashed` with the structured
`last_error` prefix `ocr_dispatch_allowlist_mismatch:` — it signals a
real bug (the handler's allowlist and the adapter's allowlist drifted),
not an OCR failure. Mirrors the `malformed_entry_id_uuid:` precedent at
[media_ingest.py:199](../../api/handlers/media_ingest.py#L199).

`UnsupportedContentType` docstring is updated to drop the
"until M2b #6 lands" qualifier — image MIMEs are now supported.

### A2 — Async-execution discipline (`asyncio.to_thread`)

`OcrAdapter.ocr_bytes` (D1) is intentionally **sync**. Calling it
directly from the async `_run` would block the worker's poll loop —
every other queued job stalls for the duration of the Azure DI HTTP
round-trip (≈ 1-3 s typical, but vendor-side worst case is unbounded).
The handler MUST invoke the adapter via:

```python
ocr_result = await asyncio.to_thread(
    ocr_adapter.ocr_bytes, blob_bytes, content_type.lower()
)
```

Sync-vs-async at the adapter boundary is a deliberate choice: the
Protocol stays simple and the Azure SDK's sync client surfaces cleanly;
`to_thread` is the bridge. Test environments using `StubOcrAdapter`
also go through `to_thread` — exercising the same control flow as
production.

### A3 — Canonical `OCR_ALLOWED_CONTENT_TYPES`

Pre-amendment, three places encoded the OCR MIME allowlist:
`api/ocr/stub.py:_ALLOWED_CONTENT_TYPES`,
`api/ocr/azure.py:_ALLOWED_CONTENT_TYPES`, and the new
`_OCR_TYPES` proposed for the handler. To prevent drift,
`api/ocr/__init__.py` exports a single canonical
`OCR_ALLOWED_CONTENT_TYPES: frozenset[str]` and the three consumers
import it. Extension still requires an ADR amendment (D3 contract); the
amendment touches one constant, not three.

### A4 — Dispatch table (handler-internal)

[api/handlers/media_ingest.py](../../api/handlers/media_ingest.py)
keeps the existing `_PARSERS: dict[str, ParserFn]` (the dispatch still
needs the parser-fn lookup) and adds a complementary MIME set imported
from `api.ocr`:

```python
_PARSERS: dict[str, ParserFn] = {
    "application/pdf": parse_pdf,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": parse_docx,
}
# OCR_ALLOWED_CONTENT_TYPES imported from api.ocr
```

`_run`'s content-type branch:

1. `content_type.lower() in _PARSERS` → parse via `parse_pdf` / `parse_docx`.
2. `content_type.lower() in OCR_ALLOWED_CONTENT_TYPES` → OCR via `asyncio.to_thread(ocr_adapter.ocr_bytes, ...)`.
3. else → `UnsupportedContentType`.

The OCR branch's `OcrError` catch maps `e.code` to:
- `"ocr_failed"` → `OcrFailed`
- `"empty_result"` → `OcrEmpty`
- `"unsupported_content_type"` → `HandlerCrashed` with
  `ocr_dispatch_allowlist_mismatch:` prefix (defensive — see A1).

### A5 — `make_handler` ocr_adapter kwarg (required)

`make_handler` adds a **required** `ocr_adapter: OcrAdapter` kwarg.
Required (not defaulted to `get_ocr_adapter()`) so tests inject a
hermetic stub and production startup resolves env once at boot. The
production call site at [api/worker.py main()](../../api/worker.py)
constructs `ocr_adapter = get_ocr_adapter()` and logs
`type(ocr_adapter).__name__` so operators see whether Azure or stub
resolved.

### A6 — OCR provenance deferred; documented cost

The slice ships OCR-extracted text into entries' bodies via the
existing worker→Node PUT (ADR-0021 D1) with **no change** to the PUT
body shape. `OcrResult.model`, `api_version`, and `confidence` are
discarded by the handler in this slice.

**Cost named explicitly:** entries written by the OCR path between
this slice and the future provenance slice carry no model/api_version
discriminator in `audit_log`. Forensic re-identification is still
possible via `jobs.payload.content_type` (image MIME → OCR path) +
`audit_log.payload.worker_id` (worker attribution from ADR-0021 D3),
but the OCR vendor + version are not recorded. The provenance slice
will thread `OcrResult.model` + `api_version` into the PUT body and
extend `IngestBodyForPut` (Node side) to route them into
`audit_log.payload`.

### A7 — Iron-rule footprint (delta from §Iron-rule footprint above)

| Rule | Status | Note |
|------|--------|------|
| #2 | ✓ | Worker still delegates body update via Node PUT; iron rule unchanged. |
| #6 | ✓ | Existing sensitivity-preserve pattern at [media_ingest.py:274-284](../../api/handlers/media_ingest.py#L274) covers OCR path identically. |
| #8 | ✓ | OCR adapter import (`api.ocr`) does not add to FORBIDDEN list — Azure DI is not embedding/agent. |
| #9 | N/A | Chunks written by Node downstream. |
| #10 | N/A | No agent invocation. |
| #12 | partial | `OcrFailed` is retry-eligible per WorkerErrorClass attempts policy; production-time Tesseract fallback still deferred. |

### A8 — Out of scope (slice boundary preserved)

- OCR provenance in `audit_log` (A6 documents the cost).
- Tesseract production-time fallback (D6 still partial). **← un-deferred by A9 below.**
- `BoundingRegion` extension to `OcrResult` (M2b #7).
- DOCX MIME allowlist addition to upload route.
- Per-call OCR cost in `audit_log` (BACKLOG entry).

## Amendment 2026-05-28 — A9: Tesseract production-time fallback (D6 un-deferred; iron-rule #12 closed)

This amendment un-defers D6 / A8's "Tesseract production-time fallback." An
Azure DI outage now **degrades** to local Tesseract OCR instead of hard-failing,
closing the iron-rule #12 degraded-mode leg for the OCR path.

### A9.1 — Fallback lives at the factory, not the worker handler

`get_ocr_adapter()` returns `FallbackOcrAdapter(primary=Azure,
fallback=Tesseract)` when Azure is configured. The worker handler
([api/handlers/media_ingest.py](../../api/handlers/media_ingest.py)) is
**unchanged** — it calls `ocr_bytes` and the fallback is transparent; its
existing `ocr_failed → mark_failed(OcrFailed)` mapping now fires only when
*both* engines fail. This keeps the degraded-mode chain inside the OCR layer.

```python
# api/ocr/fallback.py
class FallbackOcrAdapter:                 # structural OcrAdapter
    def __init__(self, *, primary: OcrAdapter, fallback: OcrAdapter) -> None: ...
    @property
    def primary(self) -> OcrAdapter: ...
    @property
    def fallback(self) -> OcrAdapter: ...
    def ocr_bytes(self, data, content_type) -> OcrResult:
        # try primary; on OcrError(code == "ocr_failed") retry fallback;
        # any other code re-raised; if fallback also fails, raise its error.
```

### A9.2 — Trigger is `ocr_failed`-only (recorded decision, Q1)

The fallback fires **only** on `OcrError.code == "ocr_failed"` — an outage.
`unsupported_content_type` and `empty_result` are deterministic outcomes and
are re-raised without retry. Trade-off considered: falling back on
`empty_result` *could* rescue text Azure missed on a Hebrew screenshot, but it
would also turn a fast clean blank-image result into a slow double-OCR that
still returns empty; the common case is empty-on-empty, so `ocr_failed`-only is
the chosen default. (Surfaced per the deferred-decision-audit rule — D6 named
"fallback" without specifying the trigger.)

### A9.3 — Unconditional wrap is safe when the binary is absent

The Tesseract wrap is unconditional when Azure is primary (no env knob —
degrade-always is the deliberate iron-rule-#12 policy). If the native
`tesseract` binary is absent, `TesseractOcrAdapter.ocr_bytes` raises
`OcrError("ocr_failed")`, so the net behavior matches the pre-fallback
hard-fail. `pytesseract` is imported at module scope (the import does not
require the binary); `api_version` is probed **lazily** inside `ocr_bytes`
(via `get_tesseract_version()`), never at module/init scope — sealing it at
import would crash `import api.ocr.tesseract` wherever the binary is missing,
and the factory imports it unconditionally.

Exception mapping is explicit: `TesseractNotFoundError` (binary absent) is
**not** a subclass of `TesseractError`, so the adapter catches the full set
`(TesseractNotFoundError, TesseractError, PIL.UnidentifiedImageError, OSError,
ValueError) → ocr_failed`. This also routes an undecodable-but-allowlisted
image (a corrupt WEBP raising `UnidentifiedImageError`) to `ocr_failed` rather
than letting it escape to `HandlerCrashed`.

### A9.4 — Provenance, signal, and accepted costs

- **Provenance:** Tesseract results carry `model="tesseract"`,
  `api_version="tesseract-<version>"`. As in A6, the handler still discards
  `OcrResult.model`, so a degraded entry is not yet distinguishable in
  `audit_log` by vendor. The durable-audit-flag for "this entry was OCR'd by
  the fallback" is BACKLOG'd.
- **Operator signal:** `FallbackOcrAdapter` emits `logger.warning` with the
  stable greppable prefix `ocr_fallback_engaged:` on engagement (and
  `ocr_fallback_failed:` when both fail). Until the audit-flag lands, this WARN
  log is how an operator detects a silent Azure outage.
- **Confidence:** `confidence=None` (mirrors the stub). Per-word confidence via
  `pytesseract.image_to_data` is deferred — scope creep for a degraded path.
- **Latency:** on engagement the fallback runs primary-then-fallback
  synchronously inside the worker's one `asyncio.to_thread` thread (doubled
  worst-case wall time), which is acceptable since it fires only on outage and
  does not stall the event loop. No `timeout=` on `image_to_string` — parity
  with Azure's accepted-unbounded stance (A2); BACKLOG'd.

### A9.5 — Dependencies, CI, verification

- Pins `pytesseract==0.3.13` + `Pillow==12.2.0` in `[project.dependencies]`.
  pytesseract ships no `py.typed` → a targeted `[[tool.mypy.overrides]]` for
  `pytesseract.*` only (NOT a blanket ignore); Pillow ships types.
- CI python job installs `tesseract-ocr tesseract-ocr-heb tesseract-ocr-eng
  fonts-dejavu-core` via apt. The sandbox has no Tesseract, so the CI run is the
  platform-runtime gate; the two real-binary smokes (English plumbing + Hebrew
  `heb`-pack round-trip) are `@skipif`-gated and run only there.

### A9.6 — Iron-rule footprint delta

| Rule | Status | Note |
|------|--------|------|
| #8 | ✓ | pytesseract / Pillow are OCR libs, not embedding/agent SDKs — not added to FORBIDDEN (same rationale as Azure DI, D7). |
| #9 | N/A | Chunks written by Node downstream; provenance on OcrResult. |
| #12 | ✓ | **Closed** — Azure outage degrades to Tesseract instead of hard-failing. |
