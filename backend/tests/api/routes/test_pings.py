"""
Tests for the ping-state and WebSocket endpoints.

Requires a live Redis (runs inside Docker via `docker compose exec backend pytest`).
/state and /state_scan require a superuser token in this backend version.
All tests seed and clean up their own Redis keys.
"""

import asyncio
import concurrent.futures
import json

import pytest
from fastapi import WebSocketDisconnect
from fastapi.testclient import TestClient

from app.api.routes.pings import ws_pings
from app.core.broadcast import broadcaster
from app.core.config import settings
from app.core.redis import RedisManager
from tests.utils.utils import get_superuser_token_headers


class _FakeWebSocket:
    """Minimal stand-in for a FastAPI WebSocket, used to drive ws_pings
    directly (bypassing a real socket) so we can force a specific exception
    out of receive_text()."""

    def __init__(self, receive_exc: Exception):
        self._receive_exc = receive_exc

    async def accept(self) -> None:
        pass

    async def receive_text(self) -> str:
        raise self._receive_exc


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

        assert found, (
            f"{_ADDR_STATE} not found in /state_scan after full cursor traversal"
        )
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


def test_websocket_receives_enveloped_node_event(client: TestClient) -> None:
    """A message published to events:node:<id> (what pingsvc's Lua script
    actually publishes for any ping target wired into the hierarchy) must
    reach a connected /ws/pings client, wrapped as
    {"channel": "events:node:<id>", "data": <payload>} -- not silently
    dropped because the listener only subscribed to the fixed pings:events
    channel (see plan/frontend-v2.md Phase 0b).

    Starlette's WebSocketTestSession.receive() has no built-in timeout, so
    a regression here would hang forever rather than fail -- the receive
    is done on a background thread with an explicit timeout instead.
    """
    rc = RedisManager.get_sync_client()
    channel = "events:node:test-node-phase0b"
    payload = json.dumps({"addr": "192.0.2.211", "ok": True, "ts": _TS})

    with client.websocket_connect(f"{settings.API_V1_STR}/ws/pings") as ws:
        rc.publish(channel, payload)

        executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        future = executor.submit(ws.receive_json)
        try:
            received = future.result(timeout=5)
        except concurrent.futures.TimeoutError:
            pytest.fail(
                f"no message received on /ws/pings within 5s after publishing "
                f"to {channel!r} -- listener isn't forwarding per-node events"
            )
        finally:
            executor.shutdown(wait=False)

    assert received["channel"] == channel
    assert json.loads(received["data"]) == json.loads(payload)


def test_ws_pings_cleans_up_on_clean_disconnect() -> None:
    """A normal client disconnect (WebSocketDisconnect) must still be
    swallowed silently and remove the socket from broadcaster.connections,
    matching today's behavior."""
    ws = _FakeWebSocket(WebSocketDisconnect())
    asyncio.run(ws_pings(ws))  # type: ignore[arg-type]
    assert ws not in broadcaster.connections


def test_ws_pings_cleans_up_on_any_other_exception() -> None:
    """A non-WebSocketDisconnect exception on the receive loop (e.g. a
    lower-level connection error) must still remove the socket from
    broadcaster.connections instead of leaking a stale entry that would
    otherwise keep receiving -- and duplicating -- future broadcasts."""
    ws = _FakeWebSocket(RuntimeError("boom"))
    with pytest.raises(RuntimeError):
        asyncio.run(ws_pings(ws))  # type: ignore[arg-type]
    assert ws not in broadcaster.connections


def test_no_token_returns_401(client: TestClient) -> None:
    """Requests to protected endpoints without a token must be rejected."""
    r = client.get(f"{settings.API_V1_STR}/users/")
    assert r.status_code == 401, f"Expected 401, got {r.status_code}"


def test_forged_token_returns_401(client: TestClient) -> None:
    """A syntactically valid but unsigned/malformed JWT must be rejected with
    401 (not authenticated), never 403 -- 403 is reserved for a *valid* token
    that's merely missing a required privilege (see
    get_current_active_superuser). Conflating the two under one status code
    made it impossible for a client to tell "your session is dead, log in
    again" apart from "you're logged in but not allowed to do this" without
    resorting to string-matching the error detail (see
    frontend/src/api/client.ts's interceptor)."""
    r = client.get(
        f"{settings.API_V1_STR}/users/",
        headers={"Authorization": "Bearer not.a.real.token"},
    )
    assert r.status_code == 401, f"Expected 401, got {r.status_code}"
