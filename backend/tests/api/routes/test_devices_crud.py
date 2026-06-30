"""
CRUD lifecycle + bulk-upload tests for /devices (non-Redis-key assertions —
see test_devices.py for the Redis members:room:<id> consistency checks).

Requires a live DB + Redis (run inside Docker: docker compose exec backend pytest).
"""
import io
import uuid

from fastapi.testclient import TestClient

from app.core.config import settings
from tests.utils.hierarchy import seed_hierarchy
from tests.utils.utils import get_superuser_token_headers, random_lower_string

API = settings.API_V1_STR


def _su(client: TestClient) -> dict[str, str]:
    return get_superuser_token_headers(client)


def test_create_device(client: TestClient, db) -> None:
    _, _, room = seed_hierarchy(db)
    headers = _su(client)
    name = f"dev-{random_lower_string()[:8]}"
    r = client.post(
        f"{API}/devices/", headers=headers,
        json={"name": name, "device_type": "switch",
              "ip_address": "198.51.100.10", "room_id": str(room.id)},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["name"] == name
    assert data["room_id"] == str(room.id)


def test_create_device_without_room(client: TestClient) -> None:
    """Device.room_id is nullable — devices can be unassigned."""
    headers = _su(client)
    r = client.post(
        f"{API}/devices/", headers=headers,
        json={"name": "unassigned-dev", "device_type": "switch",
              "ip_address": "198.51.100.11"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["room_id"] is None


def test_read_device_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.get(f"{API}/devices/{uuid.uuid4()}", headers=headers)
    assert r.status_code == 404


def test_list_devices(client: TestClient, db) -> None:
    _, _, room = seed_hierarchy(db)
    headers = _su(client)
    client.post(
        f"{API}/devices/", headers=headers,
        json={"name": "list-dev", "device_type": "switch",
              "ip_address": "198.51.100.12", "room_id": str(room.id)},
    )
    r = client.get(f"{API}/devices/", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "data" in body and "count" in body
    assert body["count"] >= 1


def test_update_device_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.put(
        f"{API}/devices/{uuid.uuid4()}", headers=headers,
        json={"name": "x", "device_type": "switch", "ip_address": "198.51.100.13"},
    )
    assert r.status_code == 404


def test_delete_device_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.delete(f"{API}/devices/{uuid.uuid4()}", headers=headers)
    assert r.status_code == 404


# ── Bulk CSV upload ───────────────────────────────────────────────────────────

def test_bulk_upload_dry_run_does_not_touch_db(client: TestClient, db) -> None:
    _, _, room = seed_hierarchy(db)
    headers = _su(client)
    csv_content = (
        "name,device_type,ip_address,room_id\n"
        f"csv-dev-1,switch,198.51.100.20,{room.id}\n"
        f"csv-dev-2,router,198.51.100.21,{room.id}\n"
    )
    files = {"file": ("devices.csv", io.BytesIO(csv_content.encode()), "text/csv")}
    r = client.post(
        f"{API}/devices/upload?dry_run=true", headers=headers, files=files
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 2

    # Confirm nothing was persisted: neither name should show up in the listing.
    listing = client.get(f"{API}/devices/", headers=headers).json()
    names = [d["name"] for d in listing["data"]]
    assert "csv-dev-1" not in names
    assert "csv-dev-2" not in names


def test_bulk_upload_replaces_devices_table(client: TestClient, db) -> None:
    _, _, room = seed_hierarchy(db)
    headers = _su(client)
    csv_content = (
        "name,device_type,ip_address,room_id\n"
        f"csv-real-1,switch,198.51.100.30,{room.id}\n"
    )
    files = {"file": ("devices.csv", io.BytesIO(csv_content.encode()), "text/csv")}
    r = client.post(f"{API}/devices/upload", headers=headers, files=files)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["count"] == 1
    assert body["data"][0]["name"] == "csv-real-1"

    listing = client.get(f"{API}/devices/", headers=headers).json()
    names = [d["name"] for d in listing["data"]]
    assert names == ["csv-real-1"]


def test_bulk_upload_rejects_non_csv_extension(client: TestClient) -> None:
    headers = _su(client)
    files = {"file": ("devices.txt", io.BytesIO(b"name,device_type,ip_address\n"), "text/plain")}
    r = client.post(f"{API}/devices/upload?dry_run=true", headers=headers, files=files)
    assert r.status_code == 400


def test_bulk_upload_rejects_empty_csv(client: TestClient) -> None:
    headers = _su(client)
    files = {"file": ("devices.csv", io.BytesIO(b"name,device_type,ip_address\n"), "text/csv")}
    r = client.post(f"{API}/devices/upload?dry_run=true", headers=headers, files=files)
    assert r.status_code == 400


def test_bulk_upload_requires_superuser(
    client: TestClient, normal_user_token_headers: dict[str, str]
) -> None:
    files = {"file": ("devices.csv", io.BytesIO(b"name,device_type,ip_address\n"), "text/csv")}
    r = client.post(
        f"{API}/devices/upload?dry_run=true",
        headers=normal_user_token_headers,
        files=files,
    )
    assert r.status_code == 403
