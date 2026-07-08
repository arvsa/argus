"""
plan/backend-lifespan-role-split-v1.md: a central argus-server (ROLE=server)
must start and run ingestion without any reachable Redis -- it has no local
ping pipeline to feed, so the Redis client setup / ping-retry loop /
redis_listener_task must be skipped entirely rather than blocking startup.
"""
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.main import app


def test_app_starts_with_role_server_and_unreachable_redis(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "ROLE", "server")
    # TEST-NET-1 (RFC 5737) -- guaranteed unreachable, never times out slowly
    # since a role=server startup must never attempt a Redis connection at all.
    monkeypatch.setattr(settings, "REDIS_URL", "redis://192.0.2.1:6379/0")

    with TestClient(app) as c:
        r = c.get(f"{settings.API_V1_STR}/utils/health-check/")
        assert r.status_code == 200
