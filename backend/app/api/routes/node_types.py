import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlmodel import func, select

from app import crud
from app.api.deps import CurrentUser, SessionDep
from app.models import (
    Message,
    NodeType,
    NodeTypeCreate,
    NodeTypePublic,
    NodeTypesPublic,
    NodeTypeUpdate,
)

router = APIRouter(prefix="/node-types", tags=["node-types"])


@router.get("/", response_model=NodeTypesPublic)
def read_node_types(
    session: SessionDep,
    current_user: CurrentUser,
    skip: int = 0,
    limit: int = 100,
    tenant_id: str | None = None,
) -> Any:
    """
    Retrieve NodeTypes (the per-tenant hierarchy shape, see
    plan/dynamic-hierarchy-multi-zone-architecture.md §4.1).

    tenant_id: filter to a single tenant's rank chain -- omitting it
    applies no filter, for backward compatibility with existing callers.
    """
    count_statement = select(func.count()).select_from(NodeType)
    statement = select(NodeType)

    if tenant_id is not None:
        count_statement = count_statement.where(NodeType.tenant_id == tenant_id)
        statement = statement.where(NodeType.tenant_id == tenant_id)

    count = session.exec(count_statement).one()
    node_types = session.exec(statement.offset(skip).limit(limit)).all()
    return NodeTypesPublic(data=node_types, count=count)


@router.get("/{id}", response_model=NodeTypePublic)
def read_node_type(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """
    Get a NodeType by ID.
    """
    node_type = session.get(NodeType, id)
    if not node_type:
        raise HTTPException(status_code=404, detail="NodeType not found")
    return node_type


@router.post("/", response_model=NodeTypePublic)
def create_node_type(
    *, session: SessionDep, current_user: CurrentUser, node_type_in: NodeTypeCreate
) -> Any:
    """
    Create a new NodeType, extending its tenant's rank chain by exactly
    one level.
    """
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    try:
        return crud.create_node_type(session=session, node_type_create=node_type_in)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.put("/{id}", response_model=NodeTypePublic)
def update_node_type(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    node_type_in: NodeTypeUpdate,
) -> Any:
    """
    Rename a NodeType. rank/parent_type_id are structural and not editable
    here -- see NodeTypeUpdate's doc comment.
    """
    node_type = session.get(NodeType, id)
    if not node_type:
        raise HTTPException(status_code=404, detail="NodeType not found")
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Not enough permissions")

    update_dict = node_type_in.model_dump(exclude_unset=True)
    node_type.sqlmodel_update(update_dict)
    session.add(node_type)
    session.commit()
    session.refresh(node_type)
    return node_type


@router.delete("/{id}")
def delete_node_type(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Message:
    """
    Delete a NodeType. Fails with 409 if any Node still references it (the
    DB's FK constraint enforces this -- deleting a type still in use would
    orphan its instances).
    """
    node_type = session.get(NodeType, id)
    if not node_type:
        raise HTTPException(status_code=404, detail="NodeType not found")
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Not enough permissions")

    session.delete(node_type)
    try:
        session.commit()
    except IntegrityError as e:
        session.rollback()
        raise HTTPException(
            status_code=409,
            detail="Cannot delete a NodeType that still has Nodes referencing it",
        ) from e
    return Message(message="NodeType deleted successfully")
