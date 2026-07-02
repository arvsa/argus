"""
Tests for GET /api/v1/zones/summary.

Requires a live DB (run inside Docker: docker compose exec backend pytest).
"""
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from sqlmodel import Session

from app import crud
from app.core.config import settings
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
