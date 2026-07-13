# Backend (FastAPI)

REST API + WebSocket server for Argus. Serves the device hierarchy (an
admin-configurable NodeType/Node tree — see [../hierarchy.md](../hierarchy.md)),
auth, and live ping status over `/ws/pings`. MySQL via SQLModel/Alembic;
subscribes to Redis pub/sub for real-time state changes published by
`pingsvc`.

See the [root README](../README.md) for how this service fits into the full
stack, and [../CLAUDE.md](../CLAUDE.md) for architecture notes.

## Requirements

- Python 3.10+ (Docker image uses 3.14)
- [uv](https://docs.astral.sh/uv/) for dependency management
- A running MySQL instance and Redis instance (see root `compose.yml`)

## Setup

Dependencies are managed with `uv` and defined in the repo-root
`pyproject.toml` / `uv.lock` (this is a uv workspace member, not a standalone
package).

```bash
# from repo root
uv sync
```

Copy `.env.example` at the repo root to `.env` and fill in `MYSQL_SERVER`,
`MYSQL_ROOT_PASSWORD`, `MYSQL_DATABASE`, `REDIS_URL`, `SECRET_KEY`,
`FIRST_SUPERUSER`, `FIRST_SUPERUSER_PASSWORD`. Full variable reference in
`app/core/config.py` (`Settings`).

## Running locally

The usual flow is to run MySQL + Redis in Docker and the backend natively for
hot reload:

```bash
docker compose stop backend   # from repo root, if the stack is already up
cd backend
fastapi dev app/main.py       # dev server at http://localhost:8000
```

API docs: http://localhost:8000/docs (Swagger), http://localhost:8000/redoc.

To run the full service in Docker instead:

```bash
docker compose watch backend  # from repo root
```

## Database migrations

Migrations run automatically via the `prestart` Docker service
(`alembic upgrade head` + `app/initial_data.py`) before the backend starts.
To manage them manually:

```bash
cd backend
alembic upgrade head
alembic revision --autogenerate -m "describe the change"
```

Alembic env config and versions live in `app/alembic/`.

## Tests

Requires MySQL + Redis reachable (either via Docker or local instances).

```bash
# Full run inside Docker (builds, runs, tears down) — from repo root
./scripts/test.sh

# Or locally
cd backend
coverage run -m pytest tests/
coverage report

# Single test
pytest tests/api/routes/test_login.py::test_login_access_token_correct
```

Test layout:

- `tests/api/routes/` — endpoint tests (devices, node types, nodes, node
  stats, pings, stats, users, login, permissions, zones)
- `tests/crud/` — CRUD-layer unit tests
- `tests/scripts/` — tests for `backend_pre_start.py` / `tests_pre_start.py`
- `tests/utils/` — shared fixtures/helpers (e.g. `hierarchy.py`, `user.py`)

The `private` router (`app/api/routes` — mounted only when
`ENVIRONMENT=local`) exists to let tests set up fixture data over HTTP; see
`tests/api/test_private_router_gating.py` for the gating test itself.

## Lint & format

```bash
cd backend
bash scripts/lint.sh     # mypy + ruff check + ruff format --check
bash scripts/format.sh   # ruff --fix + ruff format (auto-fixes)
```

Config: `[tool.mypy]` (strict mode) and `[tool.ruff]` in `pyproject.toml`.

## Project layout

```
app/
  api/            routes + deps.py (CurrentUser, get_current_active_superuser)
  core/           config.py (Settings), db.py, redis.py, broadcast.py, security.py
  alembic/        migration env + versions
  models.py       SQLModel tables + Pydantic schemas (XxxBase/Create/Update/Public)
  main.py         FastAPI app, lifespan (starts redis_listener_task)
  crud.py         DB access helpers
  initial_data.py seed data run by prestart
scripts/          lint.sh, format.sh, test.sh, tests-start.sh, prestart.sh
tests/            pytest suite (see above)
```

## How real-time ping data reaches this service

`pingsvc` publishes state-change events to Redis (`pings:events` plus
per-room/building channels). On startup, `app/main.py`'s lifespan starts a
`redis_listener_task` using the async Redis client, which fans events out to
connected WebSocket clients at `/ws/pings` via `app/core/broadcast.py`. A
separate sync Redis client is used in regular route handlers (`/state`,
`/state_scan`, device creation cache writes). Full pipeline diagram in
[../CLAUDE.md](../CLAUDE.md).
