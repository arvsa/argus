"""
plan/backend-lifespan-role-split-v1.md §3.3: a central argus-server
(ROLE=server) has no local device data, so the ping-pipeline routes
(/ws/pings, /stats, /state, /state_scan) must not be mounted on it at all.
"""
from app.api.main import build_api_router


def test_client_role_includes_ping_routes() -> None:
    router = build_api_router("client")
    paths = {getattr(r, "path", None) for r in router.routes}
    assert "/ws/pings" in paths
    assert "/stats" in paths
    assert "/state" in paths
    assert "/state_scan" in paths


def test_server_role_excludes_ping_routes() -> None:
    router = build_api_router("server")
    paths = {getattr(r, "path", None) for r in router.routes}
    assert "/ws/pings" not in paths
    assert "/stats" not in paths
    assert "/state" not in paths
    assert "/state_scan" not in paths
