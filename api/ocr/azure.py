"""Azure Document Intelligence OCR adapter — see ADR-0022.

Wraps `azure-ai-documentintelligence` v1.0.2 with the project's
vendor-agnostic OcrAdapter contract. Locks `prebuilt-layout` + api-version
`2024-11-30` per the M1 Hebrew-OCR spike PASS verdict (docs/BACKLOG.md:52-65).

SDK import pattern: types at module scope under `TYPE_CHECKING`; runtime
client + request classes imported lazily inside `ocr_bytes`. This keeps
mypy --strict happy without forcing the import at module load — test
environments that monkeypatch on the Azure SDK never resolve the real
package.

Iron-rule footprint (this module):
    #1  Endpoint + key read from env at factory time; never logged.
    #8  Azure DI is OCR, NOT embedding/agent — not added to FORBIDDEN
        list (api/tests/test_iron_rule_8_no_live_api_imports.py). See
        ADR-0022 D7 for rationale.
    #9  Adapter does not write chunks. OCR provenance (model +
        api_version) lives on OcrResult and is recorded by the next-slice
        worker handler in audit_log.
    #12 Vendor outage raises OcrError("ocr_failed"); production fallback
        to Tesseract deferred to next slice (ADR-0022 D6).
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from api.ocr.types import OcrError, OcrResult

if TYPE_CHECKING:
    from azure.ai.documentintelligence.models import AnalyzeResult


# Image-only allowlist per ADR-0022 D3. PDFs continue routing through
# parse_pdf (ADR-0021). Extension requires ADR-0022 amendment.
_ALLOWED_CONTENT_TYPES: frozenset[str] = frozenset({"image/png", "image/jpeg", "image/webp"})

# Sealed at module init — see ADR-0022 D4.
_MODEL_ID = "prebuilt-layout"
_API_VERSION = "2024-11-30"


class AzureDocumentIntelligenceAdapter:
    """Azure DI v4.0 adapter; structural implementation of OcrAdapter.

    Instances hold endpoint + key; the SDK client is constructed per-call
    so a long-lived adapter survives credential rotation without
    re-instantiation. The next-slice worker handler will hold a single
    adapter instance for the worker lifetime.
    """

    def __init__(self, *, endpoint: str, key: str) -> None:
        self._endpoint = endpoint
        self._key = key

    def ocr_bytes(self, data: bytes, content_type: str) -> OcrResult:
        """Send `data` to Azure DI `prebuilt-layout`; return OcrResult.

        Raises:
            OcrError("unsupported_content_type") — MIME not in allowlist.
            OcrError("ocr_failed")               — SDK raised (network,
                quota, credentials, transient 5xx). The caller (worker
                handler, next slice) maps to mark_failed.
            OcrError("empty_result")             — Azure returned 0
                paragraphs.
        """
        if content_type not in _ALLOWED_CONTENT_TYPES:
            raise OcrError(
                "unsupported_content_type",
                f"Azure adapter does not accept content_type={content_type!r}",
            )
        if not data:
            raise OcrError("empty_result", "Azure adapter received zero-byte input")

        # Lazy runtime imports — see module docstring. Failure to resolve
        # the SDK at runtime is wrapped as ocr_failed so the caller does
        # not see ImportError leaking from the adapter surface.
        try:
            from azure.ai.documentintelligence import DocumentIntelligenceClient
            from azure.ai.documentintelligence.models import AnalyzeDocumentRequest
            from azure.core.credentials import AzureKeyCredential
            from azure.core.exceptions import AzureError
        except ImportError as e:  # pragma: no cover — gate-time install ensures SDK present
            raise OcrError("ocr_failed", f"Azure SDK import failed: {e}") from e

        client = DocumentIntelligenceClient(
            endpoint=self._endpoint,
            credential=AzureKeyCredential(self._key),
            api_version=_API_VERSION,
        )
        try:
            poller = client.begin_analyze_document(
                model_id=_MODEL_ID,
                body=AnalyzeDocumentRequest(bytes_source=data),
            )
            result = poller.result()
        except AzureError as e:
            raise OcrError("ocr_failed", str(e)) from e

        return _parse_result(result)


def _parse_result(result: AnalyzeResult) -> OcrResult:
    """Pure transformation AnalyzeResult → OcrResult.

    Separated from the SDK call surface so tests can exercise the parse
    path against a real spike-output fixture (ADR-0022 D9) without
    monkeypatching the SDK client.

    Confidence is computed as the mean of all word-level confidences
    across all pages. Azure DI does not surface a per-paragraph
    confidence in v4.0 — the word level is the finest granularity
    available. Returns None when no word-level confidence is present
    (e.g., layout call with no words detected).
    """
    paragraphs_model = result.paragraphs
    if paragraphs_model is None or len(paragraphs_model) == 0:
        raise OcrError("empty_result", "Azure returned 0 paragraphs")

    paragraphs: list[str] = []
    for p in paragraphs_model:
        # DocumentParagraph.content is typed as str; defensive None-guard
        # protects against deserialization-time partial objects.
        content = getattr(p, "content", None) or ""
        if content:
            paragraphs.append(content)

    if not paragraphs:
        raise OcrError(
            "empty_result", "Azure returned paragraphs but all content fields were empty"
        )

    text = "\n\n".join(paragraphs)
    confidence = _mean_word_confidence(result)

    # Pin model + api_version to the sealed constants rather than the
    # result's self-reported fields — provenance is what we sent, not
    # what the response echoes back. If Azure ever returns a divergent
    # api_version, the next-slice worker handler can compare result
    # echoes vs. expected (audit-log surface) for forensics.
    return OcrResult(
        text=text,
        paragraphs=paragraphs,
        confidence=confidence,
        model=_MODEL_ID,
        api_version=_API_VERSION,
    )


def _mean_word_confidence(result: AnalyzeResult) -> float | None:
    """Mean word-level confidence across all pages, or None if absent.

    Note: aggregates **every** word's confidence, including words that
    belong to paragraphs `_parse_result` later drops as empty-content.
    The result is the page-level confidence signal, not a confidence
    over the surfaced `OcrResult.text`. Downstream consumers thresholding
    on `OcrResult.confidence` should treat it as page-quality rather than
    text-quality. If a divergence between the two ever matters, recompute
    confidence against the surviving paragraphs' span ranges — that's an
    ADR-0022 amendment, not a hidden behavior change.
    """
    pages = result.pages
    if not pages:
        return None
    total = 0.0
    count = 0
    for page in pages:
        words = getattr(page, "words", None)
        if not words:
            continue
        for word in words:
            conf = getattr(word, "confidence", None)
            if conf is None:
                continue
            total += float(conf)
            count += 1
    if count == 0:
        return None
    return total / count
