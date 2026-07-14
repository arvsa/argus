"""
Tests for GET /api/v1/utils/zone-identity -- proxies pingsvc's /identity
endpoint so an operator can read this zone's zone_id/tenant_id/signing
public key straight from the dashboard instead of shelling into the
pingsvc container (see pingsvc/cmd/pingsvc/identity.go).
"""
import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from tests.utils.utils import get_superuser_token_headers

API = settings.API_V1_STR


# Only the success path is exercised through this fake -- the 503 test
# below raises httpx.ConnectError directly from fake_get, matching what a
# real unreachable pingsvc looks like, rather than round-tripping through
# a fake non-2xx response here.
class _FakeResponse:
    def __init__(self, json_body: dict) -> None:
        self._json_body = json_body

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return self._json_body


def test_zone_identity_proxies_pingsvc(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "ROLE", "client")

    def fake_get(url: str, timeout: float = 3.0) -> _FakeResponse:
        assert url == f"{settings.PINGSVC_METRICS_URL}/identity"
        return _FakeResponse(
            {"zone_id": "zone-1", "tenant_id": "acme-corp", "public_key_hex": "ab" * 32},
        )

    monkeypatch.setattr(httpx, "get", fake_get)
    headers = get_superuser_token_headers(client)

    r = client.get(f"{API}/utils/zone-identity", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json() == {
        "zone_id": "zone-1",
        "tenant_id": "acme-corp",
        "public_key_hex": "ab" * 32,
    }


def test_zone_identity_requires_auth(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "ROLE", "client")
    r = client.get(f"{API}/utils/zone-identity")
    assert r.status_code == 401


def test_zone_identity_404s_on_server_role(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "ROLE", "server")
    headers = get_superuser_token_headers(client)

    r = client.get(f"{API}/utils/zone-identity", headers=headers)
    assert r.status_code == 404


def test_zone_identity_503s_when_pingsvc_unreachable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "ROLE", "client")

    def fake_get(url: str, timeout: float = 3.0) -> _FakeResponse:
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx, "get", fake_get)
    headers = get_superuser_token_headers(client)

    r = client.get(f"{API}/utils/zone-identity", headers=headers)
    assert r.status_code == 503
