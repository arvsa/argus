# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

A network device monitoring system. It pings thousands of devices (Campus → Building → Room → Device hierarchy), tracks their up/down state in Redis, and streams live status updates to clients over WebSockets.

Three services:
- **`backend/`** — FastAPI (Python) REST API + WebSocket server, MySQL DB via SQLModel/Alembic
- **`pingsvc/`** — Go service that concurrently ICMPs devices and publishes state changes to Redis
- **`redis`** — Shared message bus between pingsvc and backend

## Commands

### Docker (recommended for full-stack)

```bash
docker compose watch backend       # start stack with hot reload on backend
docker compose logs backend        # tail backend logs
docker compose stop backend        # stop just the backend (run local dev server instead)
```

### Backend local dev

```bash
cd backend
fastapi dev app/main.py            # dev server at http://localhost:8000
```

### Backend tests

```bash
./scripts/test.sh                  # full test run inside Docker (builds, runs, tears down)

# Or locally (requires DB + Redis):
cd backend
coverage run -m pytest tests/
coverage report
pytest tests/api/routes/test_login.py::test_login_access_token_correct  # single test
```

### Backend lint & format

```bash
cd backend
bash scripts/lint.sh               # mypy + ruff check + ruff format --check
bash scripts/format.sh             # ruff fix + ruff format (auto-fixes)
```

### pingsvc

```bash
cd pingsvc
go build -o pingsvc ./cmd/pingsvc
./pingsvc -redis localhost:6379 -targets targets.txt

# Generate dummy targets file:
./pingsvc/generate_targets.sh
docker compose up pingsvc -d       # run in Docker (auto-starts redis)
```

### Database migrations

```bash
cd backend
alembic upgrade head               # apply all pending migrations
alembic revision --autogenerate -m "description"  # generate new migration
```

## Architecture

### Real-time ping pipeline

```
pingsvc (Go) → ICMP → devices
     ↓ state change only (Lua script, atomic)
Redis PUBLISH pings:events / events:room:<id> / events:bldg:<id>
     ↓
FastAPI redis_listener_task (startup lifespan)
     ↓
Broadcaster → WebSocket clients at /ws/pings
```

The Go `pingsvc` uses a Lua script (`publishIfChangedAndAggregateScript`) to atomically compare previous device state before publishing — only state *changes* are published. It also maintains aggregated up/down counters per room and building in Redis hashes (`stats:room:<id>`, `stats:bldg:<id>`), and snapshots every device's last known state in `pings:state`.

The FastAPI backend holds both a sync and async Redis client. The async client powers the pub/sub listener task; the sync client is used in regular route handlers (e.g., `/state`, `/state_scan`, device creation cache writes).

### Data model

```
Campus → Building → Room → Device
```
All relationships use `ondelete="CASCADE"`. `Device.room_id` is nullable (devices can be unassigned). All PKs are UUIDs generated server-side.

The single `models.py` file contains both SQLModel DB tables and all Pydantic request/response schemas (pattern: `XxxBase`, `XxxCreate`, `XxxUpdate`, `XxxPublic`, `XxxsPublic`, `Xxx` table).

### Auth

JWT-based. `deps.py` provides `CurrentUser` (any authenticated user) and `get_current_active_superuser`. Most write operations (`POST`/`PUT`/`DELETE` on devices, buildings, etc.) require `is_superuser=True`. Users have an `admission_status` field (`pending`/`approved`/`rejected`).

### API structure

All routes live under `/api/v1` (configured via `API_V1_STR`). The `private` router (used for test setup) is only mounted in `ENVIRONMENT=local`. Unique operation IDs are generated as `{tag}-{route_name}`.

### Database

MySQL (not PostgreSQL — the project was migrated). Driver: `mysql+pymysql`. Config reads from `.env` via `pydantic-settings`. The `prestart` Docker service runs `alembic upgrade head` + `initial_data.py` before the backend starts.

### pingsvc internals

- Worker pool (default 50 goroutines) reads from a `jobs` channel; a ticker enqueues all targets every interval
- Results go to a `results` channel, flushed to Redis in batches via pipelined `EVALSHA`
- Exposes Prometheus metrics at `:9090/metrics`
- Targets loaded from a newline-delimited file (`-targets` flag); defaults to `8.8.8.8`, `1.1.1.1`


## TDD Working Method

Every feature follows a strict TDD loop — no exceptions:

1. Write the test → run suite → confirm RED
2. Implement the feature
3. Run suite → confirm GREEN
4. Refactor if needed → re-run → must stay GREEN
5. Move to next feature

## Tasks

- Consider the current task and whether the information learned can be suggested in a Claude.md file whether at the root of project or inside relevant files

- Create a md for plans under plan directory.

## Feature Branch Workflow

**Before touching any file, always checkout to main and get the latest changes from remote and create a branch first. No exceptions.**

```bash
git checkout main
git pull
git checkout -b /
# e.g. git checkout -b feature/add-device-filter
#      git checkout -b fix/ws-reconnect-loop
```or every new change. (ex, feature, bugfix, etc..):


w this loop:

1. Implement the change following the TDD loop above
2. Run `./scripts/test.sh` — do not proceed if tests fail
3. **Stop and show the user the changes (diff). Wait for the user to explicitly accept before committing — do not commit on your own judgment that the change looks done.**
4. Once accepted: stage and commit: `git add -A && git commit -m "<description>"`
5. Push: `git push origin <branch-name>`
6. Open a PR to `main` — then stop. Do not merge.

**Never commit directly to `main`. Never start work without a branch. Never commit before the user has reviewed and accepted the changes.**
