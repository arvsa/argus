import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

from app.api.deps import CurrentUser, SessionDep
from app.models import (
    Campus,
    CampusCreate,
    CampusesPublic,
    CampusPublic,
    CampusUpdate,
    Message,
)

router = APIRouter(prefix="/campuses", tags=["campuses"])


@router.get("/", response_model=CampusesPublic)
def read_campuses(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """
    Retrieve Campuses.
    """

    if current_user.is_superuser:
        count_statement = select(func.count()).select_from(Campus)
        count = session.exec(count_statement).one()
        statement = (
            select(Campus).order_by(col(Campus.created_at).desc()).offset(skip).limit(limit)
        )
        campuses = session.exec(statement).all()
    else:
        count_statement = (
            select(func.count())
            .select_from(Campus)
        )
        count = session.exec(count_statement).one()
        statement = (
            select(Campus)
            .order_by(col(Campus.created_at).desc())
            .offset(skip)
            .limit(limit)
        )
        campuses = session.exec(statement).all()

    return CampusesPublic(data=campuses, count=count)


@router.get("/{id}", response_model=CampusPublic)
def read_campus(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """
    Get campus by ID.
    """
    campus = session.get(Campus, id)
    if not campus:
        raise HTTPException(status_code=404, detail="Campus not found")
    # if not current_user.is_superuser and (campus.owner_id != current_user.id):
    #     raise HTTPException(status_code=403, detail="Not enough permissions")
    return campus


@router.post("/", response_model=CampusPublic)
def create_campus(
    *, session: SessionDep, current_user: CurrentUser, campus_in: CampusCreate
) -> Any:
    """
    Create new campus.
    """
    campus = Campus.model_validate(campus_in)
    session.add(campus)
    session.commit()
    session.refresh(campus)
    return campus


@router.put("/{id}", response_model=CampusPublic)
def update_campus(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    campus_in: CampusUpdate,
) -> Any:
    """
    Update a campus.
    """
    campus = session.get(Campus, id)
    if not campus:
        raise HTTPException(status_code=404, detail="Campus not found")
    # if not current_user.is_superuser and (campus.owner_id != current_user.id):
    #     raise HTTPException(status_code=403, detail="Not enough permissions")
    
    update_dict = campus_in.model_dump(exclude_unset=True)
    campus.sqlmodel_update(update_dict)
    session.add(campus)
    session.commit()
    session.refresh(campus)
    return campus


@router.delete("/{id}")
def delete_campus(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Message:
    """
    Delete a campus.
    """
    campus = session.get(Campus, id)
    if not campus:
        raise HTTPException(status_code=404, detail="Campus not found")
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    session.delete(campus)
    session.commit()
    return Message(message="Campus deleted successfully")
