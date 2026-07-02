"""
CRUD lifecycle tests for /nodes.

Requires a live DB (run inside Docker: docker compose exec backend pytest).
"""
import uuid

from fastapi.testclient import TestClient

from app.core.config import settings
from tests.utils.utils import get_superuser_token_headers, random_lower_string

API = settings.API_V1_STR


def _su(client: TestClient) -> dict[str, str]:
    return get_superuser_token_headers(client)


def _root_type(client: TestClient, headers: dict[str, str], tenant_id: str) -> dict:
    return client.post(
        f"{API}/node-types/", headers=headers,
        json={"tenant_id": tenant_id, "name": "Campus", "rank": 0},
    ).json()


def _child_type(client: TestClient, headers: dict[str, str], tenant_id: str, parent_type_id: str) -> dict:
    return client.post(
        f"{API}/node-types/", headers=headers,
        json={"tenant_id": tenant_id, "name": "Building", "rank": 1, "parent_type_id": parent_type_id},
    ).json()


def test_create_root_node(client: TestClient) -> None:
    tenant_id = random_lower_string()
    headers = _su(client)
    root_type = _root_type(client, headers, tenant_id)
    r = client.post(
        f"{API}/nodes/", headers=headers,
        json={"name": "Main Campus", "node_type_id": root_type["id"]},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["parent_id"] is None
    assert data["path_ids"] == []


def test_create_child_node(client: TestClient) -> None:
    tenant_id = random_lower_string()
    headers = _su(client)
    root_type = _root_type(client, headers, tenant_id)
    child_type = _child_type(client, headers, tenant_id, root_type["id"])
    root = client.post(
        f"{API}/nodes/", headers=headers,
        json={"name": "Main Campus", "node_type_id": root_type["id"]},
    ).json()
    r = client.post(
        f"{API}/nodes/", headers=headers,
        json={"name": "Building A", "node_type_id": child_type["id"], "parent_id": root["id"]},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["parent_id"] == root["id"]
    assert data["path_ids"] == [root["id"]]


def test_create_node_type_mismatch_returns_400(client: TestClient) -> None:
    tenant_id = random_lower_string()
    headers = _su(client)
    root_type = _root_type(client, headers, tenant_id)

    other_tenant = random_lower_string()
    other_root_type = _root_type(client, headers, other_tenant)
    other_root = client.post(
        f"{API}/nodes/", headers=headers,
        json={"name": "Other", "node_type_id": other_root_type["id"]},
    ).json()

    r = client.post(
        f"{API}/nodes/", headers=headers,
        json={"name": "bad", "node_type_id": root_type["id"], "parent_id": other_root["id"]},
    )
    assert r.status_code == 400, r.text


def test_read_node(client: TestClient) -> None:
    tenant_id = random_lower_string()
    headers = _su(client)
    root_type = _root_type(client, headers, tenant_id)
    node = client.post(
        f"{API}/nodes/", headers=headers,
        json={"name": "Main Campus", "node_type_id": root_type["id"]},
    ).json()
    r = client.get(f"{API}/nodes/{node['id']}", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["id"] == node["id"]


def test_read_node_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.get(f"{API}/nodes/{uuid.uuid4()}", headers=headers)
    assert r.status_code == 404


def test_list_nodes(client: TestClient) -> None:
    tenant_id = random_lower_string()
    headers = _su(client)
    root_type = _root_type(client, headers, tenant_id)
    client.post(
        f"{API}/nodes/", headers=headers,
        json={"name": "Main Campus", "node_type_id": root_type["id"]},
    )
    r = client.get(f"{API}/nodes/", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "data" in body and "count" in body
    assert body["count"] >= 1


def test_update_node_name(client: TestClient) -> None:
    tenant_id = random_lower_string()
    headers = _su(client)
    root_type = _root_type(client, headers, tenant_id)
    node = client.post(
        f"{API}/nodes/", headers=headers,
        json={"name": "Main Campus", "node_type_id": root_type["id"]},
    ).json()
    new_name = f"renamed-{random_lower_string()[:8]}"
    r = client.put(f"{API}/nodes/{node['id']}", headers=headers, json={"name": new_name})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == new_name


def test_update_node_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.put(f"{API}/nodes/{uuid.uuid4()}", headers=headers, json={"name": "x"})
    assert r.status_code == 404


def test_delete_node_cascades_to_children(client: TestClient) -> None:
    tenant_id = random_lower_string()
    headers = _su(client)
    root_type = _root_type(client, headers, tenant_id)
    child_type = _child_type(client, headers, tenant_id, root_type["id"])
    root = client.post(
        f"{API}/nodes/", headers=headers,
        json={"name": "Main Campus", "node_type_id": root_type["id"]},
    ).json()
    child = client.post(
        f"{API}/nodes/", headers=headers,
        json={"name": "Building A", "node_type_id": child_type["id"], "parent_id": root["id"]},
    ).json()

    r = client.delete(f"{API}/nodes/{root['id']}", headers=headers)
    assert r.status_code == 200, r.text
    assert client.get(f"{API}/nodes/{child['id']}", headers=headers).status_code == 404
