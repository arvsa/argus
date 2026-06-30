"""
The `private` router (used for test setup) must only be mounted when
ENVIRONMENT=local. See app/api/main.py:

    if settings.ENVIRONMENT == "local":
        api_router.include_router(private.router)

This is a pure unit test against the module-level router construction;
it does not touch the live `app` fixture/TestClient so it can't disturb
other tests' shared app instance.
"""
import importlib

from app.core.config import settings


def test_private_router_mounted_when_environment_local() -> None:
    assert settings.ENVIRONMENT == "local", (
        "Test suite is expected to run with ENVIRONMENT=local; "
        "if this changes, the rest of this test module needs updating."
    )
    import app.api.main as api_main

    importlib.reload(api_main)
    try:
        paths = {route.path for route in api_main.api_router.routes}
        assert "/private/users/" in paths
    finally:
        importlib.reload(api_main)


def test_private_router_not_mounted_outside_local(monkeypatch) -> None:
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")

    import app.api.main as api_main

    importlib.reload(api_main)
    try:
        paths = {route.path for route in api_main.api_router.routes}
        assert "/private/users/" not in paths
    finally:
        # Restore ENVIRONMENT (monkeypatch undoes this automatically on
        # teardown) and rebuild the router with the real local config so
        # later tests in the session see the private router mounted again.
        monkeypatch.undo()
        importlib.reload(api_main)
