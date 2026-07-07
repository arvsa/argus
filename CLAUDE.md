# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

A network device monitoring system. It pings thousands of devices, tracks their up/down state in Redis, and streams live status updates to clients over WebSockets. Deployable as a single stack, or split across independent **zones** (e.g. one per building/site) that each run their own local monitoring and push signed, aggregated snapshots to a central `argus-server` dashboard. See [plan/dynamic-hierarchy-multi-zone-architecture.md](plan/dynamic-hierarchy-multi-zone-architecture.md) and its [implementation summary](plan/dynamic-hierarchy-multi-zone-implementation-summary.md) for the design and what's shipped.

Services:
- **`backend/`** — FastAPI (Python) REST API + WebSocket server, MySQL DB via SQLModel/Alembic. Doubles as either a zone's local API or the central `argus-server` ingestion/dashboard API depending on whether `S3_BUCKET` is configured.
- **`pingsvc/`** — Go service that concurrently ICMPs devices and publishes state changes to Redis. `-role` (`pingsvc` / `exporter` / `both`) controls whether it pings, exports signed snapshots to object storage, or both (`both` = a full `argus-client`).
- **`frontend/`** — React + Vite + TypeScript dashboard
- **`redis`** — Shared message bus between pingsvc and backend, local to each zone

## Commands

Setup, local dev servers, tests, lint/format, and build commands for each
service are documented in that service's README — check there first:

- [backend/README.md](backend/README.md) — uv setup, `fastapi dev`, pytest,
  alembic migrations, mypy/ruff
- [pingsvc/README.md](pingsvc/README.md) — Go build/run, `go test`,
  Docker Compose usage, Prometheus metrics

Full-stack quick start (see [root README](README.md) for the complete
walkthrough):

```bash
docker compose watch backend       # start stack with hot reload on backend
docker compose logs backend        # tail backend logs
docker compose stop backend        # stop just the backend (run local dev server instead)
```

Full backend test suite, used in the [Feature Branch Workflow](#feature-branch-workflow) below:

```bash
./scripts/test.sh                  # full test run inside Docker (builds, runs, tears down)
```

## Architecture

### Real-time ping pipeline

```
pingsvc (Go) → ICMP → devices
     ↓ state change only (Lua script, atomic)
Redis PUBLISH pings:events / events:node:<id>
     ↓
FastAPI redis_listener_task (startup lifespan)
     ↓
Broadcaster → WebSocket clients at /ws/pings
```

The Go `pingsvc` uses a Lua script (`publishIfChangedAndAggregateScript`) to atomically compare previous device state before publishing — only state *changes* are published. It maintains aggregated up/down counters per ancestor node in a Redis hash (`stats:node:<id>`, one per node in the device's ancestor chain), and snapshots every device's last known state in `pings:state`.

The FastAPI backend holds both a sync and async Redis client. The async client powers the pub/sub listener task; the sync client is used in regular route handlers (e.g., `/state`, `/state_scan`).

### Multi-zone export/ingestion pipeline

```
pingsvc -role=both (argus-client)
     ↓ every N seconds: gzip snapshot of stats:node:*/pings:state
Local spool dir → Ed25519-signed manifest → push to S3-compatible object storage
     ↓ key layout: {tenant_id}/{zone_id}/YYYY/MM/DD/HH/<ts>.json.gz(+.manifest.json)
argus-server backend ingestion_task (startup lifespan, polls the bucket)
     ↓ verifies signature against the *registered* ZoneSigningKey (never the manifest's embedded key)
ClientSnapshot / ZoneSummary (MySQL) → GET /api/v1/zones/summary (includes is_stale)
```

`ARGUS_ROLE`/`-role` on pingsvc (`pingsvc` / `exporter` / `both`) gates which half of this runs in a given process; a plain single-stack deployment just runs `-role=pingsvc` (the default) with nothing configured to export. See [development.md](development.md#running-a-full-argus-client--argus-server-locally) for a fully worked two-terminal walkthrough.

### Multi-zone export/ingestion pipeline

```
pingsvc -role=both (argus-client)
     ↓ every N seconds: gzip snapshot of stats:node:*/pings:state
Local spool dir → Ed25519-signed manifest → push to S3-compatible object storage
     ↓ key layout: {tenant_id}/{zone_id}/YYYY/MM/DD/HH/<ts>.json.gz(+.manifest.json)
argus-server backend ingestion_task (startup lifespan, polls the bucket)
     ↓ verifies signature against the *registered* ZoneSigningKey (never the manifest's embedded key)
ClientSnapshot / ZoneSummary (MySQL) → GET /api/v1/zones/summary (includes is_stale)
```

`ARGUS_ROLE`/`-role` on pingsvc (`pingsvc` / `exporter` / `both`) gates which half of this runs in a given process; a plain single-stack deployment just runs `-role=pingsvc` (the default) with nothing configured to export. See [development.md](development.md#running-a-full-argus-client--argus-server-locally) for a fully worked two-terminal walkthrough.

### Data model

```
NodeType → Node
```
Admin-configurable, arbitrary-depth, per-tenant tree (`/api/v1/node-types`, `/api/v1/nodes`, seeded per-zone from `hierarchy.yaml` via `backend/app/seed_hierarchy.py` at prestart) — this replaced an earlier fixed `Campus → Building → Room → Device` chain, which has been fully retired (tables dropped, routes and tests removed). All relationships use `ondelete="CASCADE"`. All PKs are UUIDs generated server-side.

The single `models.py` file contains both SQLModel DB tables and all Pydantic request/response schemas (pattern: `XxxBase`, `XxxCreate`, `XxxUpdate`, `XxxPublic`, `XxxsPublic`, `Xxx` table). This includes the legacy `Campus`/`Building`/`Room`/`Device` chain, the generalized `NodeType`/`Node` hierarchy (`/api/v1/node-types`, `/api/v1/nodes`, seeded per-zone from `hierarchy.yaml` via `backend/app/seed_hierarchy.py` at prestart), and the multi-zone tables `ClientSnapshot`/`ZoneSummary`/`ZoneSigningKey`.

### Auth

JWT-based. `deps.py` provides `CurrentUser` (any authenticated user) and `get_current_active_superuser`. Most write operations (`POST`/`PUT`/`DELETE`) require `is_superuser=True`. Users have an `admission_status` field (`pending`/`approved`/`rejected`).

### API structure

All routes live under `/api/v1` (configured via `API_V1_STR`). The `private` router (used for test setup) is only mounted in `ENVIRONMENT=local`. Unique operation IDs are generated as `{tag}-{route_name}`.

### Database

MySQL (not PostgreSQL — the project was migrated). Driver: `mysql+pymysql`. Config reads from `.env` via `pydantic-settings`. The `prestart` Docker service runs `alembic upgrade head` + `initial_data.py` before the backend starts.

### pingsvc internals

- Worker pool (default 50 goroutines) reads from a `jobs` channel; a ticker enqueues all targets every interval
- Results go to a `results` channel, flushed to Redis in batches via pipelined `EVALSHA`
- Exposes Prometheus metrics at `:9090/metrics`
- Targets loaded from a newline-delimited file (`-targets` flag); defaults to `8.8.8.8`, `1.1.1.1`. Lines may append `;ancestor1;ancestor2;...` node IDs for the hierarchy; bare IPs stay backward compatible.
- `Role` (`role.go`) gates which subsystems run in this process: `RunsPingPipeline()` for the worker pool above, `RunsExporter()` for the independent snapshot/export goroutine (`exporter.go`) described in the multi-zone pipeline above


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
git checkout -b <type>/<description>
# e.g. git checkout -b feature/add-device-filter
#      git checkout -b fix/ws-reconnect-loop
```

For every new change (feature, bugfix, etc.), follow this loop:

1. Implement the change following the TDD loop above
2. Run `./scripts/test.sh` — do not proceed if tests fail
3. **Stop and show the user the changes (diff). Wait for the user to explicitly accept before committing — do not commit on your own judgment that the change looks done.**
4. Once accepted: stage and commit: `git add -A && git commit -m "<description>"`
5. Push: `git push origin <branch-name>`
6. Open a PR to `main` — then stop. Do not merge.

**Never commit directly to `main`. Never start work without a branch. Never commit before the user has reviewed and accepted the changes.**
