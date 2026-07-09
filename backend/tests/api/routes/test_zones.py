"""
Tests for GET /api/v1/zones/summary and GET /api/v1/zones/{tenant}/{zone}/latest.

Requires a live DB (run inside Docker: docker compose exec backend pytest).
"""
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlmodel import Session

from app import crud
from app.core.config import settings
from app.models import ClientSnapshotCreate
from tests.utils.utils import get_superuser_token_headers, random_lower_string

API = settings.API_V1_STR


def _su(client: TestClient) -> dict[str, str]:
    return get_superuser_token_headers(client)


def test_read_zone_summaries_includes_is_stale_field(client: TestClient, db: Session) -> None:
    tenant_id = random_lower_string()
    crud.upsert_zone_summary(
        session=db, tenant_id=tenant_id, zone_id="zone-fresh",
        up_count=3, down_count=1, last_snapshot_ts=1000,
    )
    headers = _su(client)

    r = client.get(f"{API}/zones/summary", headers=headers)
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    match = next((z for z in data if z["zone_id"] == "zone-fresh"), None)
    assert match is not None, "Seeded zone summary not found in list response"
    assert match["is_stale"] is False
    assert match["up_count"] == 3
    assert match["down_count"] == 1


def test_read_zone_summaries_marks_stale_zone(client: TestClient, db: Session) -> None:
    tenant_id = random_lower_string()
    summary = crud.upsert_zone_summary(
        session=db, tenant_id=tenant_id, zone_id="zone-dark-route",
        up_count=1, down_count=0, last_snapshot_ts=1000,
    )
    summary.last_pulled_at = datetime.now(timezone.utc) - timedelta(
        seconds=settings.STALENESS_THRESHOLD_SECONDS + 60
    )
    db.add(summary)
    db.commit()
    headers = _su(client)

    r = client.get(f"{API}/zones/summary", headers=headers)
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    match = next((z for z in data if z["zone_id"] == "zone-dark-route"), None)
    assert match is not None
    assert match["is_stale"] is True


def _seed_snapshot(
    db: Session, tenant_id: str, zone_id: str, snapshot_ts: int
) -> None:
    crud.create_client_snapshot(
        session=db,
        snapshot_create=ClientSnapshotCreate(
            tenant_id=tenant_id,
            zone_id=zone_id,
            snapshot_ts=snapshot_ts,
            storage_key=f"{tenant_id}/{zone_id}/2026/07/09/12/{snapshot_ts}.json.gz",
            nodes_json={"node-a": {"up": 2, "down": 1}},
            devices_json={"10.0.0.1": {"ok": True, "ts": snapshot_ts}},
            signature_verified=True,
        ),
    )


def test_read_latest_zone_snapshot_returns_newest(
    client: TestClient, db: Session
) -> None:
    tenant_id = random_lower_string()
    zone_id = "zone-detail"
    _seed_snapshot(db, tenant_id, zone_id, snapshot_ts=1_700_000_000_000)
    _seed_snapshot(db, tenant_id, zone_id, snapshot_ts=1_700_000_300_000)
    headers = _su(client)

    r = client.get(f"{API}/zones/{tenant_id}/{zone_id}/latest", headers=headers)
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["tenant_id"] == tenant_id
    assert payload["zone_id"] == zone_id
    assert payload["snapshot_ts"] == 1_700_000_300_000
    assert payload["nodes_json"] == {"node-a": {"up": 2, "down": 1}}
    assert payload["devices_json"] == {
        "10.0.0.1": {"ok": True, "ts": 1_700_000_300_000}
    }
    assert payload["signature_verified"] is True
    assert payload["pulled_at"] is not None


def test_read_latest_zone_snapshot_unknown_zone_404(
    client: TestClient, db: Session
) -> None:
    headers = _su(client)

    r = client.get(
        f"{API}/zones/{random_lower_string()}/no-such-zone/latest", headers=headers
    )
    assert r.status_code == 404, r.text


def test_read_latest_zone_snapshot_requires_auth(client: TestClient) -> None:
    r = client.get(f"{API}/zones/some-tenant/some-zone/latest")
    assert r.status_code == 401, r.text
