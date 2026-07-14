from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import func, select

from app import crud
from app.api.deps import CurrentUser, SessionDep, get_current_active_superuser
from app.core.config import settings
from app.core.ingestion import is_zone_stale
from app.models import (
    ClientSnapshotPublic,
    ZoneSigningKeyCreate,
    ZoneSigningKeyPublic,
    ZoneSigningKeyRegister,
    ZoneSummariesPublic,
    ZoneSummary,
    ZoneSummaryPublic,
    ZoneSummaryUpdate,
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


@router.patch(
    "/{tenant_id}/{zone_id}",
    dependencies=[Depends(get_current_active_superuser)],
    response_model=ZoneSummaryPublic,
)
def update_zone_summary(
    session: SessionDep,
    tenant_id: str,
    zone_id: str,
    zone_in: ZoneSummaryUpdate,
) -> Any:
    """
    Set operator-facing zone metadata (display_name). Everything else on a
    ZoneSummary is machine-derived at ingest time; this is the one field an
    operator owns, so it survives ingest upserts.
    """
    summary = crud.set_zone_display_name(
        session=session,
        tenant_id=tenant_id,
        zone_id=zone_id,
        display_name=zone_in.display_name,
    )
    if summary is None:
        raise HTTPException(
            status_code=404,
            detail=f"No zone summary for '{tenant_id}/{zone_id}'",
        )
    return ZoneSummaryPublic(
        **summary.model_dump(),
        is_stale=is_zone_stale(
            summary.last_pulled_at,
            threshold_seconds=settings.STALENESS_THRESHOLD_SECONDS,
        ),
    )


@router.put(
    "/{tenant_id}/{zone_id}/signing-key",
    dependencies=[Depends(get_current_active_superuser)],
    response_model=ZoneSigningKeyPublic,
)
def register_zone_signing_key(
    session: SessionDep,
    tenant_id: str,
    zone_id: str,
    key_in: ZoneSigningKeyRegister,
) -> Any:
    """
    Register (or rotate, in place) a zone's ed25519 public key for snapshot
    manifest verification (plan §4.4 -- keys are registered out-of-band,
    never trusted from the manifest itself). The private key never leaves
    the zone's pingsvc host; only the public half is submitted here.
    """
    try:
        return crud.create_zone_signing_key(
            session=session,
            key_create=ZoneSigningKeyCreate(
                tenant_id=tenant_id, zone_id=zone_id, public_key_hex=key_in.public_key_hex
            ),
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.get("/{tenant_id}/{zone_id}/signing-key", response_model=ZoneSigningKeyPublic)
def read_zone_signing_key(
    session: SessionDep, current_user: CurrentUser, tenant_id: str, zone_id: str
) -> Any:
    """The zone's registered public key, if any (public half only)."""
    key = crud.get_zone_signing_key(
        session=session, tenant_id=tenant_id, zone_id=zone_id
    )
    if key is None:
        raise HTTPException(
            status_code=404,
            detail=f"No signing key registered for zone '{tenant_id}/{zone_id}'",
        )
    return key


@router.delete(
    "/{tenant_id}/{zone_id}",
    dependencies=[Depends(get_current_active_superuser)],
    status_code=204,
)
def delete_zone(session: SessionDep, tenant_id: str, zone_id: str) -> None:
    """
    Permanently remove a decommissioned zone: its summary, every snapshot
    it ever pushed, and its registered signing key. There's no undo --
    a zone that pushes again afterward just starts a fresh history.
    """
    deleted = crud.delete_zone(session=session, tenant_id=tenant_id, zone_id=zone_id)
    if not deleted:
        raise HTTPException(
            status_code=404,
            detail=f"No zone summary for '{tenant_id}/{zone_id}'",
        )
