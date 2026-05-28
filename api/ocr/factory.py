"""OCR adapter factory — see ADR-0022 D5.

Stub-by-default; Azure when both `AZURE_DOCINTEL_ENDPOINT` and
`AZURE_DOCINTEL_KEY` are present. Mirrors `lib/embedding.ts::getEmbedder()`.

Env-var names reuse the M1 spike's convention
(`scripts/hebrew-ocr-spike.mjs:159-160`) so a developer who already
configured the spike does not have to re-key.
"""

from __future__ import annotations

import os

from api.ocr.stub import StubOcrAdapter
from api.ocr.types import OcrAdapter


def get_ocr_adapter() -> OcrAdapter:
    """Return the OCR adapter for the current environment.

    Returns:
        FallbackOcrAdapter(primary=Azure, fallback=Tesseract) when both Azure
            env vars are present — an Azure outage degrades to local Tesseract
            (iron-rule #12) per ADR-0022 A9.
        StubOcrAdapter otherwise.

    The Azure SDK import is lazy (only when env vars are configured), so test
    environments never resolve the SDK transitively through this factory.

    The Tesseract wrap is unconditional when Azure is primary and is safe even
    if the `tesseract` binary is absent: in that case the fallback raises
    `OcrError("ocr_failed")`, so the net behavior matches the pre-fallback
    hard-fail. There is no env knob to disable the fallback — degrade-always is
    the deliberate iron-rule-#12 policy (ADR-0022 A9; the WARN-log on
    engagement is the operator signal).
    """
    endpoint = os.environ.get("AZURE_DOCINTEL_ENDPOINT")
    key = os.environ.get("AZURE_DOCINTEL_KEY")
    if endpoint and key:
        from api.ocr.azure import AzureDocumentIntelligenceAdapter
        from api.ocr.fallback import FallbackOcrAdapter
        from api.ocr.tesseract import TesseractOcrAdapter

        return FallbackOcrAdapter(
            primary=AzureDocumentIntelligenceAdapter(endpoint=endpoint, key=key),
            fallback=TesseractOcrAdapter(),
        )
    return StubOcrAdapter()
