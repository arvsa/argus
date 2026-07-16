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
from app.models import (
    Device,
    DeviceCreate,
    DevicePublic,
    DevicesPublic,
    DeviceUpdate,
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


def build_targets_export(session: Session) -> str:
    """
    Render every Device as pingsvc's target-file body (see
    pingsvc/cmd/pingsvc/main.go's parseTargetLine and
    plan/device-node-assignment-bridge-v1.md): one line per device, either
    a bare "addr" (unassigned) or "addr,ancestor1;ancestor2;...;node_id"
    (root-first ancestors from Node.path_ids, then the assigned node
    itself last). Shared by the human-facing /targets-export and the
    pingsvc-facing /targets-hash and /targets-export-internal below, so
    the hash pingsvc compares against can never drift from the body it
    would actually fetch.
    """
    devices = session.exec(select(Device)).all()
    lines = []
    for device in devices:
        if device.node_id is None:
            lines.append(device.addr)
            continue
        node = session.get(Node, device.node_id)
        if node is None:
            # Shouldn't happen (ondelete=SET NULL keeps this in sync), but
            # degrade to a bare address rather than erroring the whole export.
            lines.append(device.addr)
            continue
        chain = [*node.path_ids, str(node.id)]
        lines.append(f"{device.addr},{';'.join(chain)}")
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
