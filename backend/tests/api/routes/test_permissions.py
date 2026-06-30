"""
Superuser-only enforcement on write routes.

CLAUDE.md documents the intended security model: "Most write operations
(POST/PUT/DELETE on devices, buildings, etc.) require is_superuser=True."

These tests exercise every create/update/delete route across the
Campus -> Building -> Room -> Device hierarchy with a normal (non-superuser)
authenticated user and assert they are rejected with 403.

Requires a live DB + Redis (run inside Docker: docker compose exec backend pytest).
"""
from fastapi.testclient import TestClient

from app.core.config import settings
from tests.utils.hierarchy import seed_hierarchy

API = settings.API_V1_STR


# ── Campus ───────────────────────────────────────────────────────────────────

def test_normal_user_cannot_create_campus(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    r = client.post(
        f"{API}/campuses/",
        headers=normal_user_token_headers,
        json={"name": "rogue-campus"},
    )
    assert r.status_code == 403, r.text


def test_normal_user_cannot_update_campus(
    client: TestClient, normal_user_token_headers: dict[str, str], db
) -> None:
    campus, _, _ = seed_hierarchy(db)
    r = client.put(
        f"{API}/campuses/{campus.id}",
        headers=normal_user_token_headers,
        json={"name": "renamed"},
    )
    assert r.status_code == 403, r.text


def test_normal_user_cannot_delete_campus(
    client: TestClient, normal_user_token_headers: dict[str, str], db
) -> None:
    campus, _, _ = seed_hierarchy(db)
    r = client.delete(f"{API}/campuses/{campus.id}", headers=normal_user_token_headers)
    assert r.status_code == 403, r.text


# ── Building ─────────────────────────────────────────────────────────────────

def test_normal_user_cannot_create_building(
    client: TestClient, normal_user_token_headers: dict[str, str], db
) -> None:
    campus, _, _ = seed_hierarchy(db)
    r = client.post(
        f"{API}/buildings/",
        headers=normal_user_token_headers,
        json={"name": "rogue-building", "campus_id": str(campus.id)},
    )
    assert r.status_code == 403, r.text


def test_normal_user_cannot_update_building(
    client: TestClient, normal_user_token_headers: dict[str, str], db
) -> None:
    _, building, _ = seed_hierarchy(db)
    r = client.put(
        f"{API}/buildings/{building.id}",
        headers=normal_user_token_headers,
        json={"name": "renamed"},
    )
    assert r.status_code == 403, r.text


def test_normal_user_cannot_delete_building(
    client: TestClient, normal_user_token_headers: dict[str, str], db
) -> None:
    _, building, _ = seed_hierarchy(db)
    r = client.delete(f"{API}/buildings/{building.id}", headers=normal_user_token_headers)
    assert r.status_code == 403, r.text


# ── Room ─────────────────────────────────────────────────────────────────────

def test_normal_user_cannot_create_room(
    client: TestClient, normal_user_token_headers: dict[str, str], db
) -> None:
    _, building, _ = seed_hierarchy(db)
    r = client.post(
        f"{API}/rooms/",
        headers=normal_user_token_headers,
        json={"name": "rogue-room", "building_id": str(building.id)},
    )
    assert r.status_code == 403, r.text


def test_normal_user_cannot_update_room(
    client: TestClient, normal_user_token_headers: dict[str, str], db
) -> None:
    _, _, room = seed_hierarchy(db)
    r = client.put(
        f"{API}/rooms/{room.id}",
        headers=normal_user_token_headers,
        json={"name": "renamed"},
    )
    assert r.status_code == 403, r.text


def test_normal_user_cannot_delete_room(
    client: TestClient, normal_user_token_headers: dict[str, str], db
) -> None:
    _, _, room = seed_hierarchy(db)
    r = client.delete(f"{API}/rooms/{room.id}", headers=normal_user_token_headers)
    assert r.status_code == 403, r.text


# ── Device (already enforced — guard against regression) ────────────────────

def test_normal_user_cannot_create_device(
    client: TestClient, normal_user_token_headers: dict[str, str], db
) -> None:
    _, _, room = seed_hierarchy(db)
    r = client.post(
        f"{API}/devices/",
        headers=normal_user_token_headers,
        json={"name": "rogue-dev", "device_type": "switch",
              "ip_address": "192.0.2.50", "room_id": str(room.id)},
    )
    assert r.status_code == 403, r.text


def test_normal_user_cannot_update_device(
    client: TestClient, superuser_token_headers: dict[str, str],
    normal_user_token_headers: dict[str, str], db
) -> None:
    _, _, room = seed_hierarchy(db)
    r = client.post(
        f"{API}/devices/",
        headers=superuser_token_headers,
        json={"name": "perm-dev", "device_type": "switch",
              "ip_address": "192.0.2.51", "room_id": str(room.id)},
    )
    assert r.status_code == 200, r.text
    device_id = r.json()["id"]

    r = client.put(
        f"{API}/devices/{device_id}",
        headers=normal_user_token_headers,
        json={"name": "renamed", "device_type": "switch",
              "ip_address": "192.0.2.51", "room_id": str(room.id)},
    )
    assert r.status_code == 403, r.text


def test_normal_user_cannot_delete_device(
    client: TestClient, superuser_token_headers: dict[str, str],
    normal_user_token_headers: dict[str, str], db
) -> None:
    _, _, room = seed_hierarchy(db)
    r = client.post(
        f"{API}/devices/",
        headers=superuser_token_headers,
        json={"name": "perm-dev-2", "device_type": "switch",
              "ip_address": "192.0.2.52", "room_id": str(room.id)},
    )
    assert r.status_code == 200, r.text
    device_id = r.json()["id"]

    r = client.delete(f"{API}/devices/{device_id}", headers=normal_user_token_headers)
    assert r.status_code == 403, r.text


# ── Unauthenticated requests are rejected, not silently allowed ─────────────

def test_unauthenticated_cannot_create_campus(client: TestClient) -> None:
    r = client.post(f"{API}/campuses/", json={"name": "anon-campus"})
    assert r.status_code == 401, r.text
