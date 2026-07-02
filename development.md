# Development

This covers day-to-day local development: running each service outside Docker, lint/format/test commands, and — the main event — actually running a full `argus-client` + `argus-server` pair locally so you can watch the multi-zone pipeline work end-to-end in your own terminal.

For a one-shot single-stack local setup, see the [Quick Start in README.md](README.md#quick-start). For production deployment, see [deployment.md](deployment.md).

## Docker Compose basics

The stack is defined across two files, both used automatically by plain `docker compose` commands:

- `compose.yml` — the whole stack, used as-is in production.
- `compose.override.yml` — local-dev-only overrides (bind-mounted source for hot reload, published ports, Mailcatcher, a local `minio` service for the multi-zone demo below). Automatically merged on top of `compose.yml` when you don't pass `-f`.

```bash
docker compose watch backend   # start the stack, hot-reload + stream logs for backend
docker compose logs -f <name>  # tail logs for one or more services
docker compose stop backend    # stop just one service (e.g. to run it locally instead)
```

The first run may take a minute while the backend waits for MySQL and runs migrations — `docker compose logs -f prestart` to watch that happen.

### Running the backend locally (without Docker)

```bash
docker compose stop backend
cd backend
uv sync                      # first time only
fastapi dev app/main.py      # hot-reload dev server at :8000
```

The Docker stack keeps running for MySQL and Redis; only the backend switches to local. `fastapi dev` reads config from `../.env` — override any variable by exporting it in your shell first (real env vars take precedence over `.env`), which is exactly how the argus-server walkthrough below runs a second backend instance with different settings.

### Running pingsvc locally

```bash
# Generate dummy targets (run from repo root — writes to pingsvc/targets.txt)
./pingsvc/generate_targets.sh

cd pingsvc
go build -o pingsvc ./cmd/pingsvc
./pingsvc -redis localhost:6379 -targets targets.txt
```

> **Gotcha:** If you start pingsvc via Docker before `targets.txt` exists, Docker creates a directory at that path instead of a file. If this happens: stop the container, `rmdir pingsvc/targets.txt`, generate the file, then `docker compose up pingsvc -d --force-recreate`.

To run it as a full `argus-client` (ping pipeline + exporter) instead of ping-only, add `-role=both` plus the export/S3 flags — see the walkthrough below for the exact flags and what each one does.

### Running the frontend locally

```bash
cd frontend
npm install
npm run dev      # dev server at :5173, proxies API calls to the backend
```

> **Known issue:** `frontend/Dockerfile` does not exist yet, even though `compose.override.yml` references one. `docker compose build` for the full stack will fail until it's added — run the frontend with `npm run dev` locally instead, or build/run `db`, `redis`, `prestart`, and `backend` individually (see [scripts/test.sh](scripts/test.sh) for the exact commands CI uses).

### Lint and format (backend)

```bash
cd backend
bash scripts/lint.sh     # mypy + ruff check + ruff format --check
bash scripts/format.sh   # auto-fix with ruff
```

### Tests

**backend** (requires DB + Redis running):

```bash
./scripts/test.sh                          # full run in Docker

cd backend                                 # or locally
coverage run -m pytest tests/ && coverage report
pytest tests/api/routes/test_login.py::test_login_access_token_correct   # single test
```

**pingsvc**:

```bash
cd pingsvc
go vet ./... && go test ./...
```

**frontend**:

```bash
cd frontend
npm run test    # vitest
npm run lint    # oxlint
npm run build   # tsc -b && vite build
```

---

## Running a full argus-client + argus-server locally

This walks through the actual multi-zone pipeline: a **zone** (`argus-client`) pinging devices, signing and pushing aggregated snapshots to S3-compatible object storage, and a separate **argus-server** instance pulling, verifying, and ingesting them — with a way to watch every hop in your terminal. Two terminals, plus a one-time setup step.

### 0. One-time setup

```bash
cp .env.example .env
./pingsvc/generate_targets.sh
```

For this walkthrough, replace the generated `pingsvc/targets.txt` with a small file so the demo is easy to read (a handful of devices, tagged with a dynamic-hierarchy ancestor chain — see [plan/dynamic-hierarchy-multi-zone-architecture.md §4.3](plan/dynamic-hierarchy-multi-zone-architecture.md) for the `addr,ancestor1;ancestor2;...` format):

```bash
cat > pingsvc/targets.txt <<'EOF'
127.0.0.1,acme-corp;zone-demo;rack-1
1.1.1.1,acme-corp;zone-demo;rack-2
8.8.8.8
EOF
```

> Without the `NET_RAW` capability (commented out in `compose.yml`'s `pingsvc` service by default), unprivileged ICMP inside the container will report every device as down. That's fine for this walkthrough — the point is watching the *data pipeline* (state capture → signed snapshot → push → verify → ingest) work correctly, not real reachability. Uncomment `cap_add: [NET_RAW, NET_ADMIN]` if you want real up/down results.

Set these in `.env` (already present as commented-out examples — uncomment and fill in):

```dotenv
ARGUS_ROLE=both
ARGUS_ZONE_ID=zone-demo
ARGUS_TENANT_ID=acme-corp
ARGUS_S3_BUCKET=argus-metrics
ARGUS_S3_ENDPOINT=http://minio:9000
ARGUS_S3_ACCESS_KEY=minioadmin
ARGUS_S3_SECRET_KEY=minioadmin
ARGUS_SIGNING_KEY_PATH=/var/lib/argus/signing.key
```

### Terminal 1 — the zone (argus-client)

```bash
# db/redis/minio + the zone's own backend and pingsvc (role=both, per .env above)
docker compose up -d db redis minio prestart backend pingsvc

# Create the demo bucket (one-time; minio has no default buckets)
docker run --rm --network argus_default \
  -e MC_HOST_local=http://minioadmin:minioadmin@minio:9000 \
  minio/mc mb local/argus-metrics

# Watch it ping and, every ~30s, sign + push a snapshot
docker compose logs -f pingsvc
```

You should see, after the first export interval:

```
starting pingsvc: 3 targets, interval=1s, timeout=800ms, redis=redis:6379, workers=50, batch=500
exporter: generated new signing key at /var/lib/argus/signing.key
exporter: wrote snapshot to /var/lib/argus/pending/<ts>.json.gz (4 nodes, 3 devices)
exporter: pushed 1 snapshot(s) to object storage
```

Confirm the objects actually landed (a snapshot plus its signed manifest, at the key layout from plan §4.4):

```bash
docker run --rm --network argus_default \
  -e MC_HOST_local=http://minioadmin:minioadmin@minio:9000 \
  minio/mc find local/argus-metrics
# local/argus-metrics/acme-corp/zone-demo/2026/07/02/22/<ts>.json.gz
# local/argus-metrics/acme-corp/zone-demo/2026/07/02/22/<ts>.json.gz.manifest.json
```

This zone's own `backend` (port 8000) is a completely normal single-stack backend — its `S3_BUCKET` isn't set, so it never runs the ingestion task. It's the *pingsvc* side alone that makes this a client.

### Terminal 2 — the server (argus-server)

The server is a second backend instance, pointed at its own database, with `S3_BUCKET` set so its ingestion task activates. Since `compose.override.yml` publishes `db`/`redis`/`minio` on `localhost`, the simplest way to run a second instance locally is as a plain local process (not a second Docker stack):

```bash
# One-time: a separate database so the server's tables don't mix with the zone's
docker compose exec -T db mysql -uroot -pchangethis -e "CREATE DATABASE IF NOT EXISTS argus_server;"

cd backend
uv sync   # first time only

export MYSQL_SERVER=localhost MYSQL_PORT=3306 MYSQL_DATABASE=argus_server MYSQL_ROOT_PASSWORD=changethis
export REDIS_URL=redis://localhost:6379/0
export S3_BUCKET=argus-metrics S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=minioadmin S3_SECRET_KEY=minioadmin
export PROJECT_NAME=argus-server FIRST_SUPERUSER=admin@example.com FIRST_SUPERUSER_PASSWORD=changethis SECRET_KEY=changethis
export ENVIRONMENT=local DOMAIN=localhost FRONTEND_HOST=http://localhost:5173
export INGESTION_INTERVAL_SECONDS=10   # faster feedback for this walkthrough (default 60)

uv run python app/backend_pre_start.py
uv run alembic upgrade head
uv run python app/initial_data.py       # creates the FIRST_SUPERUSER above

uv run fastapi run app/main.py --port 8001
```

Watch its logs — every `INGESTION_INTERVAL_SECONDS` you'll see:

```
INFO:app.core.ingestion:ingestion: ingested 1 new snapshot(s)
```

### See the result

```bash
TOKEN=$(curl -s -X POST http://localhost:8001/api/v1/login/access-token \
  -d "username=admin@example.com&password=changethis" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

curl -s http://localhost:8001/api/v1/zones/summary -H "Authorization: Bearer $TOKEN" | python3 -m json.tool
```

```json
{
  "data": [
    {
      "tenant_id": "acme-corp",
      "zone_id": "zone-demo",
      "up_count": 3,
      "down_count": 0,
      "last_snapshot_ts": 1783030304238,
      "last_pulled_at": "2026-07-02T22:11:52",
      "is_stale": false
    }
  ],
  "count": 1
}
```

The exact `up_count`/`down_count` split depends on whether your Docker setup grants `pingsvc` real ICMP permissions (see the `NET_RAW` note above) — without it every device reports down instead, which is equally valid evidence for what this proves either way: pingsvc pinged 3 devices in a completely separate process/database/directory tree, signed and pushed an aggregate snapshot to object storage on its own schedule, and this *other* backend instance — which has never talked to the zone directly — pulled it, matched it up by `(tenant_id, zone_id)`, and rolled it into a live summary with a staleness check attached.

### Bonus: prove the signature verification works

Right now `signature_verified` isn't visible in the API response, and every ingested snapshot shows `None` (unknown) in the database, because the server has no registered public key for `zone-demo` yet — `verify_manifest` only ever trusts a key it already has on file (plan §4.4), never the manifest's self-reported one. Register the zone's key and watch the *next* ingested snapshot (not retroactively) verify:

```bash
# Pull the zone's signing key's public half out of the running pingsvc container
docker compose exec pingsvc cat /var/lib/argus/signing.key | xxd -p | tr -d '\n' > /tmp/key.hex
PUBKEY=$(tail -c 64 /tmp/key.hex)   # last 32 bytes = the public key half

# In the server's terminal/venv:
uv run python3 -c "
from sqlmodel import Session
from app.core.db import engine
from app import crud
from app.models import ZoneSigningKeyCreate

with Session(engine) as session:
    crud.create_zone_signing_key(
        session=session,
        key_create=ZoneSigningKeyCreate(tenant_id='acme-corp', zone_id='zone-demo', public_key_hex='$PUBKEY'),
    )
"
```

Wait for one more ingestion cycle, then check:

```bash
uv run python3 -c "
from sqlmodel import Session, select
from app.core.db import engine
from app.models import ClientSnapshot

with Session(engine) as session:
    snaps = session.exec(
        select(ClientSnapshot).where(ClientSnapshot.zone_id == 'zone-demo')
        .order_by(ClientSnapshot.snapshot_ts.desc())
    ).all()
    for s in snaps[:3]:
        print(s.storage_key, 'verified=', s.signature_verified)
"
# <newest>.json.gz verified= True     <- ingested after key registration
# <older>.json.gz   verified= None    <- ingested before, correctly left unknown, not retroactively marked
```

### Cleaning up

```bash
# Ctrl-C the server process in terminal 2
docker compose down -v --remove-orphans   # tears down db/redis/minio/backend/pingsvc + volumes
```

## Docker Compose files and env vars

`compose.yml` has the whole stack's configuration; `compose.override.yml` layers local-dev-only overrides on top (bind-mounted source, published ports, Mailcatcher, the `minio` service used above). Both read `.env` for values injected as environment variables into containers. After changing `.env`, restart the affected service(s).

`.env` contains your local secrets/passwords — depending on your workflow you may want to keep it out of git (it already is, via `.gitignore`) and instead inject each variable through your CI/CD system's secrets.

## Testing with a custom local domain

By default the stack uses `localhost` with a different port per service. To test subdomain-based routing the way Traefik does it in production, set in `.env`:

```dotenv
DOMAIN=localhost.tiangolo.com
```

`localhost.tiangolo.com` (and all its subdomains) is a public DNS entry that resolves to `127.0.0.1`, so `api.localhost.tiangolo.com` and `dashboard.localhost.tiangolo.com` work locally once you restart the stack. See [deployment.md](deployment.md) for how the same Traefik setup works in production.

### Development URLs

| Service | `localhost` | `localhost.tiangolo.com` |
|---|---|---|
| Frontend | http://localhost:5173 | http://dashboard.localhost.tiangolo.com |
| Backend | http://localhost:8000 | http://api.localhost.tiangolo.com |
| Swagger UI | http://localhost:8000/docs | http://api.localhost.tiangolo.com/docs |
| ReDoc | http://localhost:8000/redoc | http://api.localhost.tiangolo.com/redoc |
| Adminer | http://localhost:8080 | http://localhost.tiangolo.com:8080 |
| Traefik UI | http://localhost:8090 | http://localhost.tiangolo.com:8090 |
| MailCatcher | http://localhost:1080 | http://localhost.tiangolo.com:1080 |

## Mailcatcher

Mailcatcher is a simple SMTP server that catches all emails sent by the backend during local development instead of sending real ones — useful for testing/debugging email flows without a real SMTP provider. The backend is automatically configured to use it when running via `docker compose` locally (SMTP on port 1025); view captured emails at http://localhost:1080.
