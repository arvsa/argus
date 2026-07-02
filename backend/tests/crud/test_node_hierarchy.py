import uuid

import pytest
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session

from app import crud
from app.models import NodeCreate, NodeTypeCreate
from tests.utils.utils import random_lower_string


def _root_type(tenant_id: str) -> NodeTypeCreate:
    return NodeTypeCreate(tenant_id=tenant_id, name="Campus", rank=0)


def _child_type(tenant_id: str, parent_type_id, rank: int = 1) -> NodeTypeCreate:
    return NodeTypeCreate(
        tenant_id=tenant_id, name="Building", rank=rank, parent_type_id=parent_type_id
    )


# ── NodeType creation ─────────────────────────────────────────────────────

def test_create_root_node_type(db: Session) -> None:
    tenant_id = random_lower_string()
    node_type = crud.create_node_type(session=db, node_type_create=_root_type(tenant_id))
    assert node_type.rank == 0
    assert node_type.parent_type_id is None


def test_create_child_node_type(db: Session) -> None:
    tenant_id = random_lower_string()
    root = crud.create_node_type(session=db, node_type_create=_root_type(tenant_id))
    child = crud.create_node_type(
        session=db, node_type_create=_child_type(tenant_id, root.id)
    )
    assert child.parent_type_id == root.id
    assert child.rank == 1


def test_root_node_type_with_nonzero_rank_raises(db: Session) -> None:
    tenant_id = random_lower_string()
    with pytest.raises(ValueError):
        crud.create_node_type(
            session=db,
            node_type_create=NodeTypeCreate(tenant_id=tenant_id, name="Campus", rank=1),
        )


def test_child_node_type_rank_must_follow_parent(db: Session) -> None:
    tenant_id = random_lower_string()
    root = crud.create_node_type(session=db, node_type_create=_root_type(tenant_id))
    with pytest.raises(ValueError):
        crud.create_node_type(
            session=db,
            node_type_create=_child_type(tenant_id, root.id, rank=2),
        )


def test_node_type_unknown_parent_type_id_raises(db: Session) -> None:
    tenant_id = random_lower_string()
    with pytest.raises(ValueError):
        crud.create_node_type(
            session=db,
            node_type_create=_child_type(tenant_id, parent_type_id=uuid.uuid4()),
        )


def test_node_type_tenant_rank_must_be_unique(db: Session) -> None:
    tenant_id = random_lower_string()
    crud.create_node_type(session=db, node_type_create=_root_type(tenant_id))
    with pytest.raises(IntegrityError):
        crud.create_node_type(session=db, node_type_create=_root_type(tenant_id))
    db.rollback()


# ── Node creation ──────────────────────────────────────────────────────────

def test_create_root_node(db: Session) -> None:
    tenant_id = random_lower_string()
    root_type = crud.create_node_type(session=db, node_type_create=_root_type(tenant_id))
    node = crud.create_node(
        session=db,
        node_create=NodeCreate(name="Main Campus", node_type_id=root_type.id),
    )
    assert node.parent_id is None
    assert node.path_ids == []


def test_root_node_type_requires_no_parent_id(db: Session) -> None:
    tenant_id = random_lower_string()
    root_type = crud.create_node_type(session=db, node_type_create=_root_type(tenant_id))
    other_root = crud.create_node(
        session=db,
        node_create=NodeCreate(name="Other Campus", node_type_id=root_type.id),
    )
    with pytest.raises(ValueError):
        # root_type has no parent_type_id, so passing parent_id should still be
        # rejected because the *type chain* (parent_type_id is None) doesn't allow it
        crud.create_node(
            session=db,
            node_create=NodeCreate(
                name="bad", node_type_id=root_type.id, parent_id=other_root.id
            ),
        )


def test_child_node_computes_path_ids(db: Session) -> None:
    tenant_id = random_lower_string()
    root_type = crud.create_node_type(session=db, node_type_create=_root_type(tenant_id))
    child_type = crud.create_node_type(
        session=db, node_type_create=_child_type(tenant_id, root_type.id)
    )
    root = crud.create_node(
        session=db, node_create=NodeCreate(name="Main Campus", node_type_id=root_type.id)
    )
    child = crud.create_node(
        session=db,
        node_create=NodeCreate(
            name="Building A", node_type_id=child_type.id, parent_id=root.id
        ),
    )
    assert child.path_ids == [str(root.id)]


def test_child_node_without_parent_id_raises(db: Session) -> None:
    tenant_id = random_lower_string()
    root_type = crud.create_node_type(session=db, node_type_create=_root_type(tenant_id))
    child_type = crud.create_node_type(
        session=db, node_type_create=_child_type(tenant_id, root_type.id)
    )
    with pytest.raises(ValueError):
        crud.create_node(
            session=db,
            node_create=NodeCreate(name="Building A", node_type_id=child_type.id),
        )


def test_node_parent_type_mismatch_raises(db: Session) -> None:
    tenant_id = random_lower_string()
    root_type = crud.create_node_type(session=db, node_type_create=_root_type(tenant_id))
    child_type = crud.create_node_type(
        session=db, node_type_create=_child_type(tenant_id, root_type.id)
    )
    # A second, unrelated root node of the wrong type to be used as parent
    other_root_type_id = crud.create_node_type(
        session=db,
        node_type_create=NodeTypeCreate(
            tenant_id=random_lower_string(), name="Region", rank=0
        ),
    ).id
    wrong_root = crud.create_node(
        session=db,
        node_create=NodeCreate(name="Region 1", node_type_id=other_root_type_id),
    )
    with pytest.raises(ValueError):
        crud.create_node(
            session=db,
            node_create=NodeCreate(
                name="Building A", node_type_id=child_type.id, parent_id=wrong_root.id
            ),
        )


def test_grandchild_node_path_ids_accumulate(db: Session) -> None:
    tenant_id = random_lower_string()
    campus_type = crud.create_node_type(session=db, node_type_create=_root_type(tenant_id))
    building_type = crud.create_node_type(
        session=db, node_type_create=_child_type(tenant_id, campus_type.id, rank=1)
    )
    room_type = crud.create_node_type(
        session=db,
        node_type_create=NodeTypeCreate(
            tenant_id=tenant_id, name="Room", rank=2, parent_type_id=building_type.id
        ),
    )
    campus = crud.create_node(
        session=db, node_create=NodeCreate(name="Main Campus", node_type_id=campus_type.id)
    )
    building = crud.create_node(
        session=db,
        node_create=NodeCreate(
            name="Building A", node_type_id=building_type.id, parent_id=campus.id
        ),
    )
    room = crud.create_node(
        session=db,
        node_create=NodeCreate(
            name="Room 101", node_type_id=room_type.id, parent_id=building.id
        ),
    )
    assert room.path_ids == [str(campus.id), str(building.id)]


def test_delete_parent_node_cascades_to_children(db: Session) -> None:
    tenant_id = random_lower_string()
    root_type = crud.create_node_type(session=db, node_type_create=_root_type(tenant_id))
    child_type = crud.create_node_type(
        session=db, node_type_create=_child_type(tenant_id, root_type.id)
    )
    root = crud.create_node(
        session=db, node_create=NodeCreate(name="Main Campus", node_type_id=root_type.id)
    )
    child = crud.create_node(
        session=db,
        node_create=NodeCreate(
            name="Building A", node_type_id=child_type.id, parent_id=root.id
        ),
    )
    child_id = child.id

    db.delete(root)
    db.commit()

    from app.models import Node

    assert db.get(Node, child_id) is None
