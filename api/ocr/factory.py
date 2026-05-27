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
        AzureDocumentIntelligenceAdapter when both env vars are present.
        StubOcrAdapter otherwise.

    The Azure SDK import is lazy (only when env vars are configured),
    so test environments never resolve the SDK transitively through
    this factory.
    """
    endpoint = os.environ.get("AZURE_DOCINTEL_ENDPOINT")
    key = os.environ.get("AZURE_DOCINTEL_KEY")
    if endpoint and key:
        from api.ocr.azure import AzureDocumentIntelligenceAdapter

        return AzureDocumentIntelligenceAdapter(endpoint=endpoint, key=key)
    return StubOcrAdapter()
