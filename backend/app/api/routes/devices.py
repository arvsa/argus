import io
import uuid
from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile
from sqlmodel import col, delete, func, select

from app.api.deps import CurrentUser, SessionDep
from app.api.routes.utils import _is_csv_filename, _parse_csv
from app.core.redis import get_sync_redis_client
from app.models import Device, DeviceCreate, DevicePublic, DevicesPublic, Message

router = APIRouter(prefix="/devices", tags=["devices"])


@router.get("/", response_model=DevicesPublic)
def read_devices(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """
    Retrieve Devices.
    """

    count_statement = select(func.count()).select_from(Device)
    count = session.exec(count_statement).one()
    statement = (
        select(Device)
        .order_by(col(Device.created_at).desc())
        .offset(skip)
        .limit(limit)
    )
    devices = session.exec(statement).all()
    return DevicesPublic(data=devices, count=count)


@router.get("/{id}", response_model=DevicePublic)
def read_device(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """
    Get device by ID.
    """
    device = session.get(Device, id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    # if not current_user.is_superuser and (device.owner_id != current_user.id):
    #     raise HTTPException(status_code=403, detail="Not enough permissions")
    return device


@router.post("/", response_model=DevicePublic)
def create_device(
    *, session: SessionDep, current_user: CurrentUser, device_in: DeviceCreate
) -> Any:
    """
    Create new device.
    """
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Not enough permissions")

    device = Device.model_validate(device_in)
    session.add(device)
    session.commit()
    session.refresh(device)

    # Cache
    redis = get_sync_redis_client()
    pipe = redis.pipeline()
    pipe.sadd(f"members:room:{device.room_id}", device.ip_address)
    pipe.execute()
    return device


@router.put("/{id}", response_model=DevicePublic)
def update_device(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    device_in: DeviceCreate,
) -> Any:
    """
    Update a device.
    """
    device = session.get(Device, id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Not enough permissions")

    old_room_id = device.room_id
    old_ip = device.ip_address

    update_dict = device_in.model_dump(exclude_unset=True)
    device.sqlmodel_update(update_dict)
    session.add(device)
    session.commit()
    session.refresh(device)

    redis = get_sync_redis_client()
    pipe = redis.pipeline()
    pipe.srem(f"members:room:{old_room_id}", old_ip)
    if device.room_id:
        pipe.sadd(f"members:room:{device.room_id}", device.ip_address)
    pipe.execute()

    return device


@router.delete("/{id}")
def delete_device(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Message:
    """
    Delete a device.
    """
    device = session.get(Device, id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Not enough permissions")

    room_id = device.room_id
    ip = device.ip_address

    session.delete(device)
    session.commit()

    if room_id:
        redis = get_sync_redis_client()
        redis.srem(f"members:room:{room_id}", ip)

    return Message(message="Device deleted successfully")


@router.post(
    "/upload",
    response_model=DevicesPublic,
)
async def bulk_upload(
    *,
    file: UploadFile = File(...),
    session: SessionDep,
    current_user: CurrentUser,
    dry_run: bool = False,
) -> Any:
    """
    Upload a CSV to validate and (re)create the devices table.

    - File must be CSV with a header row whose column names match DeviceCreate field names (case-sensitive).
    - If `dry_run=true` the server will validate and return errors without modifying the DB.
    - On success (non-dry-run), existing devices are deleted and replaced with the CSV contents in one transaction.
    """
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Not enough permissions")

    if not _is_csv_filename(file.filename):
        raise HTTPException(status_code=400, detail="Upload must be a .csv file")

    try:
        # UploadFile.file is a SpooledTemporaryFile -> binary; wrap to text.
        # Annotated as the common io.TextIOBase (matching _parse_csv's param
        # type) since the except branch below falls back to io.StringIO.
        text_stream: io.TextIOBase = io.TextIOWrapper(
            file.file, encoding="utf-8", newline=""
        )
    except Exception:
        content = file.file.read()
        text_stream = io.StringIO(content.decode("utf-8", errors="replace"))

    rows, parse_errors = _parse_csv(text_stream)

    try:
        text_stream.detach()
    except Exception:
        pass

    if parse_errors:
        try:
            await file.close()
        finally:
            pass
        raise HTTPException(status_code=400, detail={"parse_errors": parse_errors})

    if not rows:
        try:
            await file.close()
        finally:
            pass
        raise HTTPException(status_code=400, detail="CSV contains no data rows")

    created_devices: list[Device] = []
    row_errors: dict[int, list[str]] = {}

    for idx, row in enumerate(rows, start=1):
        try:
            filtered = {k: v for k, v in row.items() if k in DeviceCreate.model_fields}
            device_in = DeviceCreate(**filtered)
            device = Device.model_validate(device_in)
            created_devices.append(device)
        except Exception as exc:
            # collect error message(s)
            row_errors[idx] = [str(exc)]

    if row_errors:
        try:
            await file.close()
        except Exception:
            pass
        raise HTTPException(
            status_code=422,
            detail={
                "validation_errors": row_errors,
                "valid_rows": len(created_devices),
            },
        )

    # If dry-run, return summary without touching DB Will be removed
    if dry_run and len(created_devices) < 1000:
        try:
            await file.close()
        finally:
            pass
        return DevicesPublic(
            data=[DevicePublic.model_validate(d) for d in created_devices],
            count=len(created_devices),
        )

    try:
        # start transaction
        session.exec(delete(Device))

        session.add_all(created_devices)
        session.commit()
        # refresh instances to load defaults/ids if needed
        for d in created_devices:
            session.refresh(d)
    except Exception as exc:
        session.rollback()
        try:
            await file.close()
        finally:
            pass
        raise HTTPException(
            status_code=500, detail=f"Database error during bulk update: {exc}"
        )

    try:
        await file.close()
    except Exception:
        pass

    return DevicesPublic(
        data=[DevicePublic.model_validate(d) for d in created_devices[:1000]],
        count=len(created_devices),
    )
