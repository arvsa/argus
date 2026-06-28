"""
Redis key-integrity tests for device create / update / delete.

Requires a live Redis and DB (runs inside Docker via `docker compose exec backend pytest`).
Each test verifies that members:room:<room_id> stays consistent with the DB.

Note: the container's data model has Campus → Building → Floor → Room. There is no
/floors API route yet, so floors are created directly via the DB session fixture.
"""
import uuid

from fastapi.testclient import TestClient
from sqlmodel import Session

from app.core.config import settings
from app.core.redis import RedisManager
from app.models import Building, Campus, Floor, Room
from tests.utils.utils import get_superuser_token_headers, random_lower_string


# ── helpers ──────────────────────────────────────────────────────────────────

def _superuser_headers(client: TestClient) -> dict[str, str]:
    return get_superuser_token_headers(client)


def _seed_room(client: TestClient, headers: dict[str, str], db: Session) -> uuid.UUID:
    """
    Create Campus → Building → Floor → Room entirely via DB.
    The container's RoomCreate model omits floor_id while Room requires it,
    making room creation through the API impossible until that schema is fixed.
    """
    suffix = random_lower_string()[:8]

    # Roll back any failed transaction from a prior test before writing new data.
    try:
        db.rollback()
    except Exception:
        pass

    campus = Campus(name=f"campus-{suffix}")
    db.add(campus)
    db.commit()
    db.refresh(campus)

    building = Building(name=f"bldg-{suffix}", campus_id=campus.id)
    db.add(building)
    db.commit()
    db.refresh(building)

    # Floor.name is varchar(10) NOT NULL in the DB despite the model marking it optional.
    floor = Floor(name="testfloor", building_id=building.id)
    db.add(floor)
    db.commit()
    db.refresh(floor)

    room = Room(name=f"room-{suffix}", building_id=building.id, floor_id=floor.id)
    db.add(room)
    db.commit()
    db.refresh(room)

    return room.id


# ── tests ─────────────────────────────────────────────────────────────────────

def test_create_device_adds_to_members_room(client: TestClient, db: Session) -> None:
    """POST /devices/ must SADD the new IP into members:room:<room_id>."""
    headers = _superuser_headers(client)
    room_id = _seed_room(client, headers, db)
    ip = "192.0.2.1"

    r = client.post(
        f"{settings.API_V1_STR}/devices/",
        headers=headers,
        json={"name": "sw-create-test", "device_type": "switch",
              "ip_address": ip, "room_id": str(room_id)},
    )
    assert r.status_code == 200, r.text

    rc = RedisManager.get_sync_client()
    members = rc.smembers(f"members:room:{room_id}")
    assert ip in members, (
        f"Expected {ip} in members:room:{room_id}, got: {members}"
    )


def test_update_device_moves_members_room(client: TestClient, db: Session) -> None:
    """PUT /devices/{id} must SREM old room set and SADD new room set."""
    headers = _superuser_headers(client)
    room_a = _seed_room(client, headers, db)
    room_b = _seed_room(client, headers, db)
    ip = "192.0.2.2"

    # Create device in room_a
    r = client.post(
        f"{settings.API_V1_STR}/devices/",
        headers=headers,
        json={"name": "sw-update-test", "device_type": "switch",
              "ip_address": ip, "room_id": str(room_a)},
    )
    assert r.status_code == 200, r.text
    device_id = r.json()["id"]

    # Move to room_b
    r = client.put(
        f"{settings.API_V1_STR}/devices/{device_id}",
        headers=headers,
        json={"name": "sw-update-test", "device_type": "switch",
              "ip_address": ip, "room_id": str(room_b)},
    )
    assert r.status_code == 200, r.text

    rc = RedisManager.get_sync_client()
    members_a = rc.smembers(f"members:room:{room_a}")
    members_b = rc.smembers(f"members:room:{room_b}")

    assert ip not in members_a, (
        f"Expected {ip} removed from members:room:{room_a}, still contains: {members_a}"
    )
    assert ip in members_b, (
        f"Expected {ip} in members:room:{room_b}, got: {members_b}"
    )


def test_delete_device_removes_from_members_room(client: TestClient, db: Session) -> None:
    """DELETE /devices/{id} must SREM the IP from its room set."""
    headers = _superuser_headers(client)
    room_id = _seed_room(client, headers, db)
    ip = "192.0.2.3"

    r = client.post(
        f"{settings.API_V1_STR}/devices/",
        headers=headers,
        json={"name": "sw-delete-test", "device_type": "switch",
              "ip_address": ip, "room_id": str(room_id)},
    )
    assert r.status_code == 200, r.text
    device_id = r.json()["id"]

    r = client.delete(
        f"{settings.API_V1_STR}/devices/{device_id}",
        headers=headers,
    )
    assert r.status_code == 200, r.text

    rc = RedisManager.get_sync_client()
    members = rc.smembers(f"members:room:{room_id}")
    assert ip not in members, (
        f"Expected {ip} removed from members:room:{room_id}, still contains: {members}"
    )
