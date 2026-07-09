"""
CRUD lifecycle tests for /devices -- see plan/device-node-assignment-bridge-v1.md.

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
        f"{API}/node-types/",
        headers=headers,
        json={"tenant_id": tenant_id, "name": "Region", "rank": 0},
    ).json()


def _root_node(client: TestClient, headers: dict[str, str], node_type_id: str) -> dict:
    return client.post(
        f"{API}/nodes/",
        headers=headers,
        json={"name": "Main Region", "node_type_id": node_type_id},
    ).json()


def test_create_device_without_node(client: TestClient) -> None:
    headers = _su(client)
    addr = f"10.0.0.{random_lower_string()[:1]}"
    r = client.post(f"{API}/devices/", headers=headers, json={"addr": addr})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["addr"] == addr
    assert data["node_id"] is None


def test_create_device_with_node(client: TestClient) -> None:
    headers = _su(client)
    tenant_id = random_lower_string()
    root_type = _root_type(client, headers, tenant_id)
    node = _root_node(client, headers, root_type["id"])

    r = client.post(
        f"{API}/devices/",
        headers=headers,
        json={"addr": "192.0.2.50", "node_id": node["id"]},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["node_id"] == node["id"]


def test_create_device_duplicate_addr_returns_400(client: TestClient) -> None:
    headers = _su(client)
    addr = "192.0.2.51"
    r1 = client.post(f"{API}/devices/", headers=headers, json={"addr": addr})
    assert r1.status_code == 200, r1.text

    r2 = client.post(f"{API}/devices/", headers=headers, json={"addr": addr})
    assert r2.status_code == 400, r2.text


def test_create_device_requires_superuser(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    r = client.post(
        f"{API}/devices/",
        headers=normal_user_token_headers,
        json={"addr": "192.0.2.52"},
    )
    assert r.status_code == 403


def test_read_device(client: TestClient) -> None:
    headers = _su(client)
    created = client.post(
        f"{API}/devices/", headers=headers, json={"addr": "192.0.2.53"}
    ).json()
    r = client.get(f"{API}/devices/{created['id']}", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["id"] == created["id"]


def test_read_device_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.get(f"{API}/devices/{uuid.uuid4()}", headers=headers)
    assert r.status_code == 404


def test_list_devices(client: TestClient) -> None:
    headers = _su(client)
    client.post(f"{API}/devices/", headers=headers, json={"addr": "192.0.2.54"})
    r = client.get(f"{API}/devices/", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "data" in body and "count" in body
    assert body["count"] >= 1


def test_list_devices_filters_by_node_id(client: TestClient) -> None:
    headers = _su(client)
    tenant_id = random_lower_string()
    root_type = _root_type(client, headers, tenant_id)
    node_a = _root_node(client, headers, root_type["id"])
    node_b = client.post(
        f"{API}/nodes/",
        headers=headers,
        json={"name": "Other Region", "node_type_id": root_type["id"]},
    ).json()

    dev_a = client.post(
        f"{API}/devices/",
        headers=headers,
        json={"addr": "192.0.2.55", "node_id": node_a["id"]},
    ).json()
    dev_b = client.post(
        f"{API}/devices/",
        headers=headers,
        json={"addr": "192.0.2.56", "node_id": node_b["id"]},
    ).json()

    r = client.get(f"{API}/devices/?node_id={node_a['id']}", headers=headers)
    assert r.status_code == 200, r.text
    ids = [d["id"] for d in r.json()["data"]]
    assert dev_a["id"] in ids
    assert dev_b["id"] not in ids


def test_update_device(client: TestClient) -> None:
    headers = _su(client)
    created = client.post(
        f"{API}/devices/", headers=headers, json={"addr": "192.0.2.57"}
    ).json()
    new_addr = "192.0.2.58"
    r = client.patch(
        f"{API}/devices/{created['id']}", headers=headers, json={"addr": new_addr}
    )
    assert r.status_code == 200, r.text
    assert r.json()["addr"] == new_addr


def test_update_device_requires_superuser(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    headers = _su(client)
    created = client.post(
        f"{API}/devices/", headers=headers, json={"addr": "192.0.2.59"}
    ).json()
    r = client.patch(
        f"{API}/devices/{created['id']}",
        headers=normal_user_token_headers,
        json={"addr": "192.0.2.60"},
    )
    assert r.status_code == 403


def test_delete_device(client: TestClient) -> None:
    headers = _su(client)
    created = client.post(
        f"{API}/devices/", headers=headers, json={"addr": "192.0.2.61"}
    ).json()
    r = client.delete(f"{API}/devices/{created['id']}", headers=headers)
    assert r.status_code == 200, r.text
    assert (
        client.get(f"{API}/devices/{created['id']}", headers=headers).status_code == 404
    )


def test_delete_device_requires_superuser(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    headers = _su(client)
    created = client.post(
        f"{API}/devices/", headers=headers, json={"addr": "192.0.2.62"}
    ).json()
    r = client.delete(
        f"{API}/devices/{created['id']}", headers=normal_user_token_headers
    )
    assert r.status_code == 403


def test_reassigning_orphaned_device_addr_succeeds(client: TestClient) -> None:
    """POST /devices/ with an addr that already exists but is orphaned
    (node_id is NULL, e.g. because its Node was deleted) must reassign the
    existing row to the new node_id instead of rejecting with a 400 --
    otherwise a device can never be re-added anywhere once its node is
    removed."""
    headers = _su(client)
    tenant_id = random_lower_string()
    root_type = _root_type(client, headers, tenant_id)
    node_a = _root_node(client, headers, root_type["id"])
    node_b = client.post(
        f"{API}/nodes/",
        headers=headers,
        json={"name": "Other Region", "node_type_id": root_type["id"]},
    ).json()

    addr = "192.0.2.64"
    device = client.post(
        f"{API}/devices/", headers=headers, json={"addr": addr, "node_id": node_a["id"]}
    ).json()

    r = client.delete(f"{API}/nodes/{node_a['id']}", headers=headers)
    assert r.status_code == 200, r.text

    r = client.post(
        f"{API}/devices/", headers=headers, json={"addr": addr, "node_id": node_b["id"]}
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["id"] == device["id"]
    assert data["node_id"] == node_b["id"]


def test_reassigning_actively_assigned_device_addr_still_returns_400(
    client: TestClient,
) -> None:
    """The orphaned-reassignment path must not weaken the existing conflict
    check: an addr that's still actively assigned to a node stays a 400."""
    headers = _su(client)
    tenant_id = random_lower_string()
    root_type = _root_type(client, headers, tenant_id)
    node_a = _root_node(client, headers, root_type["id"])
    node_b = client.post(
        f"{API}/nodes/",
        headers=headers,
        json={"name": "Other Region", "node_type_id": root_type["id"]},
    ).json()

    addr = "192.0.2.65"
    client.post(f"{API}/devices/", headers=headers, json={"addr": addr, "node_id": node_a["id"]})

    r = client.post(
        f"{API}/devices/", headers=headers, json={"addr": addr, "node_id": node_b["id"]}
    )
    assert r.status_code == 400, r.text


def test_deleting_node_sets_device_node_id_to_null(client: TestClient) -> None:
    """A Device's node assignment must be orphaned (node_id -> NULL), not
    cascade-deleted, when its Node is removed -- the device record itself
    still represents a real, monitored address."""
    headers = _su(client)
    tenant_id = random_lower_string()
    root_type = _root_type(client, headers, tenant_id)
    node = _root_node(client, headers, root_type["id"])
    device = client.post(
        f"{API}/devices/",
        headers=headers,
        json={"addr": "192.0.2.63", "node_id": node["id"]},
    ).json()

    r = client.delete(f"{API}/nodes/{node['id']}", headers=headers)
    assert r.status_code == 200, r.text

    r = client.get(f"{API}/devices/{device['id']}", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["node_id"] is None
