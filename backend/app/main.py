import asyncio
from contextlib import asynccontextmanager
from typing import Awaitable, cast

import sentry_sdk
from fastapi import FastAPI
from fastapi.routing import APIRoute
from starlette.middleware.cors import CORSMiddleware

from app.api.main import api_router
from app.core.config import settings
from app.core.ingestion import ingestion_task
from app.core.redis import (
    create_async_redis_client,
    create_sync_redis_client,
    redis_listener_task,
    set_async_redis_client,
    set_sync_redis_client,
)


def custom_generate_unique_id(route: APIRoute) -> str:
    return f"{route.tags[0]}-{route.name}"


if settings.SENTRY_DSN and settings.ENVIRONMENT != "local":
    sentry_sdk.init(dsn=str(settings.SENTRY_DSN), enable_tracing=True)


def get_lifespan_or_none():
    return lifespan if settings.REDIS_URL is not None else None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # startup: create both sync and async Redis clients and register them
    sync_client = create_sync_redis_client()
    set_sync_redis_client(sync_client)

    async_client = create_async_redis_client()
    set_async_redis_client(async_client)

    # ensure async connectivity (simple ping loop)
    deadline = asyncio.get_event_loop().time() + 30.0
    last_exc = None
    while asyncio.get_event_loop().time() < deadline:
        try:
            # async_client is genuinely redis.asyncio.Redis; redis-py's
            # stubs type ping() as Awaitable[bool] | bool to also cover the
            # sync client's shared command-mixin signature.
            await cast(Awaitable[bool], async_client.ping())
            break
        except Exception as exc:
            last_exc = exc
            await asyncio.sleep(0.5)
    else:
        # cleanup sync client if we fail to start
        try:
            sync_client.close()
        except Exception:
            pass
        raise RuntimeError("Redis not reachable during startup") from last_exc

    # start redis pub/sub listener (uses async client)
    stop_event = asyncio.Event()
    listener_task = asyncio.create_task(redis_listener_task(stop_event))

    # start argus-server ingestion polling (no-ops if S3_BUCKET unset, see
    # plan/dynamic-hierarchy-multi-zone-architecture.md §4.5)
    ingestion_stop_event = asyncio.Event()
    ingestion_bg_task = asyncio.create_task(ingestion_task(ingestion_stop_event))

    yield

    # shutdown: stop listener and close clients
    stop_event.set()
    try:
        await listener_task
    except Exception:
        # if awaiting raised, cancel task
        listener_task.cancel()
        try:
            await listener_task
        except Exception:
            pass

    ingestion_stop_event.set()
    try:
        await ingestion_bg_task
    except Exception:
        ingestion_bg_task.cancel()
        try:
            await ingestion_bg_task
        except Exception:
            pass

    # close async client
    try:
        await async_client.close()
    except Exception:
        pass

    # close sync client
    try:
        sync_client.close()
    except Exception:
        pass


app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    generate_unique_id_function=custom_generate_unique_id,
    lifespan=get_lifespan_or_none(),
)


# Set all CORS enabled origins
if settings.all_cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.all_cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.include_router(api_router, prefix=settings.API_V1_STR)
