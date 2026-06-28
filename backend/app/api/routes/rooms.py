import json
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

from app.api.deps import CurrentUser, SessionDep
from app.core.redis import get_sync_redis_client
from app.models import Message, Room, RoomCreate, RoomPublic, RoomsPublic, RoomsUpdate

router = APIRouter(prefix="/rooms", tags=["rooms"])


@router.get("/", response_model=RoomsPublic)
def read_rooms(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """
    Retrieve Rooms.
    """

    if current_user.is_superuser:
        count_statement = select(func.count()).select_from(Room)
        count = session.exec(count_statement).one()
        statement = (
            select(Room).order_by(col(Room.created_at).desc()).offset(skip).limit(limit)
        )
        rooms = session.exec(statement).all()
    else:
        count_statement = (
            select(func.count())
            .select_from(Room)
        )
        count = session.exec(count_statement).one()
        statement = (
            select(Room)
            .order_by(col(Room.created_at).desc())
            .offset(skip)
            .limit(limit)
        )
        rooms = session.exec(statement).all()

    return RoomsPublic(data=rooms, count=count)


@router.get("/{id}", response_model=RoomPublic)
def read_room(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """
    Get room by ID.
    """
    room = session.get(Room, id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    # if not current_user.is_superuser and (room.owner_id != current_user.id):
    #     raise HTTPException(status_code=403, detail="Not enough permissions")
    return room


@router.post("/", response_model=RoomPublic)
def create_room(
    *, session: SessionDep, current_user: CurrentUser, room_in: RoomCreate
) -> Any:
    """
    Create new room.
    """
    room = Room.model_validate(room_in)
    session.add(room)
    session.commit()
    session.refresh(room)
    return room


@router.put("/{id}", response_model=RoomPublic)
def update_room(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    room_in: RoomsUpdate,
) -> Any:
    """
    Update a room.
    """
    room = session.get(Room, id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    # if not current_user.is_superuser and (room.owner_id != current_user.id):
    #     raise HTTPException(status_code=403, detail="Not enough permissions")

    update_dict = room_in.model_dump(exclude_unset=True)
    room.sqlmodel_update(update_dict)
    session.add(room)
    session.commit()
    session.refresh(room)
    return room


@router.delete("/{id}")
def delete_room(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Message:
    """
    Delete a room.
    """
    room = session.get(Room, id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    session.delete(room)
    session.commit()
    return Message(message="Room deleted successfully")

@router.get("/{id}/states", response_model=list[dict])
def read_room_states(
    session: SessionDep,
    # current_user: CurrentUser,
    id: uuid.UUID,
) -> Any:
    """
    Return current device states for a room (synchronous).
    Uses members:room:<roomID> set and pings:state hash.
    """
    # 1) Validate room exists
    room = session.get(Room, id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    # 2) Get the sync redis client
    redis = get_sync_redis_client()

    # 3) Get members (sync)
    members_key = f"members:room:{id}"
    try:
        addrs = redis.smembers(members_key)  # returns set() or list of strings if decode_responses=True
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"redis error: {e}")

    if not addrs:
        return []

    # 4) Pipeline HGETs for pings:state
    try:
        pipe = redis.pipeline()
        for a in addrs:
            pipe.hget("pings:state", a)
        results = pipe.execute()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"redis error: {e}")

    # 5) Parse JSON values and return list of dicts (skip missing or invalid entries)
    out = []
    for raw in results:
        if not raw:
            continue
        # raw is a string if decode_responses=True
        try:
            ev = json.loads(raw)
            out.append(ev)
        except json.JSONDecodeError:
            # skip malformed entries (or log)
            continue

    return out
