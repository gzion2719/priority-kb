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
