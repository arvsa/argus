import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import func, select

from app import crud
from app.api.deps import CurrentUser, SessionDep, get_current_active_superuser
from app.models import (
    Device,
    DeviceCreate,
    DevicePublic,
    DevicesPublic,
    DeviceUpdate,
    Message,
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
    Create a new Device.
    """
    existing = crud.get_device_by_addr(session=session, addr=device_in.addr)
    if existing:
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
