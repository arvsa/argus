"""
Tests covering the Campus → Building → Room → Device hierarchy:

  - API responses include parent FK fields (Bug #7: missing campus_id/building_id/room_id)
  - DELETE cascades correctly through the chain (Bug #6: IntegrityError on campus delete)
  - Buildings created via API are queryable by campus_id (Bug #1 + #7 combined)

Requires a live DB (run inside Docker: docker compose exec backend pytest).
"""
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.core.config import settings
from tests.utils.hierarchy import seed_device, seed_hierarchy
from tests.utils.utils import get_superuser_token_headers, random_lower_string

API = settings.API_V1_STR


def _su(client: TestClient) -> dict[str, str]:
    return get_superuser_token_headers(client)


# ── Parent IDs in API responses (Bug #7) ─────────────────────────────────────

def test_building_response_includes_campus_id(client: TestClient, db: Session) -> None:
    """GET /buildings/{id} must return campus_id."""
    campus, building, _ = seed_hierarchy(db)
    headers = _su(client)

    r = client.get(f"{API}/buildings/{building.id}", headers=headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "campus_id" in data
    assert data["campus_id"] == str(campus.id)


def test_room_response_includes_building_id(client: TestClient, db: Session) -> None:
    """GET /rooms/{id} must return building_id."""
    _, building, room = seed_hierarchy(db)
    headers = _su(client)

    r = client.get(f"{API}/rooms/{room.id}", headers=headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "building_id" in data
    assert data["building_id"] == str(building.id)


def test_device_response_includes_room_id(client: TestClient, db: Session) -> None:
    """GET /devices/{id} must return room_id."""
    _, _, room = seed_hierarchy(db)
    device = seed_device(db, room_id=room.id)
    headers = _su(client)

    # Register the device via API so it gets a proper response
    r = client.post(
        f"{API}/devices/",
        headers=headers,
        json={
            "name": device.name,
            "device_type": device.device_type,
            "ip_address": device.ip_address,
            "room_id": str(room.id),
        },
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert "room_id" in data
    assert data["room_id"] == str(room.id)


def test_building_list_includes_campus_id(client: TestClient, db: Session) -> None:
    """GET /buildings/ must include campus_id on every item."""
    campus, building, _ = seed_hierarchy(db)
    headers = _su(client)

    r = client.get(f"{API}/buildings/", headers=headers)
    assert r.status_code == 200, r.text
    items = r.json()["data"]
    match = next((b for b in items if b["id"] == str(building.id)), None)
    assert match is not None, "Seeded building not found in list response"
    assert "campus_id" in match
    assert match["campus_id"] == str(campus.id)


# ── Building creation associates correct campus (Bugs #1 + #7) ───────────────

def test_post_building_sets_campus_id(client: TestClient, db: Session) -> None:
    """POST /buildings/ with campus_id=X → GET response has campus_id=X."""
    campus, _, _ = seed_hierarchy(db)
    campus2, _, _ = seed_hierarchy(db)
    headers = _su(client)

    name = f"bldg-{random_lower_string()[:8]}"
    r = client.post(
        f"{API}/buildings/",
        headers=headers,
        json={"name": name, "campus_id": str(campus.id)},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["campus_id"] == str(campus.id)
    assert data["campus_id"] != str(campus2.id)


def test_post_room_sets_building_id(client: TestClient, db: Session) -> None:
    """POST /rooms/ with building_id=X → GET response has building_id=X."""
    _, building, _ = seed_hierarchy(db)
    headers = _su(client)

    name = f"room-{random_lower_string()[:8]}"
    r = client.post(
        f"{API}/rooms/",
        headers=headers,
        json={"name": name, "building_id": str(building.id)},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["building_id"] == str(building.id)


# ── Cascade delete (Bug #6) ───────────────────────────────────────────────────

def test_delete_campus_cascades_to_buildings_rooms_devices(
    client: TestClient, db: Session
) -> None:
    """DELETE /campuses/{id} must remove all descendant buildings, rooms, and devices."""
    campus, building, room = seed_hierarchy(db)
    headers = _su(client)

    # Create a device via API so it's in the DB and Redis
    ip = f"10.99.{id(campus) % 256}.1"
    r = client.post(
        f"{API}/devices/",
        headers=headers,
        json={"name": "cascade-test-dev", "device_type": "switch",
              "ip_address": ip, "room_id": str(room.id)},
    )
    assert r.status_code == 200, r.text
    device_id = r.json()["id"]

    # Delete the campus — must not raise IntegrityError
    r = client.delete(f"{API}/campuses/{campus.id}", headers=headers)
    assert r.status_code == 200, r.text

    # All descendants must be gone
    assert client.get(f"{API}/buildings/{building.id}", headers=headers).status_code == 404
    assert client.get(f"{API}/rooms/{room.id}", headers=headers).status_code == 404
    assert client.get(f"{API}/devices/{device_id}", headers=headers).status_code == 404


def test_delete_building_cascades_to_rooms_and_devices(
    client: TestClient, db: Session
) -> None:
    """DELETE /buildings/{id} removes rooms and devices but leaves the campus."""
    campus, building, room = seed_hierarchy(db)
    headers = _su(client)

    ip = f"10.98.{id(building) % 256}.1"
    r = client.post(
        f"{API}/devices/",
        headers=headers,
        json={"name": "bldg-cascade-dev", "device_type": "switch",
              "ip_address": ip, "room_id": str(room.id)},
    )
    assert r.status_code == 200, r.text
    device_id = r.json()["id"]

    r = client.delete(f"{API}/buildings/{building.id}", headers=headers)
    assert r.status_code == 200, r.text

    assert client.get(f"{API}/rooms/{room.id}", headers=headers).status_code == 404
    assert client.get(f"{API}/devices/{device_id}", headers=headers).status_code == 404
    # Campus must survive
    assert client.get(f"{API}/campuses/{campus.id}", headers=headers).status_code == 200
