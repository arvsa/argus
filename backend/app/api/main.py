from fastapi import APIRouter

from app.api.routes import (
    buildings,
    campuses,
    devices,
    login,
    pings,
    private,
    rooms,
    users,
    utils,
)
from app.core.config import settings

api_router = APIRouter()
api_router.include_router(login.router)
api_router.include_router(users.router)
api_router.include_router(utils.router)
api_router.include_router(campuses.router)
api_router.include_router(buildings.router)
api_router.include_router(rooms.router)
api_router.include_router(devices.router)
api_router.include_router(pings.router)

if settings.ENVIRONMENT == "local":
    api_router.include_router(private.router)
