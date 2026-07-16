from fastapi import APIRouter

from app.api.routes import (
    devices,
    discovery,
    login,
    node_types,
    nodes,
    pings,
    private,
    users,
    utils,
    zones,
)
from app.core.config import settings


def build_api_router(role: str) -> APIRouter:
    """`pings.router` (/ws/pings, /stats, /state, /state_scan) is only
    meaningful for a role=client instance with a local ping pipeline feeding
    it -- a role=server instance has no local devices, so it's left
    unmounted entirely (404, not a runtime Redis error). See
    plan/backend-lifespan-role-split-v1.md §3.3."""
    router = APIRouter()
    router.include_router(login.router)
    router.include_router(users.router)
    router.include_router(utils.router)
    if role == "client":
        router.include_router(pings.router)
    router.include_router(zones.router)
    router.include_router(node_types.router)
    router.include_router(nodes.router)
    router.include_router(devices.router)
    router.include_router(discovery.router)

    if settings.ENVIRONMENT == "local":
        router.include_router(private.router)

    return router


api_router = build_api_router(settings.ROLE)
