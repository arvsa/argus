"""
Tests for GET /api/v1/utils/app-config -- the runtime role probe the
frontend uses to decide which navigation/pages to render (client vs
server deployments share one image, so this must be a runtime endpoint,
not a build-time env var).
"""
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings

API = settings.API_V1_STR


def test_app_config_returns_role(client: TestClient) -> None:
    r = client.get(f"{API}/utils/app-config")
    assert r.status_code == 200, r.text
    assert r.json() == {"role": "client"}


def test_app_config_reflects_server_role(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "ROLE", "server")
    r = client.get(f"{API}/utils/app-config")
    assert r.status_code == 200, r.text
    assert r.json() == {"role": "server"}


def test_app_config_is_public(client: TestClient) -> None:
    # No auth header on purpose -- the shell needs it before login, and
    # the role is already inferable from which routes 404.
    r = client.get(f"{API}/utils/app-config")
    assert r.status_code == 200, r.text
