"""
Tests for GET /api/v1/stats — the Redis HSCAN aggregate endpoint (Bug #4).

Requires a live Redis (run inside Docker: docker compose exec backend pytest).
Each test seeds known pings:state entries, asserts the counts, then cleans up.
"""
import json

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.redis import RedisManager

API = settings.API_V1_STR
STATE_KEY = "pings:state"
# Use a test-only sub-key prefix so we don't collide with real pingsvc data.
_TEST_PREFIX = "__test_stats__"


@pytest.fixture(autouse=True)
def _clean_test_entries():
    """Remove any lingering test entries before and after each test."""
    rc = RedisManager.get_sync_client()
    _remove_test_entries(rc)
    yield
    _remove_test_entries(rc)


def _remove_test_entries(rc) -> None:
    cursor = 0
    while True:
        cursor, batch = rc.hscan(STATE_KEY, cursor=cursor, count=500)
        keys_to_del = [k for k in batch if k.startswith(_TEST_PREFIX)]
        if keys_to_del:
            rc.hdel(STATE_KEY, *keys_to_del)
        if cursor == 0:
            break


def _insert(rc, addr: str, ok: bool) -> None:
    key = f"{_TEST_PREFIX}{addr}"
    rc.hset(STATE_KEY, key, json.dumps({"addr": key, "ok": ok, "ts": 0}))


# ── tests ─────────────────────────────────────────────────────────────────────

def test_stats_returns_correct_shape(client: TestClient) -> None:
    """GET /stats must return {total, up, down} with integer values."""
    r = client.get(f"{API}/stats")
    assert r.status_code == 200, r.text
    data = r.json()
    assert set(data.keys()) == {"total", "up", "down"}
    assert isinstance(data["total"], int)
    assert isinstance(data["up"], int)
    assert isinstance(data["down"], int)


def test_stats_with_no_test_entries(client: TestClient) -> None:
    """With no test entries, total should not include our prefix keys (they're cleaned up)."""
    r = client.get(f"{API}/stats")
    assert r.status_code == 200, r.text
    data = r.json()
    # total >= 0 and up + down == total
    assert data["total"] >= 0
    assert data["up"] + data["down"] == data["total"]


def test_stats_counts_up_and_down_correctly(client: TestClient) -> None:
    """Insert 3 up + 2 down entries; stats must reflect those exact deltas."""
    rc = RedisManager.get_sync_client()

    # Get baseline counts
    baseline = client.get(f"{API}/stats").json()

    _insert(rc, "host-up-1", ok=True)
    _insert(rc, "host-up-2", ok=True)
    _insert(rc, "host-up-3", ok=True)
    _insert(rc, "host-down-1", ok=False)
    _insert(rc, "host-down-2", ok=False)

    r = client.get(f"{API}/stats")
    assert r.status_code == 200, r.text
    data = r.json()

    assert data["total"] == baseline["total"] + 5
    assert data["up"] == baseline["up"] + 3
    assert data["down"] == baseline["down"] + 2


def test_stats_up_down_sum_equals_total(client: TestClient) -> None:
    """up + down must always equal total regardless of Redis state."""
    rc = RedisManager.get_sync_client()
    _insert(rc, "host-sum-1", ok=True)
    _insert(rc, "host-sum-2", ok=False)

    r = client.get(f"{API}/stats")
    assert r.status_code == 200
    data = r.json()
    assert data["up"] + data["down"] == data["total"]
