import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import func, select

from app import crud
from app.api.deps import CurrentUser, SessionDep
from app.models import Message, Node, NodeCreate, NodePublic, NodesPublic, NodeUpdate

router = APIRouter(prefix="/nodes", tags=["nodes"])


@router.get("/", response_model=NodesPublic)
def read_nodes(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """
    Retrieve Nodes (instances of the dynamic hierarchy, see
    plan/dynamic-hierarchy-multi-zone-architecture.md §4.1).
    """
    count_statement = select(func.count()).select_from(Node)
    count = session.exec(count_statement).one()
    statement = select(Node).offset(skip).limit(limit)
    nodes = session.exec(statement).all()
    return NodesPublic(data=nodes, count=count)


@router.get("/{id}", response_model=NodePublic)
def read_node(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """
    Get a Node by ID.
    """
    node = session.get(Node, id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    return node


@router.post("/", response_model=NodePublic)
def create_node(
    *, session: SessionDep, current_user: CurrentUser, node_in: NodeCreate
) -> Any:
    """
    Create a new Node, validated against its NodeType's parent chain.
    """
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    try:
        return crud.create_node(session=session, node_create=node_in)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.put("/{id}", response_model=NodePublic)
def update_node(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    node_in: NodeUpdate,
) -> Any:
    """
    Rename a Node. node_type_id/parent_id are structural and not editable
    here -- see NodeUpdate's doc comment.
    """
    node = session.get(Node, id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Not enough permissions")

    update_dict = node_in.model_dump(exclude_unset=True)
    node.sqlmodel_update(update_dict)
    session.add(node)
    session.commit()
    session.refresh(node)
    return node


@router.delete("/{id}")
def delete_node(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Message:
    """
    Delete a Node. Cascades to any descendant Nodes (parent_id has
    ondelete=CASCADE).
    """
    node = session.get(Node, id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    if not current_user.is_superuser:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    session.delete(node)
    session.commit()
    return Message(message="Node deleted successfully")
