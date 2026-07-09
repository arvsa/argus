import json
from typing import cast

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from app.api.deps import CurrentUser
from app.core.broadcast import broadcaster
from app.core.redis import get_sync_redis_client


def _count_stats(redis) -> dict:
    """Scan pings:state and tally up/down counts without loading all payloads."""
    total = up = down = 0
    cursor = 0
    while True:
        cursor, batch = redis.hscan("pings:state", cursor=cursor, count=500)
        for raw in batch.values():
            total += 1
            try:
                if json.loads(raw).get("ok"):
                    up += 1
                else:
                    down += 1
            except Exception:
                pass
        if cursor == 0:
            break
    return {"total": total, "up": up, "down": down}


def _node_stats(redis, ids: list[str]) -> dict[str, dict[str, int]]:
    """Fetch pingsvc's per-node aggregate up/down counters (stats:node:<id>,
    HINCRBY'd by publishIfChangedAndAggregateScript -- see
    pingsvc/cmd/pingsvc/main.go). A node with no ping traffic yet has no
    hash at all, so missing fields default to 0 rather than being omitted,
    letting the frontend treat every requested id uniformly."""
    if not ids:
        return {}
    pipe = redis.pipeline()
    for node_id in ids:
        pipe.hmget(f"stats:node:{node_id}", "up", "down")
    results = pipe.execute()
    return {
        node_id: {"up": int(up or 0), "down": int(down or 0)}
        for node_id, (up, down) in zip(ids, results, strict=True)
    }


router = APIRouter(
    prefix="", tags=["ping"]
)  # prefix kept empty so paths are /ws/pings and /api/v1/state


@router.websocket("/ws/pings")
async def ws_pings(ws: WebSocket):
    """
    WebSocket endpoint for live ping events. Clients should send some text
    periodically to avoid connection being considered idle (or rely on server pings).
    """
    await broadcaster.connect(ws)
    try:
        while True:
            # we don't expect meaningful client messages; keepalive from client is ok
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        # Always deregister, not just on a clean WebSocketDisconnect --
        # any other exception on the receive loop must still drop this
        # socket from broadcaster.connections, or a stale entry can keep
        # receiving (and duplicating) future broadcasts to a reconnecting
        # client.
        broadcaster.disconnect(ws)


@router.get("/stats")
def get_stats():
    """Aggregate up/down counts across all devices in Redis."""
    redis = get_sync_redis_client()
    return JSONResponse(_count_stats(redis))


@router.get("/node-stats")
def get_node_stats(_current_user: CurrentUser, ids: str = Query("")):
    """Aggregate up/down counts per Node (see plan/frontend-v2.md Phase 3d's
    NodeStatusBadge). ids is a comma-separated list of Node ids; unlike the
    public /stats, this reflects internal hierarchy structure, so it's
    auth-gated like /state and /state_scan."""
    redis = get_sync_redis_client()
    node_ids = [i for i in ids.split(",") if i]
    return JSONResponse(_node_stats(redis, node_ids))


@router.get("/state")
def get_state(
    _current_user: CurrentUser,
    page: int = Query(1, ge=1),
    size: int = Query(100, ge=1, le=1000),
):
    """
    Offset pagination backed by a Redis sorted set index "pings:index".
    Assumes your writer does:
      HSET pings:state <addr> <json>
      ZADD pings:index <timestamp> <addr>
    """
    redis = get_sync_redis_client()  # your sync redis client
    start = (page - 1) * size
    stop = start + size - 1

    # Get keys in descending score (most recent first). Use ZREVRANGE.
    # get_sync_redis_client() is always synchronous; redis-py's stubs type
    # these as Awaitable[T] | T to also cover the async client.
    addrs: list[str] = cast(list[str], redis.zrevrange("pings:index", start, stop))
    if not addrs:
        return JSONResponse({"page": page, "size": size, "total": 0, "items": []})

    # Fetch the state for all addresses in a pipeline (HMGET alternative: multiple HGET)
    pipe = redis.pipeline()
    for a in addrs:
        pipe.hget("pings:state", a)
    raws = pipe.execute()

    items = []
    for raw in raws:
        if raw is None:
            continue
        try:
            items.append(json.loads(raw))
        except Exception:
            # skip / or include raw string based on preference
            items.append({"raw": raw})
    # Optionally return totals (costly: ZCARD is O(1) but still an extra call)
    total = redis.zcard("pings:index")
    return JSONResponse({"page": page, "size": size, "total": total, "items": items})


@router.get("/state_scan")
def get_state_scan(
    _current_user: CurrentUser,
    cursor: int = Query(0, ge=0),
    count: int = Query(100, ge=1, le=1000),
):
    """
    Cursor-based, HSCAN-driven pagination. Unordered and eventually-consistent.
    Returns: {"cursor": <next>, "items": [...]}
    """
    redis = get_sync_redis_client()
    # HSCAN returns (new_cursor, dict_of_kvs) in many clients
    new_cursor, raw_map = cast(
        tuple[int, dict[str, str]],
        redis.hscan("pings:state", cursor=cursor, count=count),
    )
    items = []
    for k, v in raw_map.items():
        try:
            items.append(json.loads(v))
        except Exception:
            items.append({"addr": k, "raw": v})
    return JSONResponse({"cursor": int(new_cursor), "items": items})
