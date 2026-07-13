#! /usr/bin/env bash

# One-command local development setup for the Swarm topology: a dev
# Traefik, a MinIO (stand-in for S3), one central server stack and one
# client zone stack, wired together:
#
#   ./scripts/swarm/dev-setup.sh          # argus-server-1 + argus-client-1
#   ARGUS_CLIENTS=3 ./scripts/swarm/dev-setup.sh   # ...plus zones 2 and 3
#
# Idempotent: re-running redeploys in place. Add more zones later with
#   ARGUS_SWARM_DEV=1 ARGUS_SCHEME=http ./scripts/swarm/deploy.sh client 2
#
# URLs are on *.localhost (Chrome resolves these to 127.0.0.1 natively;
# for curl, pass a Host header: curl -H "Host: api.argus-server-1.localhost" localhost).
#
# NOTE: this shares ports 80/8090 with the compose dev proxy and requires
# `traefik-public` to be an *overlay* network -- stop the compose stack
# first if it's running (docker compose --profile client down).

set -euo pipefail

cd "$(dirname "$0")/../.."

export ARGUS_SWARM_DEV=1
export ARGUS_SCHEME=http
export ENVIRONMENT="${ENVIRONMENT:-local}"

# ── swarm mode ──────────────────────────────────────────────────────────
if [ "$(docker info --format '{{.Swarm.LocalNodeState}}')" != "active" ]; then
  echo "==> initializing swarm"
  docker swarm init >/dev/null 2>&1 || docker swarm init --advertise-addr 127.0.0.1 >/dev/null
fi

# ── shared overlay network ──────────────────────────────────────────────
driver="$(docker network inspect traefik-public --format '{{.Driver}}' 2>/dev/null || true)"
if [ -z "$driver" ]; then
  echo "==> creating traefik-public overlay network"
  docker network create --driver overlay --attachable traefik-public >/dev/null
elif [ "$driver" != "overlay" ]; then
  echo "error: a non-overlay 'traefik-public' network exists (driver: ${driver})." >&2
  echo "It probably belongs to the compose dev stack. Stop that stack and remove it:" >&2
  echo "  docker compose --profile client down && docker network rm traefik-public" >&2
  echo "(scripts/run.sh recreates it as a bridge next time you use compose)" >&2
  exit 1
fi

# ── infra stacks: dev traefik + minio ───────────────────────────────────
echo "==> deploying traefik (dev, http-only) and minio stacks"
docker stack deploy --detach=true -c swarm/stack.traefik.dev.yml traefik
docker stack deploy --detach=true -c swarm/stack.minio.yml minio

# ── images ──────────────────────────────────────────────────────────────
./scripts/swarm/build.sh

# ── app stacks ──────────────────────────────────────────────────────────
./scripts/swarm/deploy.sh server 1
for i in $(seq 1 "${ARGUS_CLIENTS:-1}"); do
  ./scripts/swarm/deploy.sh client "$i"
done

# ── wait for the server API to answer through traefik ───────────────────
echo "==> waiting for argus-server-1 to become healthy (first deploy can take ~1 min)"
for _ in $(seq 1 60); do
  if curl -sf -H "Host: api.argus-server-1.localhost" \
      http://localhost/api/v1/utils/health-check/ >/dev/null 2>&1; then
    healthy=1; break
  fi
  sleep 3
done
if [ -z "${healthy:-}" ]; then
  echo "warning: server not answering yet -- check: docker stack ps argus-server-1" >&2
else
  echo "==> server is up"
fi

cat <<EOF

Swarm dev environment ready.

  server dashboard:  http://dashboard.argus-server-1.localhost
  client dashboard:  http://dashboard.argus-client-1.localhost
  traefik dashboard: http://localhost:8090
  login:             \$FIRST_SUPERUSER / \$FIRST_SUPERUSER_PASSWORD from .env

  status:    docker stack ls && docker service ls
  logs:      docker service logs -f argus-server-1_backend
  add zone:  ARGUS_SWARM_DEV=1 ARGUS_SCHEME=http ./scripts/swarm/deploy.sh client 2
  teardown:  ./scripts/swarm/teardown-dev.sh [--leave]
EOF
