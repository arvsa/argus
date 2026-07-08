"""
Tests for GET /api/v1/node-stats — per-node aggregate up/down counts.

pingsvc's Lua script (publishIfChangedAndAggregateScript) maintains one
Redis hash per ancestor node, stats:node:<id>, with "up"/"down" integer
fields (HINCRBY) -- see pingsvc/cmd/pingsvc/main.go. Nothing in the REST
API exposed this before (plan/frontend-v2.md Phase 3d's NodeStatusBadge
needs it to render "12 up / 2 down" against a Node).

Requires a live Redis (run inside Docker: docker compose exec backend pytest).
"""
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.redis import RedisManager
from tests.utils.utils import get_superuser_token_headers

API = settings.API_V1_STR


def _auth(client: TestClient) -> dict[str, str]:
    return get_superuser_token_headers(client)


@pytest.fixture(autouse=True)
def _clean_test_hashes():
    rc = RedisManager.get_sync_client()
    keys = rc.keys("stats:node:__test_node_stats__*")
    if keys:
        rc.delete(*keys)
    yield
    keys = rc.keys("stats:node:__test_node_stats__*")
    if keys:
        rc.delete(*keys)


def test_node_stats_requires_auth(client: TestClient) -> None:
    r = client.get(f"{API}/node-stats?ids=some-id")
    assert r.status_code == 401


def test_node_stats_returns_up_down_for_requested_ids(client: TestClient) -> None:
    rc = RedisManager.get_sync_client()
    node_id = "__test_node_stats__node-1"
    rc.hset(f"stats:node:{node_id}", mapping={"up": 12, "down": 2})

    r = client.get(f"{API}/node-stats?ids={node_id}", headers=_auth(client))
    assert r.status_code == 200, r.text
    data = r.json()
    assert data == {node_id: {"up": 12, "down": 2}}


def test_node_stats_returns_zeros_for_unknown_id(client: TestClient) -> None:
    """A node with no ping traffic yet has no stats:node:<id> hash at all --
    must still appear in the response as zeros, not be omitted, so the
    frontend never has to special-case a missing key."""
    node_id = "__test_node_stats__never-pinged"

    r = client.get(f"{API}/node-stats?ids={node_id}", headers=_auth(client))
    assert r.status_code == 200, r.text
    assert r.json() == {node_id: {"up": 0, "down": 0}}


def test_node_stats_handles_multiple_ids(client: TestClient) -> None:
    rc = RedisManager.get_sync_client()
    id_a = "__test_node_stats__node-a"
    id_b = "__test_node_stats__node-b"
    rc.hset(f"stats:node:{id_a}", mapping={"up": 5, "down": 0})

    r = client.get(f"{API}/node-stats?ids={id_a},{id_b}", headers=_auth(client))
    assert r.status_code == 200, r.text
    assert r.json() == {
        id_a: {"up": 5, "down": 0},
        id_b: {"up": 0, "down": 0},
    }


def test_node_stats_with_no_ids_returns_empty(client: TestClient) -> None:
    r = client.get(f"{API}/node-stats", headers=_auth(client))
    assert r.status_code == 200, r.text
    assert r.json() == {}
