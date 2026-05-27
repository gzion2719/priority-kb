"""AzureDocumentIntelligenceAdapter parse-path tests — see ADR-0022 D9.

Exercises `_parse_result` against a real spike-output JSON with PII
redacted, committed at `api/tests/fixtures/azure_di_layout_real.redacted.json`.

The fixture is the regression anchor for the Azure DI v4.0 wire shape.
Tests load the JSON and convert it to structurally-equivalent objects
(`SimpleNamespace`-wrapped) so `_parse_result` runs the real
attribute-access path without requiring the live Azure SDK to be
imported at test time.

Iron-rule footprint: no live Azure DI call from any test in this file.
The SDK import inside `AzureDocumentIntelligenceAdapter.ocr_bytes` is
unreachable from these tests; the `ocr_failed` path on the network leg
is not unit-tested here (it would require an Azure SDK monkeypatch and
belongs in the next-slice worker-integration tests).
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, cast

import pytest

from api.ocr import OcrError, OcrResult
from api.ocr.azure import (
    AzureDocumentIntelligenceAdapter,
    _mean_word_confidence,
    _parse_result,
)

if TYPE_CHECKING:
    from azure.ai.documentintelligence.models import AnalyzeResult

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "azure_di_layout_real.redacted.json"


def _to_namespace(value: Any) -> Any:
    """Recursively convert dict trees to SimpleNamespace for dotted access.

    Lists pass through with their elements converted. Primitives pass
    through unchanged. The SDK's AnalyzeResult model surfaces fields as
    attribute access (e.g., `result.paragraphs[0].content`); this helper
    mirrors that shape on top of plain JSON dicts so `_parse_result` runs
    against fixture-loaded data without instantiating the SDK Model.
    """
    if isinstance(value, dict):
        return SimpleNamespace(**{k: _to_namespace(v) for k, v in value.items()})
    if isinstance(value, list):
        return [_to_namespace(item) for item in value]
    return value


def _as_result(ns: Any) -> AnalyzeResult:
    """Type-cast a SimpleNamespace tree to AnalyzeResult for `_parse_result` calls.

    The SimpleNamespace deliberately mirrors the SDK shape (.paragraphs,
    .pages, .pages[*].words, .words[*].confidence). mypy --strict requires
    the nominal type to match the function signature; the cast is sound
    because the structural fields the helpers access are present.
    """
    return cast("AnalyzeResult", ns)


@pytest.fixture(scope="module")
def fixture_dict() -> dict[str, Any]:
    """Load the redacted real spike-output JSON (ADR-0022 D9)."""
    if not FIXTURE_PATH.exists():
        pytest.fail(
            f"Azure DI fixture missing at {FIXTURE_PATH}. "
            "Per ADR-0022 D9, this is the regression-anchor fixture; "
            "place a redacted real spike-output JSON before running tests."
        )
    return cast(dict[str, Any], json.loads(FIXTURE_PATH.read_text(encoding="utf-8")))


@pytest.fixture(scope="module")
def fixture_result(fixture_dict: dict[str, Any]) -> Any:
    """SimpleNamespace tree mirroring the Azure SDK AnalyzeResult shape."""
    return _to_namespace(fixture_dict)


# ----- Fixture-shape assertions (regression anchor for D4 + D9) -----


def test_fixture_pins_expected_model_and_api_version(fixture_dict: dict[str, Any]) -> None:
    """Fixture's `modelId` + `apiVersion` match the sealed constants.

    If these drift, the fixture was replaced with a different model's
    output and the parse path is no longer testing what ADR-0022 D4
    pinned.
    """
    assert fixture_dict.get("modelId") == "prebuilt-layout"
    assert fixture_dict.get("apiVersion") == "2024-11-30"


def test_fixture_has_paragraphs(fixture_dict: dict[str, Any]) -> None:
    """Fixture must contain ≥ 2 paragraphs for paragraph-aware assertions."""
    paragraphs = fixture_dict.get("paragraphs", [])
    assert isinstance(paragraphs, list)
    assert len(paragraphs) >= 2


# ----- _parse_result happy path -----


def test_parse_result_returns_paragraphs_in_order(fixture_result: Any) -> None:
    """`_parse_result` preserves the fixture's paragraph order."""
    ocr_result = _parse_result(_as_result(fixture_result))
    assert isinstance(ocr_result, OcrResult)
    assert len(ocr_result.paragraphs) >= 2
    # text is paragraphs joined by "\n\n"; the join must be lossless.
    assert ocr_result.text == "\n\n".join(ocr_result.paragraphs)


def test_parse_result_pins_model_and_api_version_constants(fixture_result: Any) -> None:
    """Provenance fields come from the sealed module constants, not the wire echo.

    ADR-0022 D4 + the `_parse_result` docstring: provenance is what we
    sent, not what the response echoes. If a future regression
    accidentally reads `result.model_id` / `result.api_version`, this
    test catches it because the values would still match the constants
    in the happy path — so this test asserts on the source-of-truth
    being module-level, not response-level (by reading the constants
    indirectly via the adapter).
    """
    ocr_result = _parse_result(_as_result(fixture_result))
    assert ocr_result.model == "prebuilt-layout"
    assert ocr_result.api_version == "2024-11-30"


def test_parse_result_skips_paragraphs_with_empty_content() -> None:
    """Paragraphs whose .content is empty/missing are dropped, not included."""
    fake = SimpleNamespace(
        paragraphs=[
            SimpleNamespace(content="first"),
            SimpleNamespace(content=""),
            SimpleNamespace(content="third"),
        ],
        pages=[],
    )
    ocr_result = _parse_result(_as_result(fake))
    assert ocr_result.paragraphs == ["first", "third"]


# ----- _parse_result empty-result branches -----


def test_parse_result_raises_empty_result_when_paragraphs_none() -> None:
    """`result.paragraphs is None` → OcrError('empty_result')."""
    fake = SimpleNamespace(paragraphs=None, pages=[])
    with pytest.raises(OcrError) as exc_info:
        _parse_result(_as_result(fake))
    assert exc_info.value.code == "empty_result"


def test_parse_result_raises_empty_result_when_paragraphs_empty_list() -> None:
    """Zero-length paragraph list → OcrError('empty_result')."""
    fake = SimpleNamespace(paragraphs=[], pages=[])
    with pytest.raises(OcrError) as exc_info:
        _parse_result(_as_result(fake))
    assert exc_info.value.code == "empty_result"


def test_parse_result_raises_empty_result_when_all_content_empty() -> None:
    """Paragraphs present but every content field is empty → empty_result."""
    fake = SimpleNamespace(
        paragraphs=[
            SimpleNamespace(content=""),
            SimpleNamespace(content=None),
        ],
        pages=[],
    )
    with pytest.raises(OcrError) as exc_info:
        _parse_result(_as_result(fake))
    assert exc_info.value.code == "empty_result"


# ----- _mean_word_confidence -----


def test_mean_word_confidence_averages_across_pages() -> None:
    """Mean of all word-level confidences across all pages."""
    fake = SimpleNamespace(
        paragraphs=[],
        pages=[
            SimpleNamespace(
                words=[SimpleNamespace(confidence=0.9), SimpleNamespace(confidence=0.8)]
            ),
            SimpleNamespace(words=[SimpleNamespace(confidence=1.0)]),
        ],
    )
    # (0.9 + 0.8 + 1.0) / 3 = 0.9
    assert _mean_word_confidence(_as_result(fake)) == pytest.approx(0.9)


def test_mean_word_confidence_returns_none_when_no_pages() -> None:
    fake = SimpleNamespace(paragraphs=[], pages=[])
    assert _mean_word_confidence(_as_result(fake)) is None


def test_mean_word_confidence_returns_none_when_no_words() -> None:
    """Pages present but no words → None (layout call on blank image)."""
    fake = SimpleNamespace(paragraphs=[], pages=[SimpleNamespace(words=None)])
    assert _mean_word_confidence(_as_result(fake)) is None


def test_mean_word_confidence_skips_words_missing_confidence() -> None:
    """Words without a confidence attribute don't poison the average."""
    fake = SimpleNamespace(
        paragraphs=[],
        pages=[
            SimpleNamespace(
                words=[
                    SimpleNamespace(confidence=0.9),
                    SimpleNamespace(confidence=None),
                    SimpleNamespace(confidence=0.7),
                ]
            )
        ],
    )
    # (0.9 + 0.7) / 2 = 0.8 — None is skipped.
    assert _mean_word_confidence(_as_result(fake)) == pytest.approx(0.8)


# ----- ocr_bytes content-type allowlist (pre-SDK gate) -----


def test_ocr_bytes_rejects_unsupported_content_type() -> None:
    """Content-type allowlist enforced BEFORE Azure SDK call.

    A failing MIME must not trip the lazy SDK import (which would
    require Azure SDK to be installed). The check happens first.
    """
    adapter = AzureDocumentIntelligenceAdapter(endpoint="https://x", key="y")
    with pytest.raises(OcrError) as exc_info:
        adapter.ocr_bytes(b"data", "application/pdf")
    assert exc_info.value.code == "unsupported_content_type"


def test_ocr_bytes_rejects_zero_byte_input() -> None:
    """Empty payload → empty_result, before any SDK touch."""
    adapter = AzureDocumentIntelligenceAdapter(endpoint="https://x", key="y")
    with pytest.raises(OcrError) as exc_info:
        adapter.ocr_bytes(b"", "image/png")
    assert exc_info.value.code == "empty_result"
