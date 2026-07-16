"""
Tests for InfraPollTarget CRUD + the pingsvc-facing internal pull route --
see plan/device-discovery-v1.md §2.6 (plan step 3,
`feature/discovery-infra-target-config`).

Requires a live DB (run inside Docker: docker compose exec backend pytest).
"""

import itertools

from fastapi.testclient import TestClient

from app.core.config import settings
from tests.utils.utils import get_superuser_token_headers

API = settings.API_V1_STR

# 203.0.113.0/24 (TEST-NET-3, RFC 5737) has 256 addresses -- plenty for one
# test module's worth of unique targets, same range test_devices.py uses.
_addr_counter = itertools.count(50)


def _su(client: TestClient) -> dict[str, str]:
    return get_superuser_token_headers(client)


def _pingsvc_headers() -> dict[str, str]:
    return {"X-Pingsvc-Token": settings.PINGSVC_SYNC_TOKEN}


def _create(client: TestClient, headers: dict[str, str], **overrides: object) -> dict:
    body = {
        "addr": f"203.0.113.{next(_addr_counter)}",
        "kind": "router",
        "community": "public",
    }
    body.update(overrides)
    r = client.post(f"{API}/discovery/infra-targets", headers=headers, json=body)
    assert r.status_code == 200, r.text
    return r.json()


# ── auth gating ──────────────────────────────────────────────────────────


def test_list_infra_targets_requires_superuser(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    r = client.get(f"{API}/discovery/infra-targets", headers=normal_user_token_headers)
    assert r.status_code == 403


def test_create_infra_target_requires_superuser(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    r = client.post(
        f"{API}/discovery/infra-targets",
        headers=normal_user_token_headers,
        json={"addr": "203.0.113.40", "kind": "router", "community": "public"},
    )
    assert r.status_code == 403


def test_infra_targets_internal_requires_pingsvc_token(client: TestClient) -> None:
    r = client.get(f"{API}/discovery/infra-targets-internal")
    assert r.status_code == 401


def test_infra_targets_internal_rejects_a_superuser_jwt(client: TestClient) -> None:
    headers = _su(client)
    r = client.get(f"{API}/discovery/infra-targets-internal", headers=headers)
    assert r.status_code == 401


# ── write-only community string ─────────────────────────────────────────


def test_list_infra_targets_never_returns_community_plaintext(
    client: TestClient,
) -> None:
    headers = _su(client)
    created = _create(client, headers, community="s3cr3t-community")

    assert "community" not in created
    assert created["community_set"] is True

    r = client.get(f"{API}/discovery/infra-targets", headers=headers)
    assert r.status_code == 200, r.text
    assert all("community" not in t for t in r.json()["data"])
    assert any(
        t["addr"] == created["addr"] and t["community_set"] for t in r.json()["data"]
    )


def test_infra_targets_internal_returns_plaintext_community(
    client: TestClient,
) -> None:
    headers = _su(client)
    created = _create(client, headers, community="s3cr3t-community")

    r = client.get(
        f"{API}/discovery/infra-targets-internal", headers=_pingsvc_headers()
    )
    assert r.status_code == 200, r.text
    matches = [t for t in r.json() if t["addr"] == created["addr"]]
    assert len(matches) == 1
    assert matches[0]["community"] == "s3cr3t-community"


def test_infra_targets_internal_excludes_disabled_targets(client: TestClient) -> None:
    headers = _su(client)
    created = _create(client, headers, enabled=False)

    r = client.get(
        f"{API}/discovery/infra-targets-internal", headers=_pingsvc_headers()
    )
    assert r.status_code == 200, r.text
    assert not any(t["addr"] == created["addr"] for t in r.json())


# ── CRUD lifecycle ───────────────────────────────────────────────────────


def test_create_infra_target(client: TestClient) -> None:
    headers = _su(client)
    created = _create(client, headers, kind="switch")
    assert created["kind"] == "switch"
    assert created["enabled"] is True


def test_create_infra_target_duplicate_addr_returns_400(client: TestClient) -> None:
    headers = _su(client)
    addr = "203.0.113.41"
    r1 = client.post(
        f"{API}/discovery/infra-targets",
        headers=headers,
        json={"addr": addr, "kind": "router", "community": "public"},
    )
    assert r1.status_code == 200, r1.text
    r2 = client.post(
        f"{API}/discovery/infra-targets",
        headers=headers,
        json={"addr": addr, "kind": "router", "community": "public"},
    )
    assert r2.status_code == 400


def test_update_infra_target_can_change_community_and_enabled(
    client: TestClient,
) -> None:
    headers = _su(client)
    created = _create(client, headers)

    r = client.patch(
        f"{API}/discovery/infra-targets/{created['id']}",
        headers=headers,
        json={"community": "new-community", "enabled": False},
    )
    assert r.status_code == 200, r.text
    assert "community" not in r.json()
    assert r.json()["enabled"] is False

    internal = client.get(
        f"{API}/discovery/infra-targets-internal", headers=_pingsvc_headers()
    ).json()
    # now disabled, so it must not appear even with the new community
    assert not any(t["addr"] == created["addr"] for t in internal)


def test_update_infra_target_requires_superuser(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    headers = _su(client)
    created = _create(client, headers)
    r = client.patch(
        f"{API}/discovery/infra-targets/{created['id']}",
        headers=normal_user_token_headers,
        json={"enabled": False},
    )
    assert r.status_code == 403


def test_delete_infra_target(client: TestClient) -> None:
    headers = _su(client)
    created = _create(client, headers)
    r = client.delete(f"{API}/discovery/infra-targets/{created['id']}", headers=headers)
    assert r.status_code == 200, r.text

    listing = client.get(f"{API}/discovery/infra-targets", headers=headers).json()
    assert not any(t["id"] == created["id"] for t in listing["data"])


def test_delete_infra_target_requires_superuser(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    headers = _su(client)
    created = _create(client, headers)
    r = client.delete(
        f"{API}/discovery/infra-targets/{created['id']}",
        headers=normal_user_token_headers,
    )
    assert r.status_code == 403
