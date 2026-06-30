import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

from app.api.deps import CurrentUser, SessionDep
from app.models import Building, BuildingCreate, BuildingPublic, BuildingUpdate, BuildingsPublic, Room, RoomCreate, RoomPublic, CampusCreate, CampusPublic, CampusUpdate, CampusesPublic, Message, RoomsUpdate

router = APIRouter(prefix="/buildings", tags=["buildings"])


@router.get("/", response_model=BuildingsPublic)
def read_buildings(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """
    Retrieve Buildings.
    """

    if current_user.is_superuser:
        count_statement = select(func.count()).select_from(Building)
        count = session.exec(count_statement).one()
        statement = (
            select(Building).order_by(col(Building.created_at).desc()).offset(skip).limit(limit)
        )
        buildings = session.exec(statement).all()
    else:
        count_statement = (
            select(func.count())
            .select_from(Building)
        )
        count = session.exec(count_statement).one()
        statement = (
            select(Building)
            .order_by(col(Building.created_at).desc())
            .offset(skip)
            .limit(limit)
        )
        buildings = session.exec(statement).all()

    return BuildingsPublic(data=buildings, count=count)


@router.get("/{id}", response_model=BuildingPublic)
def read_building(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """
    Get building by ID.
    """
    building = session.get(Building, id)
    if not building:
        raise HTTPException(status_code=404, detail="Building not found")
    # if not current_user.is_superuser and (building.owner_id != current_user.id):
    #     raise HTTPException(status_code=403, detail="Not enough permissions")
    return building


@router.post("/", response_model=BuildingPublic)
def create_building(
    *, session: SessionDep, current_user: CurrentUser, building_in: BuildingCreate
) -> Any:
    """
    Create new building.
    """
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    building = Building.model_validate(building_in)
    session.add(building)
    session.commit()
    session.refresh(building)
    return building


@router.put("/{id}", response_model=BuildingPublic)
def update_building(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    building_in: BuildingUpdate,
) -> Any:
    """
    Update a building.
    """
    building = session.get(Building, id)
    if not building:
        raise HTTPException(status_code=404, detail="Building not found")
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    
    update_dict = building_in.model_dump(exclude_unset=True)
    building.sqlmodel_update(update_dict)
    session.add(building)
    session.commit()
    session.refresh(building)
    return building


@router.delete("/{id}")
def delete_building(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Message:
    """
    Delete a building.
    """
    building = session.get(Building, id)
    if not building:
        raise HTTPException(status_code=404, detail="Building not found")
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    session.delete(building)
    session.commit()
    return Message(message="Building deleted successfully")
