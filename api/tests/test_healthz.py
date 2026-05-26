"""Liveness endpoint smoke."""

from __future__ import annotations

from fastapi.testclient import TestClient

from api.main import app


def test_healthz_returns_ok_shape() -> None:
    client = TestClient(app)
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "service": "priority-kb-api"}
