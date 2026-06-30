"""
CRUD lifecycle tests for /campuses.

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


def test_create_campus(client: TestClient) -> None:
    headers = _su(client)
    name = f"campus-{random_lower_string()[:8]}"
    r = client.post(f"{API}/campuses/", headers=headers, json={"name": name})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["name"] == name
    assert "id" in data


def test_read_campus(client: TestClient, db) -> None:
    campus, _, _ = seed_hierarchy(db)
    headers = _su(client)
    r = client.get(f"{API}/campuses/{campus.id}", headers=headers)
    assert r.status_code == 200, r.text
    assert r.json()["id"] == str(campus.id)


def test_read_campus_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.get(f"{API}/campuses/{uuid.uuid4()}", headers=headers)
    assert r.status_code == 404


def test_list_campuses(client: TestClient, db) -> None:
    seed_hierarchy(db)
    headers = _su(client)
    r = client.get(f"{API}/campuses/", headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "data" in body
    assert "count" in body
    assert body["count"] >= 1


def test_update_campus(client: TestClient, db) -> None:
    campus, _, _ = seed_hierarchy(db)
    headers = _su(client)
    new_name = f"renamed-{random_lower_string()[:8]}"
    r = client.put(f"{API}/campuses/{campus.id}", headers=headers, json={"name": new_name})
    assert r.status_code == 200, r.text
    assert r.json()["name"] == new_name


def test_update_campus_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.put(
        f"{API}/campuses/{uuid.uuid4()}", headers=headers, json={"name": "x"}
    )
    assert r.status_code == 404


def test_delete_campus(client: TestClient, db) -> None:
    campus, _, _ = seed_hierarchy(db)
    headers = _su(client)
    r = client.delete(f"{API}/campuses/{campus.id}", headers=headers)
    assert r.status_code == 200, r.text

    r = client.get(f"{API}/campuses/{campus.id}", headers=headers)
    assert r.status_code == 404


def test_delete_campus_not_found(client: TestClient) -> None:
    headers = _su(client)
    r = client.delete(f"{API}/campuses/{uuid.uuid4()}", headers=headers)
    assert r.status_code == 404
