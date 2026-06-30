"""
CRUD lifecycle tests for /rooms, plus /rooms/{id}/states (Redis-backed).

Requires a live DB + Redis (run inside Docker: docker compose exec backend pytest).
"""
import uuid

from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.redis import RedisManager
from tests.utils.hierarchy import seed_hierarchy
from tests.utils.utils import get_superuser_token_headers, random_lower_string

API = settings.API_V1_STR


def _su(client: TestClient) -> dict[str, str]:
    return get_superuser_token_headers(client)


def test_create_room(client: TestClient, db) -> None:
    _, building, _ = seed_hierarchy(db)
    headers = _su(client)
    name = f"room-{random_lower_string()[:8]}"
    r = client.post(
        f"{API}/rooms/", headers=headers,
        json={"name": name, "building_id": str(building.id)},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["name"] == name
    assert data["building_id"] == str(building.id)


def test_read_room(client: TestClient, db) -> None:
    _, _, room = seed_hierarchy(db)
    headers = _su(client)
    r = client.get(f"{API}/rooms/{room.id}", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["id"] == str(room.id)


def test_read_room_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.get(f"{API}/rooms/{uuid.uuid4()}", headers=headers)
    assert r.status_code == 404


def test_list_rooms(client: TestClient, db) -> None:
    seed_hierarchy(db)
    headers = _su(client)
    r = client.get(f"{API}/rooms/", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "data" in body and "count" in body
    assert body["count"] >= 1


def test_update_room(client: TestClient, db) -> None:
    _, _, room = seed_hierarchy(db)
    headers = _su(client)
    new_name = f"renamed-{random_lower_string()[:8]}"
    r = client.put(f"{API}/rooms/{room.id}", headers=headers, json={"name": new_name})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == new_name


def test_update_room_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.put(f"{API}/rooms/{uuid.uuid4()}", headers=headers, json={"name": "x"})
    assert r.status_code == 404


def test_delete_room(client: TestClient, db) -> None:
    _, _, room = seed_hierarchy(db)
    headers = _su(client)
    r = client.delete(f"{API}/rooms/{room.id}", headers=headers)
    assert r.status_code == 200, r.text

    r = client.get(f"{API}/rooms/{room.id}", headers=headers)
    assert r.status_code == 404


def test_delete_room_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.delete(f"{API}/rooms/{uuid.uuid4()}", headers=headers)
    assert r.status_code == 404


# ── /rooms/{id}/states ───────────────────────────────────────────────────────

def test_room_states_not_found_room(client: TestClient) -> None:
    r = client.get(f"{API}/rooms/{uuid.uuid4()}/states")
    assert r.status_code == 404


def test_room_states_empty_when_no_members(client: TestClient, db) -> None:
    _, _, room = seed_hierarchy(db)
    r = client.get(f"{API}/rooms/{room.id}/states")
    assert r.status_code == 200, r.text
    assert r.json() == []


def test_room_states_returns_seeded_device_state(client: TestClient, db) -> None:
    import json

    _, _, room = seed_hierarchy(db)
    headers = _su(client)
    ip = "192.0.2.77"

    r = client.post(
        f"{API}/devices/",
        headers=headers,
        json={"name": "states-dev", "device_type": "switch",
              "ip_address": ip, "room_id": str(room.id)},
    )
    assert r.status_code == 200, r.text

    rc = RedisManager.get_sync_client()
    try:
        rc.hset("pings:state", ip, json.dumps({"addr": ip, "ok": True, "ts": 0}))
        r = client.get(f"{API}/rooms/{room.id}/states")
        assert r.status_code == 200, r.text
        addrs = [item.get("addr") for item in r.json()]
        assert ip in addrs
    finally:
        rc.hdel("pings:state", ip)
