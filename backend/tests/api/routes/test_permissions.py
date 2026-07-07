"""
Superuser-only enforcement on write routes.

CLAUDE.md documents the intended security model: "Most write operations
require is_superuser=True."

These tests exercise every create/update/delete route across the
NodeType -> Node hierarchy with a normal (non-superuser) authenticated user
and assert they are rejected with 403.

Requires a live DB + Redis (run inside Docker: docker compose exec backend pytest).
"""
from fastapi.testclient import TestClient

from app import crud
from app.core.config import settings
from app.models import NodeCreate, NodeTypeCreate
from tests.utils.utils import random_lower_string

API = settings.API_V1_STR


# ── NodeType ─────────────────────────────────────────────────────────────────

def test_normal_user_cannot_create_node_type(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    r = client.post(
        f"{API}/node-types/",
        headers=normal_user_token_headers,
        json={"tenant_id": random_lower_string(), "name": "Campus", "rank": 0},
    )
    assert r.status_code == 403, r.text


def test_normal_user_cannot_update_node_type(
    client: TestClient, normal_user_token_headers: dict[str, str], db
) -> None:
    tenant_id = random_lower_string()
    node_type = crud.create_node_type(
        session=db,
        node_type_create=NodeTypeCreate(tenant_id=tenant_id, name="Campus", rank=0),
    )
    r = client.put(
        f"{API}/node-types/{node_type.id}",
        headers=normal_user_token_headers,
        json={"name": "renamed"},
    )
    assert r.status_code == 403, r.text


def test_normal_user_cannot_delete_node_type(
    client: TestClient, normal_user_token_headers: dict[str, str], db
) -> None:
    tenant_id = random_lower_string()
    node_type = crud.create_node_type(
        session=db,
        node_type_create=NodeTypeCreate(tenant_id=tenant_id, name="Campus", rank=0),
    )
    r = client.delete(
        f"{API}/node-types/{node_type.id}", headers=normal_user_token_headers
    )
    assert r.status_code == 403, r.text


# ── Node ───────────────────────────────────────────────────────────────────

def test_normal_user_cannot_create_node(
    client: TestClient, normal_user_token_headers: dict[str, str], db
) -> None:
    tenant_id = random_lower_string()
    node_type = crud.create_node_type(
        session=db,
        node_type_create=NodeTypeCreate(tenant_id=tenant_id, name="Campus", rank=0),
    )
    r = client.post(
        f"{API}/nodes/",
        headers=normal_user_token_headers,
        json={"name": "rogue-node", "node_type_id": str(node_type.id)},
    )
    assert r.status_code == 403, r.text


def test_normal_user_cannot_update_node(
    client: TestClient, normal_user_token_headers: dict[str, str], db
) -> None:
    tenant_id = random_lower_string()
    node_type = crud.create_node_type(
        session=db,
        node_type_create=NodeTypeCreate(tenant_id=tenant_id, name="Campus", rank=0),
    )
    node = crud.create_node(
        session=db,
        node_create=NodeCreate(
            name="Main Campus", node_type_id=node_type.id
        ),
    )
    r = client.put(
        f"{API}/nodes/{node.id}",
        headers=normal_user_token_headers,
        json={"name": "renamed"},
    )
    assert r.status_code == 403, r.text


def test_normal_user_cannot_delete_node(
    client: TestClient, normal_user_token_headers: dict[str, str], db
) -> None:
    tenant_id = random_lower_string()
    node_type = crud.create_node_type(
        session=db,
        node_type_create=NodeTypeCreate(tenant_id=tenant_id, name="Campus", rank=0),
    )
    node = crud.create_node(
        session=db,
        node_create=NodeCreate(
            name="Main Campus", node_type_id=node_type.id
        ),
    )
    r = client.delete(f"{API}/nodes/{node.id}", headers=normal_user_token_headers)
    assert r.status_code == 403, r.text


# ── Unauthenticated requests are rejected, not silently allowed ─────────────

def test_unauthenticated_cannot_create_node_type(client: TestClient) -> None:
    r = client.post(
        f"{API}/node-types/",
        json={"tenant_id": random_lower_string(), "name": "Campus", "rank": 0},
    )
    assert r.status_code == 401, r.text
