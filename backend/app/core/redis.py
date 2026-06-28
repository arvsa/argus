import asyncio

import redis
import redis.asyncio as aioredis

from app.core.config import settings

_sync_redis: redis.Redis | None = None
_async_redis: aioredis.Redis | None = None


def create_sync_redis_client() -> redis.Redis:
    """Create a new synchronous redis client (redis-py)."""
    return redis.from_url(settings.REDIS_URL, decode_responses=True)


def create_async_redis_client() -> aioredis.Redis:
    """Create a new async redis client (redis.asyncio)."""
    return aioredis.from_url(settings.REDIS_URL, decode_responses=True)


def set_sync_redis_client(client: redis.Redis) -> None:
    global _sync_redis
    _sync_redis = client


def set_async_redis_client(client: aioredis.Redis) -> None:
    global _async_redis
    _async_redis = client


def get_sync_redis_client() -> redis.Redis:
    if _sync_redis is None:
        raise RuntimeError("Sync Redis client not initialized (call set_sync_redis_client during startup).")
    return _sync_redis


def get_async_redis_client() -> aioredis.Redis:
    if _async_redis is None:
        raise RuntimeError("Async Redis client not initialized (call set_async_redis_client during startup).")
    return _async_redis


async def redis_listener_task(stop_event: asyncio.Event):
    """
    Background task: subscribe to CHANNEL and forward messages to connected websockets.
    Stops when stop_event is set.
    Uses the async Redis client.
    """
    redis_client = get_async_redis_client()
    pubsub = redis_client.pubsub()
    await pubsub.subscribe(settings.REDIS_CHANNEL)

    try:
        while not stop_event.is_set():
            item = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if not item:
                await asyncio.sleep(0)  # cooperative scheduling
                continue
            data = item.get("data")
            if data is None:
                continue
            # broadcast the message to websockets (your existing broadcaster)
            from app.core.broadcast import (
                broadcaster as b,  # import here to avoid cycle
            )
            await b.broadcast(data)
    finally:
        try:
            await pubsub.unsubscribe(settings.REDIS_CHANNEL)
            await pubsub.close()
        except Exception:
            pass
