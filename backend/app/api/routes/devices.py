import hashlib
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from sqlmodel import Session, func, select

from app import crud
from app.api.deps import (
    CurrentUser,
    SessionDep,
    get_current_active_superuser,
    verify_pingsvc_token,
)
from app.core.config import settings
from app.models import (
    Device,
    DeviceCreate,
    DevicePublic,
    DevicesPublic,
    DeviceUpdate,
    DiscoveredDevice,
    DiscoveredDevicePublic,
    DiscoveredDeviceReportBatch,
    DiscoveredDevicesPublic,
    Message,
    Node,
)

router = APIRouter(prefix="/devices", tags=["devices"])


@router.get("/", response_model=DevicesPublic)
def read_devices(
    session: SessionDep,
    _current_user: CurrentUser,
    skip: int = 0,
    limit: int = 100,
    node_id: uuid.UUID | None = None,
) -> Any:
    """
    Retrieve Devices -- the bridge between a monitored address and a place
    in the Node hierarchy (see plan/device-node-assignment-bridge-v1.md).
    """
    count_statement = select(func.count()).select_from(Device)
    statement = select(Device)

    if node_id is not None:
        count_statement = count_statement.where(Device.node_id == node_id)
        statement = statement.where(Device.node_id == node_id)

    count = session.exec(count_statement).one()
    devices = session.exec(statement.offset(skip).limit(limit)).all()
    return DevicesPublic(data=devices, count=count)


def _target_line(addr: str, ancestors: str, mac: str | None) -> str:
    """
    One pingsvc target-file line (see pingsvc/cmd/pingsvc/main.go's
    parseTargetLine): addr, an optional semicolon-joined ancestor/node_id
    chain, and an optional device_key (mac) -- in that order, each only
    present when it applies. An unassigned device with a known mac still
    needs the ancestors field present as an empty string ("addr,,mac"),
    since "addr,mac" would be indistinguishable from the existing 2-field
    "assigned, no mac" format and get misparsed as a bogus single-entry
    NodeIDs chain.
    """
    if mac:
        return f"{addr},{ancestors},{mac}"
    if ancestors:
        return f"{addr},{ancestors}"
    return addr


def build_targets_export(session: Session) -> str:
    """
    Render every Device as pingsvc's target-file body (see
    pingsvc/cmd/pingsvc/main.go's parseTargetLine and
    plan/device-node-assignment-bridge-v1.md): one line per device, either
    a bare "addr" (unassigned) or "addr,ancestor1;ancestor2;...;node_id"
    (root-first ancestors from Node.path_ids, then the assigned node
    itself last), with an optional trailing ",mac" device_key field (see
    _target_line). Shared by the human-facing /targets-export and the
    pingsvc-facing /targets-hash and /targets-export-internal below, so
    the hash pingsvc compares against can never drift from the body it
    would actually fetch.
    """
    devices = session.exec(select(Device)).all()
    lines = []
    for device in devices:
        ancestors = ""
        if device.node_id is not None:
            node = session.get(Node, device.node_id)
            if node is not None:
                # Shouldn't be None (ondelete=SET NULL keeps this in sync),
                # but degrade to no ancestors rather than erroring the
                # whole export.
                ancestors = ";".join([*node.path_ids, str(node.id)])
        lines.append(_target_line(device.addr, ancestors, device.mac))
    return "\n".join(lines) + ("\n" if lines else "")


# Registered before /{id} -- FastAPI/Starlette match routes in registration
# order, and /{id} (a str-typed path segment before validation) would
# otherwise swallow a request for the literal path "targets-export" and
# fail UUID validation instead of ever reaching this route.
@router.get("/targets-export", dependencies=[Depends(get_current_active_superuser)])
def get_devices_targets_export(session: SessionDep) -> PlainTextResponse:
    """
    Human-facing target-file export. Superuser-gated -- this reveals the
    full address + hierarchy map in bulk, higher sensitivity than a single
    device read. See build_targets_export() for the format.
    """
    return PlainTextResponse(build_targets_export(session))


# pingsvc target sync (see "Live Target Sync" plan): pingsvc has no user
# account, so these are gated by verify_pingsvc_token (a separate
# shared-secret credential), not get_current_active_superuser. Also
# registered before /{id}, same reason as /targets-export above.
@router.get("/targets-hash", dependencies=[Depends(verify_pingsvc_token)])
def get_devices_targets_hash(session: SessionDep) -> dict[str, str]:
    """
    SHA-256 of the current targets-export body, hex-encoded. pingsvc polls
    this cheaply and only fetches /targets-export-internal when the hash
    has actually changed.
    """
    body = build_targets_export(session)
    return {"hash": hashlib.sha256(body.encode()).hexdigest()}


@router.get("/targets-export-internal", dependencies=[Depends(verify_pingsvc_token)])
def get_devices_targets_export_internal(session: SessionDep) -> PlainTextResponse:
    """
    Same body as /targets-export, for pingsvc's own use -- kept as a
    distinct route (rather than accepting the pingsvc token on the
    human-facing route too) so the existing superuser-only route's auth
    surface never changes.
    """
    return PlainTextResponse(build_targets_export(session))


# ── Device discovery (plan/device-discovery-v1.md §2.7) ─────────────────
# Registered before /{id}, same reason as /targets-export above: "discovered"
# would otherwise be swallowed by /{id} and fail UUID validation instead of
# ever reaching these routes.


def _discovered_public(discovered: DiscoveredDevice) -> DiscoveredDevicePublic:
    """is_stale is computed at read time (never a stored column), so every
    response touching a DiscoveredDevice builds its public shape through
    here rather than relying on response_model to coerce the raw ORM
    object automatically."""
    return DiscoveredDevicePublic(
        id=discovered.id,
        addr=discovered.addr,
        mac=discovered.mac,
        hostname=discovered.hostname,
        discovered_via=discovered.discovered_via,
        status=discovered.status,
        first_seen_at=discovered.first_seen_at,
        last_seen_at=discovered.last_seen_at,
        is_stale=crud.discovered_device_is_stale(
            discovered=discovered,
            threshold_seconds=settings.DISCOVERY_STALE_THRESHOLD_SECONDS,
        ),
    )


@router.post("/discovered", dependencies=[Depends(verify_pingsvc_token)])
def report_discovered_devices(
    session: SessionDep, batch: DiscoveredDeviceReportBatch
) -> DiscoveredDevicesPublic:
    """
    pingsvc's discovery subsystem reports a batch of sightings here (same
    auth as target-sync's routes -- pingsvc has no user account). Each
    report is merge-upserted into the candidate pool (see
    crud.upsert_discovered_device); if AUTO_POPULATE_DISCOVERED_DEVICES is
    set, each is immediately promoted to a real Device in the same request
    instead of waiting for manual review.
    """
    results = []
    for report in batch.reports:
        discovered = crud.upsert_discovered_device(session=session, report=report)
        if settings.AUTO_POPULATE_DISCOVERED_DEVICES and discovered.status == "pending":
            discovered = crud.approve_discovered_device(
                session=session, discovered=discovered
            )
        results.append(discovered)
    return DiscoveredDevicesPublic(
        data=[_discovered_public(d) for d in results], count=len(results)
    )


@router.get(
    "/discovered",
    dependencies=[Depends(get_current_active_superuser)],
    response_model=DiscoveredDevicesPublic,
)
def read_discovered_devices(session: SessionDep) -> Any:
    """
    List discovery candidates for operator review (superuser-only -- this
    is a human review workflow, not a pingsvc-facing route).
    """
    devices = session.exec(select(DiscoveredDevice)).all()
    return DiscoveredDevicesPublic(
        data=[_discovered_public(d) for d in devices], count=len(devices)
    )


@router.post(
    "/discovered/{id}/approve",
    dependencies=[Depends(get_current_active_superuser)],
    response_model=DiscoveredDevicePublic,
)
def approve_discovered_device(session: SessionDep, id: uuid.UUID) -> Any:
    """
    Promote a discovery candidate to a real, monitored Device (see
    crud.approve_discovered_device) -- the manual counterpart to
    AUTO_POPULATE_DISCOVERED_DEVICES.
    """
    discovered = session.get(DiscoveredDevice, id)
    if not discovered:
        raise HTTPException(status_code=404, detail="Discovered device not found")
    return _discovered_public(
        crud.approve_discovered_device(session=session, discovered=discovered)
    )


@router.post(
    "/discovered/{id}/reject",
    dependencies=[Depends(get_current_active_superuser)],
    response_model=DiscoveredDevicePublic,
)
def reject_discovered_device(session: SessionDep, id: uuid.UUID) -> Any:
    """
    Mark a discovery candidate rejected -- it stays in the candidate pool
    (for history/dedup against future sightings) but is never promoted.
    """
    discovered = session.get(DiscoveredDevice, id)
    if not discovered:
        raise HTTPException(status_code=404, detail="Discovered device not found")
    return _discovered_public(
        crud.reject_discovered_device(session=session, discovered=discovered)
    )


@router.get("/{id}", response_model=DevicePublic)
def read_device(session: SessionDep, _current_user: CurrentUser, id: uuid.UUID) -> Any:
    """
    Get a Device by ID.
    """
    device = session.get(Device, id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.post(
    "/",
    dependencies=[Depends(get_current_active_superuser)],
    response_model=DevicePublic,
)
def create_device(*, session: SessionDep, device_in: DeviceCreate) -> Any:
    """
    Create a new Device, or reassign an orphaned one.

    An addr that already exists but is orphaned (node_id is NULL, e.g.
    because its Node was deleted -- see Device.node_id's SET NULL doc
    comment in models.py) is reassigned to the incoming node_id rather than
    rejected, but only when the caller is actually assigning it somewhere
    (device_in.node_id is not None) -- otherwise a device could never be
    re-added anywhere once its node is removed. A bare re-POST of an addr
    that's already unassigned (no node_id either way) is still a real
    duplicate-create attempt, and an addr that's actively assigned
    elsewhere is still a real conflict -- both stay a 400.
    """
    existing = crud.get_device_by_addr(session=session, addr=device_in.addr)
    if existing:
        if existing.node_id is None and device_in.node_id is not None:
            existing.node_id = device_in.node_id
            session.add(existing)
            session.commit()
            session.refresh(existing)
            return existing
        raise HTTPException(
            status_code=400,
            detail="A device with this address already exists.",
        )
    return crud.create_device(session=session, device_create=device_in)


@router.patch(
    "/{id}",
    dependencies=[Depends(get_current_active_superuser)],
    response_model=DevicePublic,
)
def update_device(
    *,
    session: SessionDep,
    id: uuid.UUID,
    device_in: DeviceUpdate,
) -> Any:
    """
    Update a Device's address or Node assignment.
    """
    device = session.get(Device, id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    if device_in.addr is not None and device_in.addr != device.addr:
        existing = crud.get_device_by_addr(session=session, addr=device_in.addr)
        if existing:
            raise HTTPException(
                status_code=400,
                detail="A device with this address already exists.",
            )

    update_dict = device_in.model_dump(exclude_unset=True)
    device.sqlmodel_update(update_dict)
    session.add(device)
    session.commit()
    session.refresh(device)
    return device


@router.delete("/{id}", dependencies=[Depends(get_current_active_superuser)])
def delete_device(session: SessionDep, id: uuid.UUID) -> Message:
    """
    Delete a Device.
    """
    device = session.get(Device, id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    session.delete(device)
    session.commit()
    return Message(message="Device deleted successfully")
