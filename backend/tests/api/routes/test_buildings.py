"""
CRUD lifecycle tests for /buildings.

Requires a live DB (run inside Docker: docker compose exec backend pytest).
"""
import uuid

from fastapi.testclient import TestClient

from app.core.config import settings
from tests.utils.hierarchy import seed_hierarchy
from tests.utils.utils import get_superuser_token_headers, random_lower_string

API = settings.API_V1_STR


def _su(client: TestClient) -> dict[str, str]:
    return get_superuser_token_headers(client)


def test_create_building(client: TestClient, db) -> None:
    campus, _, _ = seed_hierarchy(db)
    headers = _su(client)
    name = f"bldg-{random_lower_string()[:8]}"
    r = client.post(
        f"{API}/buildings/", headers=headers,
        json={"name": name, "campus_id": str(campus.id)},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["name"] == name
    assert data["campus_id"] == str(campus.id)


def test_read_building(client: TestClient, db) -> None:
    _, building, _ = seed_hierarchy(db)
    headers = _su(client)
    r = client.get(f"{API}/buildings/{building.id}", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["id"] == str(building.id)


def test_read_building_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.get(f"{API}/buildings/{uuid.uuid4()}", headers=headers)
    assert r.status_code == 404


def test_list_buildings(client: TestClient, db) -> None:
    seed_hierarchy(db)
    headers = _su(client)
    r = client.get(f"{API}/buildings/", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "data" in body and "count" in body
    assert body["count"] >= 1


def test_update_building_partial_does_not_require_campus_id(
    client: TestClient, db
) -> None:
    """PUT /buildings/{id} must accept a partial update (just `name`)."""
    _, building, _ = seed_hierarchy(db)
    headers = _su(client)
    new_name = f"renamed-{random_lower_string()[:8]}"
    r = client.put(
        f"{API}/buildings/{building.id}", headers=headers, json={"name": new_name}
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == new_name


def test_update_building_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.put(
        f"{API}/buildings/{uuid.uuid4()}", headers=headers, json={"name": "x"}
    )
    assert r.status_code == 404


def test_delete_building(client: TestClient, db) -> None:
    _, building, _ = seed_hierarchy(db)
    headers = _su(client)
    r = client.delete(f"{API}/buildings/{building.id}", headers=headers)
    assert r.status_code == 200, r.text

    r = client.get(f"{API}/buildings/{building.id}", headers=headers)
    assert r.status_code == 404


def test_delete_building_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.delete(f"{API}/buildings/{uuid.uuid4()}", headers=headers)
    assert r.status_code == 404
