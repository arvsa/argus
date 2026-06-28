# Argus

A network device monitoring system. It continuously pings thousands of devices across a Campus → Building → Room → Device hierarchy, tracks up/down state in Redis, and streams live status changes to clients over WebSockets.

## Services

| Service | Description |
|---|---|
| **backend** | FastAPI REST API + WebSocket server (Python) |
| **pingsvc** | Concurrent ICMP ping daemon (Go) |
| **db** | MySQL 8 database |
| **redis** | Pub/sub message bus between pingsvc and backend |
| **adminer** | Database web UI |

## Quick Start

**Prerequisites**: Docker and Docker Compose.

```bash
# Clone and start
docker compose watch backend
```

Local URLs:

- Backend API: http://localhost:8000
- API docs (Swagger): http://localhost:8000/docs
- Adminer (DB UI): http://localhost:8080
- pingsvc Prometheus metrics: http://localhost:9090/metrics

The first run may take a minute while the backend waits for MySQL and runs migrations.

## Development

### Running the backend locally (without Docker)

```bash
docker compose stop backend
cd backend
fastapi dev app/main.py      # hot-reload dev server at :8000
```

The Docker stack keeps running for MySQL and Redis; only the backend switches to local.

### Running pingsvc locally

```bash
# Generate dummy targets
./pingsvc/generate_targets.sh

# Build and run
cd pingsvc
go build -o pingsvc ./cmd/pingsvc
./pingsvc -redis localhost:6379 -targets targets.txt
```

### Lint and format (backend)

```bash
cd backend
bash scripts/lint.sh     # mypy + ruff check + ruff format --check
bash scripts/format.sh   # auto-fix with ruff
```

### Tests (backend)

```bash
# Full run in Docker
./scripts/test.sh

# Or locally (requires DB + Redis running)
cd backend
coverage run -m pytest tests/
coverage report

# Single test
pytest tests/api/routes/test_login.py::test_login_access_token_correct
```

## Environment Variables

All config is in `.env` (root). Key variables:

| Variable | Description |
|---|---|
| `MYSQL_SERVER` | MySQL host (default: `db`) |
| `MYSQL_ROOT_PASSWORD` | MySQL root password |
| `MYSQL_DATABASE` | Database name (default: `rcc`) |
| `REDIS_URL` | Redis connection URL |
| `SECRET_KEY` | JWT signing key — change before deploying |
| `FIRST_SUPERUSER` | Admin email created on first startup |
| `FIRST_SUPERUSER_PASSWORD` | Admin password — change before deploying |
| `ENVIRONMENT` | `local` / `staging` / `production` |

Generate a secure secret key:
```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

## How It Works

**pingsvc** (Go) concurrently ICMPs all devices in a worker pool. On a state change (up→down or down→up), it runs a Lua script in Redis that atomically updates the device's state, increments room/building counters, and publishes a JSON event to `pings:events` (or scoped room/building channels).

The **backend** subscribes to Redis on startup. Incoming events are fanned out to all connected WebSocket clients at `/ws/pings`. The current snapshot of all device states is also queryable via REST at `/state` and `/state_scan`.

## Database Migrations

Migrations run automatically on startup via the `prestart` service. To create a new migration manually:

```bash
cd backend
alembic revision --autogenerate -m "describe the change"
alembic upgrade head
```

## Deployment

The stack uses **Traefik** as a reverse proxy and supports Docker Compose deployment to a Linux server. CI/CD is configured via GitHub Actions:

- Push to `master` → deploys to **staging**
- Publish a GitHub release → deploys to **production**

See [deployment.md](deployment.md) for the full Traefik setup and required GitHub secrets.

Required secrets for GitHub Actions: `DOMAIN_PRODUCTION`, `DOMAIN_STAGING`, `STACK_NAME_PRODUCTION`, `STACK_NAME_STAGING`, `FIRST_SUPERUSER`, `FIRST_SUPERUSER_PASSWORD`, `MYSQL_ROOT_PASSWORD` (or `POSTGRES_PASSWORD` if renamed), `SECRET_KEY`.

## Connecting to Running Services

```bash
bash scripts/db-connect.sh       # MySQL shell inside the db container
bash scripts/backend-connect.sh  # bash shell inside the backend container
```

To subscribe to live ping events:
```bash
docker compose exec redis redis-cli
SUBSCRIBE pings:events
```
