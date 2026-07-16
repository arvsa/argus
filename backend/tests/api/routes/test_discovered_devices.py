"""
Tests for the DiscoveredDevice candidate pool and its ingestion/review
routes -- see plan/device-discovery-v1.md §2.2/§2.7 (plan step 2,
`feature/device-discovery-schema`).

Requires a live DB (run inside Docker: docker compose exec backend pytest).
"""

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from tests.utils.utils import get_superuser_token_headers

API = settings.API_V1_STR


def _su(client: TestClient) -> dict[str, str]:
    return get_superuser_token_headers(client)


def _pingsvc_headers() -> dict[str, str]:
    return {"X-Pingsvc-Token": settings.PINGSVC_SYNC_TOKEN}


def _report(**overrides: object) -> dict:
    body = {
        "addr": "198.51.100.10",
        "mac": None,
        "hostname": None,
        "discovered_via": "arp",
    }
    body.update(overrides)
    return body


# ── ingestion auth gating ──────────────────────────────────────────────────


def test_report_discovered_devices_requires_pingsvc_token(client: TestClient) -> None:
    r = client.post(f"{API}/devices/discovered", json={"reports": [_report()]})
    assert r.status_code == 401


def test_report_discovered_devices_rejects_a_superuser_jwt(client: TestClient) -> None:
    headers = _su(client)
    r = client.post(
        f"{API}/devices/discovered", headers=headers, json={"reports": [_report()]}
    )
    assert r.status_code == 401


# ── upsert semantics ────────────────────────────────────────────────────────


def test_upsert_merges_not_overwrites(client: TestClient) -> None:
    """An ARP-table sighting (no hostname yet) followed by an SNMP
    enrichment (hostname now known) must merge into one row, and a later
    report missing a field already established must never null it out."""
    addr = "198.51.100.11"
    mac = "AA:BB:CC:DD:EE:11"

    r1 = client.post(
        f"{API}/devices/discovered",
        headers=_pingsvc_headers(),
        json={"reports": [_report(addr=addr, mac=mac, discovered_via="arp")]},
    )
    assert r1.status_code == 200, r1.text
    first_id = r1.json()["data"][0]["id"]

    r2 = client.post(
        f"{API}/devices/discovered",
        headers=_pingsvc_headers(),
        json={
            "reports": [
                _report(
                    addr=addr,
                    mac=mac,
                    hostname="switch-1",
                    discovered_via="snmp-enrich",
                )
            ]
        },
    )
    assert r2.status_code == 200, r2.text
    merged = r2.json()["data"][0]
    assert merged["id"] == first_id, "same mac must merge into the same row"
    assert merged["hostname"] == "switch-1"

    # A third report with no hostname must not null out the one already
    # established.
    r3 = client.post(
        f"{API}/devices/discovered",
        headers=_pingsvc_headers(),
        json={"reports": [_report(addr=addr, mac=mac, discovered_via="arp")]},
    )
    assert r3.status_code == 200, r3.text
    assert r3.json()["data"][0]["hostname"] == "switch-1"


def test_upsert_matches_existing_addr_only_row_once_mac_becomes_known(
    client: TestClient,
) -> None:
    """A device first seen address-only (arp-sweep, no mac) later confirmed
    with a mac (SNMP-enrich) must merge into the same row, not create a
    duplicate -- both sightings are the same physical device."""
    addr = "198.51.100.12"

    r1 = client.post(
        f"{API}/devices/discovered",
        headers=_pingsvc_headers(),
        json={"reports": [_report(addr=addr, mac=None, discovered_via="arp-sweep")]},
    )
    first_id = r1.json()["data"][0]["id"]

    r2 = client.post(
        f"{API}/devices/discovered",
        headers=_pingsvc_headers(),
        json={
            "reports": [
                _report(addr=addr, mac="AA:BB:CC:DD:EE:12", discovered_via="arp")
            ]
        },
    )
    assert r2.json()["data"][0]["id"] == first_id
    assert r2.json()["data"][0]["mac"] == "AA:BB:CC:DD:EE:12"


# ── manual review (default: AUTO_POPULATE_DISCOVERED_DEVICES=False) ────────


def test_manual_review_stays_pending(client: TestClient) -> None:
    addr = "198.51.100.13"
    r = client.post(
        f"{API}/devices/discovered",
        headers=_pingsvc_headers(),
        json={"reports": [_report(addr=addr)]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"][0]["status"] == "pending"

    su_headers = _su(client)
    devices = client.get(f"{API}/devices/", headers=su_headers).json()["data"]
    assert not any(d["addr"] == addr for d in devices), (
        "a pending candidate must not have been promoted to a real Device"
    )


def test_approve_discovered_device_promotes_to_real_device(client: TestClient) -> None:
    addr = "198.51.100.14"
    ingest = client.post(
        f"{API}/devices/discovered",
        headers=_pingsvc_headers(),
        json={"reports": [_report(addr=addr, hostname="printer-1")]},
    )
    disc_id = ingest.json()["data"][0]["id"]

    su_headers = _su(client)
    r = client.post(f"{API}/devices/discovered/{disc_id}/approve", headers=su_headers)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "approved"

    devices = client.get(f"{API}/devices/", headers=su_headers).json()["data"]
    matches = [d for d in devices if d["addr"] == addr]
    assert len(matches) == 1
    assert matches[0]["hostname"] == "printer-1"


def test_reject_discovered_device_does_not_promote(client: TestClient) -> None:
    addr = "198.51.100.15"
    ingest = client.post(
        f"{API}/devices/discovered",
        headers=_pingsvc_headers(),
        json={"reports": [_report(addr=addr)]},
    )
    disc_id = ingest.json()["data"][0]["id"]

    su_headers = _su(client)
    r = client.post(f"{API}/devices/discovered/{disc_id}/reject", headers=su_headers)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "rejected"

    devices = client.get(f"{API}/devices/", headers=su_headers).json()["data"]
    assert not any(d["addr"] == addr for d in devices)


def test_get_discovered_devices_requires_superuser(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    r = client.get(f"{API}/devices/discovered", headers=normal_user_token_headers)
    assert r.status_code == 403


def test_approve_discovered_device_requires_superuser(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    addr = "198.51.100.16"
    ingest = client.post(
        f"{API}/devices/discovered",
        headers=_pingsvc_headers(),
        json={"reports": [_report(addr=addr)]},
    )
    disc_id = ingest.json()["data"][0]["id"]
    r = client.post(
        f"{API}/devices/discovered/{disc_id}/approve",
        headers=normal_user_token_headers,
    )
    assert r.status_code == 403


# ── auto-populate ───────────────────────────────────────────────────────────


def test_auto_populate_promotes_immediately(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "AUTO_POPULATE_DISCOVERED_DEVICES", True)
    addr = "198.51.100.17"

    r = client.post(
        f"{API}/devices/discovered",
        headers=_pingsvc_headers(),
        json={"reports": [_report(addr=addr, hostname="ap-1")]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"][0]["status"] == "approved"

    su_headers = _su(client)
    devices = client.get(f"{API}/devices/", headers=su_headers).json()["data"]
    matches = [d for d in devices if d["addr"] == addr]
    assert len(matches) == 1
    assert matches[0]["hostname"] == "ap-1"


# ── targets-export never includes a pending candidate ───────────────────────


def test_targets_export_never_includes_a_pending_candidate(client: TestClient) -> None:
    addr = "198.51.100.18"
    client.post(
        f"{API}/devices/discovered",
        headers=_pingsvc_headers(),
        json={"reports": [_report(addr=addr)]},
    )

    su_headers = _su(client)
    r = client.get(f"{API}/devices/targets-export", headers=su_headers)
    assert r.status_code == 200, r.text
    assert addr not in r.text
