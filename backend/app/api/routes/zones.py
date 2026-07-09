from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import func, select

from app import crud
from app.api.deps import CurrentUser, SessionDep
from app.core.config import settings
from app.core.ingestion import is_zone_stale
from app.models import (
    ClientSnapshotPublic,
    ZoneSummariesPublic,
    ZoneSummary,
    ZoneSummaryPublic,
)

router = APIRouter(prefix="/zones", tags=["zones"])


@router.get("/summary", response_model=ZoneSummariesPublic)
def read_zone_summaries(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """
    Retrieve per-zone rollup summaries, including whether each zone is
    currently considered stale (plan §4.5 -- a zone that's stopped pushing
    without being able to self-report a WAN outage).
    """
    count_statement = select(func.count()).select_from(ZoneSummary)
    count = session.exec(count_statement).one()
    statement = select(ZoneSummary).offset(skip).limit(limit)
    summaries = session.exec(statement).all()

    data = [
        ZoneSummaryPublic(
            **summary.model_dump(),
            is_stale=is_zone_stale(
                summary.last_pulled_at,
                threshold_seconds=settings.STALENESS_THRESHOLD_SECONDS,
            ),
        )
        for summary in summaries
    ]
    return ZoneSummariesPublic(data=data, count=count)


@router.get("/{tenant_id}/{zone_id}/latest", response_model=ClientSnapshotPublic)
def read_latest_zone_snapshot(
    session: SessionDep, current_user: CurrentUser, tenant_id: str, zone_id: str
) -> Any:
    """
    The newest ingested snapshot for one zone -- its per-node up/down rollups
    and per-device states, as pushed by that zone's pingsvc exporter. This is
    the drill-down behind a zone row in /summary (plan §4.6's zone view);
    the JSON blobs are opaque per-zone data, not unified across zones.
    """
    snapshot = crud.get_latest_client_snapshot(
        session=session, tenant_id=tenant_id, zone_id=zone_id
    )
    if snapshot is None:
        raise HTTPException(
            status_code=404,
            detail=f"No snapshots ingested for zone '{tenant_id}/{zone_id}'",
        )
    return snapshot
