"""OCR factory tests — see ADR-0022 D5.

Exercises both branches of `get_ocr_adapter()`:
    - No env vars present → StubOcrAdapter.
    - Both env vars present → AzureDocumentIntelligenceAdapter.
    - Only one env var present → StubOcrAdapter (defensive; both required).
"""

from __future__ import annotations

import pytest

from api.ocr import StubOcrAdapter, get_ocr_adapter


def _clear_azure_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AZURE_DOCINTEL_ENDPOINT", raising=False)
    monkeypatch.delenv("AZURE_DOCINTEL_KEY", raising=False)


def test_factory_returns_stub_when_env_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    """No env vars → stub. Verifies the default path."""
    _clear_azure_env(monkeypatch)
    adapter = get_ocr_adapter()
    assert isinstance(adapter, StubOcrAdapter)


def test_factory_returns_azure_when_both_env_present(monkeypatch: pytest.MonkeyPatch) -> None:
    """Both env vars → Azure adapter. Verifies the configured path."""
    from api.ocr.azure import AzureDocumentIntelligenceAdapter

    _clear_azure_env(monkeypatch)
    monkeypatch.setenv("AZURE_DOCINTEL_ENDPOINT", "https://example.cognitiveservices.azure.com")
    monkeypatch.setenv("AZURE_DOCINTEL_KEY", "fake-key-for-test")
    adapter = get_ocr_adapter()
    assert isinstance(adapter, AzureDocumentIntelligenceAdapter)


def test_factory_returns_stub_when_endpoint_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Only key present, no endpoint → stub. Both required for Azure path."""
    _clear_azure_env(monkeypatch)
    monkeypatch.setenv("AZURE_DOCINTEL_KEY", "fake-key-for-test")
    adapter = get_ocr_adapter()
    assert isinstance(adapter, StubOcrAdapter)


def test_factory_returns_stub_when_key_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Only endpoint present, no key → stub. Both required for Azure path."""
    _clear_azure_env(monkeypatch)
    monkeypatch.setenv("AZURE_DOCINTEL_ENDPOINT", "https://example.cognitiveservices.azure.com")
    adapter = get_ocr_adapter()
    assert isinstance(adapter, StubOcrAdapter)


def test_factory_returns_stub_when_env_vars_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    """Empty-string env vars must NOT trigger Azure (truthiness check).

    Negative-assertion test: an empty env var is a misconfiguration, not
    valid credentials. The factory's `if endpoint and key:` guard relies
    on string truthiness — this test pins that behavior so a regression
    that flips to `is not None` falls back to stub instead of trying
    Azure with empty credentials.
    """
    monkeypatch.setenv("AZURE_DOCINTEL_ENDPOINT", "")
    monkeypatch.setenv("AZURE_DOCINTEL_KEY", "")
    adapter = get_ocr_adapter()
    assert isinstance(adapter, StubOcrAdapter)
