# swarm/

Docker Swarm stack definitions for running `argus-server` and each
`argus-client` zone as independent, dynamically-numbered stacks
(`argus-server-<#>` / `argus-client-<#>`) behind one shared Traefik — so a
single swarm can host the central server plus any number of zones side by
side. See [../plan/swarm-orchestration-v1.md](../plan/swarm-orchestration-v1.md)
for the full design rationale (why separate stack files instead of reusing
`compose.yml`, known limits). This file covers day-to-day usage.

## Files

| File | Purpose |
|---|---|
| `stack.server.yml` | `argus-server` — db, migrations, backend (`ROLE=server`), frontend |
| `stack.client.yml` | one `argus-client` zone — the above plus redis and pingsvc |
| `stack.traefik.dev.yml` | local-dev Traefik (HTTP-only, no Let's Encrypt) |
| `stack.traefik.yml` | production Traefik (Let's Encrypt, basic-auth dashboard) |
| `stack.minio.yml` | dev-only S3-compatible storage, shared across every stack |

**Why the frontend needs `BACKEND_UPSTREAM`:** every zone's frontend joins
the same external `traefik-public` overlay network (so Traefik can route
`dashboard.<zone>.*`/`api.<zone>.*` to it), and every zone's backend joins
that same shared network too (so Traefik can route directly to it for
`api.<zone>.*`). That means the bare Compose DNS name `backend` — which
`frontend/nginx.conf.template`'s `/api/` reverse proxy uses by default —
is ambiguous once more than one stack is deployed: it previously resolved
non-deterministically to *some* stack's backend, not necessarily its own,
so one zone's dashboard could silently authenticate against a different
zone's database. `swarm/stack.client.yml`/`stack.server.yml` set
`BACKEND_UPSTREAM=<stack-name>_backend` on the frontend service — Swarm's
own full service name, which is globally unique regardless of shared
networks — to pin each frontend to its own backend. Compose is unaffected
(its `traefik-public` is a private per-project network, so `backend` is
never ambiguous there), which is why the image's default is still the bare
`backend`.

Deployed/managed via [`../scripts/swarm/`](../scripts/swarm/) — `build.sh`,
`deploy.sh`, `remove.sh`, `dev-setup.sh`, `teardown-dev.sh`.

## Quick start (local dev)

```bash
docker compose --profile client down   # if the Compose dev stack is running — see gotcha below
./scripts/swarm/dev-setup.sh           # swarm init, traefik-dev + minio, build images, argus-server-1 + argus-client-1
```

This needs `traefik-public` as an **overlay** network and shares ports
80/8090 with the Compose dev proxy, so the two setups can't run at once.

Once up:

- Server dashboard: `http://dashboard.argus-server-1.localhost`
- Client dashboard: `http://dashboard.argus-client-1.localhost`
- Traefik dashboard: `http://localhost:8090`
- Status: `docker stack ls && docker service ls`
- Teardown: `./scripts/swarm/teardown-dev.sh [--leave]`

## Development loop

**Editing happens on the host, never inside a container.** Only
`pingsvc/targets.txt` and `hierarchy.yaml` are bind-mounted — everything
else (backend/frontend/pingsvc source) is baked into the image at build
time, unlike the Compose dev setup which bind-mounts the whole source tree
for hot reload. Anything changed inside a running container is gone the
moment that task gets replaced.

There is no hot reload here — a Swarm stack is a deployment topology, not
a dev loop. For iterating on application logic itself, use
`docker compose watch backend` or `fastapi dev` locally (see
[../development.md](../development.md)); it's much faster. Use the Swarm
stack when you specifically need to exercise something that only exists at
this layer — Traefik routing across numbered zones, cross-stack isolation,
rolling-update behavior, the real multi-zone topology.

When you do need to test a code change here, rebuild and force a redeploy:

```bash
./scripts/swarm/build.sh                            # rebuilds all three (Docker layer cache skips untouched ones)
docker service update --force argus-server-1_backend
docker service update --force argus-client-1_pingsvc
docker service update --force argus-server-1_frontend
```

**Gotcha:** re-running `deploy.sh` alone after a rebuild does *not* pick up
your change, even though it prints `Updating service ...`. `deploy.sh`
passes `--resolve-image never` (deliberate — it avoids pinning a registry
digest for locally-built single-node images), so `docker stack deploy`
compares the literal image string (`backend:latest`), sees no difference
since the tag never changed, and leaves the running task alone — the
container can silently stay hours old. `docker service update --force`
(above) is what actually recreates the task against your current local
image. The alternative is bumping `TAG` every iteration (`TAG=dev2
./scripts/swarm/build.sh && TAG=dev2 ARGUS_SWARM_DEV=1 ARGUS_SCHEME=http
./scripts/swarm/deploy.sh server 1`), which changes the spec and so
`docker stack deploy` picks it up on its own — more ceremony, but leaves a
clean image history.

After forcing an update, give Traefik a few seconds to re-register the new
task's endpoint — a request right after a force-update can 404 or 502
briefly before it converges.

## Testing integration between services (client ↔ MinIO ↔ server)

`dev-setup.sh` already wires `argus-client-1` and `argus-server-1` together
through the shared `minio` stack, so this is the default state once it's
up — no extra setup needed to have "a couple of services running against
each other." To verify the pipeline is actually working end to end after a
change:

```bash
# 1. Watch the client sign + push a snapshot (every ~30s)
docker service logs -f argus-client-1_pingsvc

# 2. Confirm it landed in MinIO
docker exec $(docker ps -q -f name=minio_minio) \
  mc alias set local http://localhost:9000 minioadmin minioadmin
docker exec $(docker ps -q -f name=minio_minio) mc ls -r local/argus-metrics

# 3. Watch the server pull it in
docker service logs -f argus-server-1_backend | grep -i ingestion

# 4. Confirm end to end via the API (through Traefik, with a Host header)
set -a; source .env; set +a
TOKEN=$(curl -s -H "Host: api.argus-server-1.localhost" \
  -X POST http://localhost/api/v1/login/access-token \
  -d "username=${FIRST_SUPERUSER}&password=${FIRST_SUPERUSER_PASSWORD}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s -H "Host: api.argus-server-1.localhost" -H "Authorization: Bearer $TOKEN" \
  http://localhost/api/v1/zones/summary | python3 -m json.tool
```

A healthy pipeline shows the zone in that last response with `is_stale:
false` and a recent `last_pulled_at`.

**If a route 404s and the services all look "Running":** the container
being up doesn't mean Traefik has a working route to it. Check what
Traefik itself thinks is registered before assuming the app is broken:

```bash
curl -s http://localhost:8090/api/http/routers | python3 -m json.tool     # status: "enabled" or "disabled", + why
curl -s http://localhost:8090/api/http/services | python3 -m json.tool    # is the backend server marked "UP"?
curl -s http://localhost:8090/api/http/middlewares | python3 -m json.tool # e.g. missing https-redirect breaks every *-http router
docker service logs traefik_traefik --tail 100 | grep -iE "error|warn"
```

Add another zone the same way, wired to the same MinIO:

```bash
ARGUS_SWARM_DEV=1 ARGUS_SCHEME=http ./scripts/swarm/deploy.sh client 2
```

## Teardown

```bash
./scripts/swarm/remove.sh client 2        # remove one stack (data volumes survive)
./scripts/swarm/teardown-dev.sh           # remove every argus-*/traefik/minio stack
./scripts/swarm/teardown-dev.sh --leave   # ...and exit swarm mode entirely
```
