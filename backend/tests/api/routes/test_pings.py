"""
Tests for the ping-state and WebSocket endpoints.

Requires a live Redis (runs inside Docker via `docker compose exec backend pytest`).
/state and /state_scan require a superuser token in this backend version.
All tests seed and clean up their own Redis keys.
"""
import json

from fastapi.testclient import TestClient

from app.core.config import settings
from app.core.redis import RedisManager
from tests.utils.utils import get_superuser_token_headers

_TS = 9_999_999_999_999  # far-future score so ZREVRANGE always returns it first
_ADDR_STATE = "192.0.2.210"


def _auth(client: TestClient) -> dict[str, str]:
    return get_superuser_token_headers(client)


def test_state_returns_seeded_device(client: TestClient) -> None:
    """GET /state must return a device once written to pings:state and pings:index."""
    rc = RedisManager.get_sync_client()
    payload = json.dumps({"addr": _ADDR_STATE, "ok": True, "ts": _TS, "interval": 5000})
    try:
        rc.hset("pings:state", _ADDR_STATE, payload)
        rc.zadd("pings:index", {_ADDR_STATE: _TS})

        r = client.get(
            f"{settings.API_V1_STR}/state?size=1000",
            headers=_auth(client),
        )
        assert r.status_code == 200, r.text
        addrs = [item["addr"] for item in r.json()["items"]]
        assert _ADDR_STATE in addrs, (
            f"{_ADDR_STATE} not found in /state response: {addrs[:5]}"
        )
    finally:
        rc.hdel("pings:state", _ADDR_STATE)
        rc.zrem("pings:index", _ADDR_STATE)


def test_state_scan_returns_seeded_device(client: TestClient) -> None:
    """GET /state_scan must return a seeded device when paginated to completion."""
    rc = RedisManager.get_sync_client()
    payload = json.dumps({"addr": _ADDR_STATE, "ok": True, "ts": _TS, "interval": 5000})
    try:
        rc.hset("pings:state", _ADDR_STATE, payload)

        headers = _auth(client)
        found = False
        cursor = 0
        # Paginate until cursor wraps back to 0 or we find our address.
        for _ in range(200):  # hard cap — avoids infinite loop on huge data sets
            r = client.get(
                f"{settings.API_V1_STR}/state_scan?cursor={cursor}&count=200",
                headers=headers,
            )
            assert r.status_code == 200, r.text
            data = r.json()
            if any(item.get("addr") == _ADDR_STATE for item in data["items"]):
                found = True
                break
            cursor = data["cursor"]
            if cursor == 0:
                break

        assert found, f"{_ADDR_STATE} not found in /state_scan after full cursor traversal"
    finally:
        rc.hdel("pings:state", _ADDR_STATE)


def test_state_requires_auth(client: TestClient) -> None:
    """GET /state without a token must return 401."""
    r = client.get(f"{settings.API_V1_STR}/state")
    assert r.status_code == 401, f"Expected 401, got {r.status_code}"


def test_state_scan_requires_auth(client: TestClient) -> None:
    """GET /state_scan without a token must return 401."""
    r = client.get(f"{settings.API_V1_STR}/state_scan")
    assert r.status_code == 401, f"Expected 401, got {r.status_code}"


def test_websocket_accepts_connection(client: TestClient) -> None:
    """WebSocket endpoint must complete the handshake without error."""
    with client.websocket_connect(f"{settings.API_V1_STR}/ws/pings") as ws:
        # The server waits for client messages; send a keepalive and verify no crash.
        ws.send_text("ping")
    # If we reach here the connection opened and closed cleanly.


def test_no_token_returns_401_or_403(client: TestClient) -> None:
    """Requests to protected endpoints without a token must be rejected."""
    r = client.get(f"{settings.API_V1_STR}/users/")
    assert r.status_code in (401, 403), (
        f"Expected 401 or 403, got {r.status_code}"
    )


def test_forged_token_returns_403(client: TestClient) -> None:
    """A syntactically valid but unsigned JWT must be rejected."""
    r = client.get(
        f"{settings.API_V1_STR}/users/",
        headers={"Authorization": "Bearer not.a.real.token"},
    )
    assert r.status_code == 403, f"Expected 403, got {r.status_code}"
