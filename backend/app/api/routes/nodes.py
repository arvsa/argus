import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

from app import crud
from app.api.deps import CurrentUser, SessionDep
from app.models import (
    Message,
    Node,
    NodeCreate,
    NodePublic,
    NodesPublic,
    NodeType,
    NodeUpdate,
)

router = APIRouter(prefix="/nodes", tags=["nodes"])


@router.get("/", response_model=NodesPublic)
def read_nodes(
    session: SessionDep,
    current_user: CurrentUser,
    skip: int = 0,
    limit: int = 100,
    parent_id: str | None = None,
    tenant_id: str | None = None,
) -> Any:
    """
    Retrieve Nodes (instances of the dynamic hierarchy, see
    plan/dynamic-hierarchy-multi-zone-architecture.md §4.1).

    parent_id: filter to direct children of a given Node id. Pass the
    literal string "null" to fetch root nodes (parent_id IS NULL) --
    omitting the parameter entirely applies no filter, for backward
    compatibility with existing callers.
    tenant_id: filter to a single tenant's Nodes (joins through NodeType,
    since tenant_id isn't a column on Node itself).
    """
    count_statement = select(func.count()).select_from(Node)
    statement = select(Node)

    if tenant_id is not None:
        count_statement = count_statement.join(
            NodeType, col(Node.node_type_id) == col(NodeType.id)
        ).where(NodeType.tenant_id == tenant_id)
        statement = statement.join(
            NodeType, col(Node.node_type_id) == col(NodeType.id)
        ).where(NodeType.tenant_id == tenant_id)

    if parent_id is not None:
        if parent_id == "null":
            count_statement = count_statement.where(Node.parent_id.is_(None))  # type: ignore[union-attr]
            statement = statement.where(Node.parent_id.is_(None))  # type: ignore[union-attr]
        else:
            try:
                parent_uuid = uuid.UUID(parent_id)
            except ValueError as e:
                raise HTTPException(
                    status_code=400, detail="parent_id must be a UUID or the literal string 'null'"
                ) from e
            count_statement = count_statement.where(Node.parent_id == parent_uuid)
            statement = statement.where(Node.parent_id == parent_uuid)

    count = session.exec(count_statement).one()
    nodes = session.exec(statement.offset(skip).limit(limit)).all()
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
