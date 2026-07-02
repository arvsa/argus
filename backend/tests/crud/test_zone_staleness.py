from datetime import datetime, timedelta, timezone

from sqlmodel import Session

from app import crud
from tests.utils.utils import random_lower_string


def _backdate_last_pulled_at(session: Session, tenant_id: str, zone_id: str, seconds_ago: int) -> None:
    summary = crud.upsert_zone_summary(
        session=session, tenant_id=tenant_id, zone_id=zone_id,
        up_count=1, down_count=0, last_snapshot_ts=1000,
    )
    summary.last_pulled_at = datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)
    session.add(summary)
    session.commit()


def test_get_stale_zones_returns_zones_past_threshold(db: Session) -> None:
    tenant_id = random_lower_string()
    _backdate_last_pulled_at(db, tenant_id, "zone-stale", seconds_ago=300)

    stale = crud.get_stale_zones(session=db, threshold_seconds=120)
    stale_ids = {(z.tenant_id, z.zone_id) for z in stale}
    assert (tenant_id, "zone-stale") in stale_ids


def test_get_stale_zones_excludes_recently_pulled_zones(db: Session) -> None:
    tenant_id = random_lower_string()
    _backdate_last_pulled_at(db, tenant_id, "zone-fresh", seconds_ago=10)

    stale = crud.get_stale_zones(session=db, threshold_seconds=120)
    stale_ids = {(z.tenant_id, z.zone_id) for z in stale}
    assert (tenant_id, "zone-fresh") not in stale_ids
