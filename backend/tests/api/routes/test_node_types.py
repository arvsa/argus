"""
CRUD lifecycle tests for /node-types.

Requires a live DB (run inside Docker: docker compose exec backend pytest).
"""
import uuid

from fastapi.testclient import TestClient

from app.core.config import settings
from tests.utils.utils import get_superuser_token_headers, random_lower_string

API = settings.API_V1_STR


def _su(client: TestClient) -> dict[str, str]:
    return get_superuser_token_headers(client)


def test_create_root_node_type(client: TestClient) -> None:
    tenant_id = random_lower_string()
    headers = _su(client)
    r = client.post(
        f"{API}/node-types/", headers=headers,
        json={"tenant_id": tenant_id, "name": "Campus", "rank": 0},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["name"] == "Campus"
    assert data["rank"] == 0
    assert data["parent_type_id"] is None


def test_create_child_node_type(client: TestClient) -> None:
    tenant_id = random_lower_string()
    headers = _su(client)
    root = client.post(
        f"{API}/node-types/", headers=headers,
        json={"tenant_id": tenant_id, "name": "Campus", "rank": 0},
    ).json()
    r = client.post(
        f"{API}/node-types/", headers=headers,
        json={"tenant_id": tenant_id, "name": "Building", "rank": 1, "parent_type_id": root["id"]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["parent_type_id"] == root["id"]


def test_create_node_type_invalid_rank_chain_returns_400(client: TestClient) -> None:
    tenant_id = random_lower_string()
    headers = _su(client)
    r = client.post(
        f"{API}/node-types/", headers=headers,
        json={"tenant_id": tenant_id, "name": "Campus", "rank": 5},
    )
    assert r.status_code == 400, r.text


def test_read_node_type(client: TestClient) -> None:
    tenant_id = random_lower_string()
    headers = _su(client)
    created = client.post(
        f"{API}/node-types/", headers=headers,
        json={"tenant_id": tenant_id, "name": "Campus", "rank": 0},
    ).json()
    r = client.get(f"{API}/node-types/{created['id']}", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["id"] == created["id"]


def test_read_node_type_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.get(f"{API}/node-types/{uuid.uuid4()}", headers=headers)
    assert r.status_code == 404


def test_list_node_types(client: TestClient) -> None:
    tenant_id = random_lower_string()
    headers = _su(client)
    client.post(
        f"{API}/node-types/", headers=headers,
        json={"tenant_id": tenant_id, "name": "Campus", "rank": 0},
    )
    r = client.get(f"{API}/node-types/", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "data" in body and "count" in body
    assert body["count"] >= 1


def test_update_node_type_name(client: TestClient) -> None:
    tenant_id = random_lower_string()
    headers = _su(client)
    created = client.post(
        f"{API}/node-types/", headers=headers,
        json={"tenant_id": tenant_id, "name": "Campus", "rank": 0},
    ).json()
    new_name = f"renamed-{random_lower_string()[:8]}"
    r = client.put(
        f"{API}/node-types/{created['id']}", headers=headers, json={"name": new_name}
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == new_name


def test_update_node_type_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.put(f"{API}/node-types/{uuid.uuid4()}", headers=headers, json={"name": "x"})
    assert r.status_code == 404


def test_delete_node_type(client: TestClient) -> None:
    tenant_id = random_lower_string()
    headers = _su(client)
    created = client.post(
        f"{API}/node-types/", headers=headers,
        json={"tenant_id": tenant_id, "name": "Campus", "rank": 0},
    ).json()
    r = client.delete(f"{API}/node-types/{created['id']}", headers=headers)
    assert r.status_code == 200, r.text
    assert client.get(f"{API}/node-types/{created['id']}", headers=headers).status_code == 404


def test_delete_node_type_with_nodes_returns_409(client: TestClient) -> None:
    tenant_id = random_lower_string()
    headers = _su(client)
    node_type = client.post(
        f"{API}/node-types/", headers=headers,
        json={"tenant_id": tenant_id, "name": "Campus", "rank": 0},
    ).json()
    client.post(
        f"{API}/nodes/", headers=headers,
        json={"name": "Main Campus", "node_type_id": node_type["id"]},
    )
    r = client.delete(f"{API}/node-types/{node_type['id']}", headers=headers)
    assert r.status_code == 409, r.text
