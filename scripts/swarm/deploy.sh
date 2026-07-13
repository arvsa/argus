#! /usr/bin/env bash

# Deploy one Argus role as its own Swarm stack with a dynamic name:
#
#   ./scripts/swarm/deploy.sh server        # stack argus-server-1
#   ./scripts/swarm/deploy.sh client        # stack argus-client-1
#   ./scripts/swarm/deploy.sh client 2      # stack argus-client-2 (a 2nd zone)
#
# Prereqs: swarm mode active, the traefik-public overlay network + a Traefik
# stack deployed (scripts/swarm/dev-setup.sh does all of it for local dev),
# and images built via scripts/swarm/build.sh with the same TAG.
#
# Env layering, lowest to highest precedence:
#   1. .env                      -- shared base (secrets, image names, TAG)
#   2. computed per-stack values -- STACK_NAME, DOMAIN, FRONTEND_HOST,
#      BACKEND_CORS_ORIGINS, ARGUS_ZONE_ID: these are stack-scoped, so any
#      value they have in the base .env is deliberately ignored (a single
#      shared DOMAIN would make every stack's Host() rules collide)
#   3. .env.argus-<role>-<#>     -- per-stack overrides (production sets its
#      real DOMAIN, S3 config, zone identity here)
#
# Dev conveniences (ARGUS_SWARM_DEV=1, set by dev-setup.sh): S3/exporter
# config defaults to the shared MinIO stack and *.localhost domains work
# without DNS (Chrome resolves them to 127.0.0.1 natively).

set -euo pipefail

usage() {
  echo "Usage: $0 <client|server> [number>=1]" >&2
  exit 1
}

ROLE_ARG="${1:-}"
NUM="${2:-1}"
case "$ROLE_ARG" in client|server) ;; *) usage ;; esac
[[ "$NUM" =~ ^[0-9]+$ ]] || usage

cd "$(dirname "$0")/../.."
REPO_DIR="$(pwd)"

set -a

# ── 1. shared base ──────────────────────────────────────────────────────
if [ -f .env ]; then
  # shellcheck disable=SC1091
  source .env
fi

# ── 2. computed per-stack values (see header) ───────────────────────────
STACK_NAME="argus-${ROLE_ARG}-${NUM}"
DOMAIN="${STACK_NAME}.${ARGUS_BASE_DOMAIN:-localhost}"
SCHEME="${ARGUS_SCHEME:-https}"
FRONTEND_HOST="${SCHEME}://dashboard.${DOMAIN}"
BACKEND_CORS_ORIGINS="${SCHEME}://dashboard.${DOMAIN},${SCHEME}://api.${DOMAIN}"
ARGUS_REPO_DIR="$REPO_DIR"
TAG="${TAG:-latest}"
DOCKER_IMAGE_BACKEND="${DOCKER_IMAGE_BACKEND:-backend}"
DOCKER_IMAGE_PINGSVC="${DOCKER_IMAGE_PINGSVC:-pingsvc}"
DOCKER_IMAGE_FRONTEND="${DOCKER_IMAGE_FRONTEND:-frontend}"

if [ "$ROLE_ARG" = "client" ]; then
  # Each numbered stack is its own zone by default.
  ARGUS_ZONE_ID="zone-${NUM}"
  ARGUS_TENANT_ID="${ARGUS_TENANT_ID:-default}"
  ARGUS_TARGETS_FILE="${ARGUS_TARGETS_FILE:-${REPO_DIR}/pingsvc/targets.txt}"
  if [ "${ARGUS_SWARM_DEV:-0}" = "1" ]; then
    ARGUS_S3_BUCKET="${ARGUS_S3_BUCKET:-argus-metrics}"
    ARGUS_S3_ENDPOINT="${ARGUS_S3_ENDPOINT:-http://minio:9000}"
    ARGUS_S3_ACCESS_KEY="${ARGUS_S3_ACCESS_KEY:-minioadmin}"
    ARGUS_S3_SECRET_KEY="${ARGUS_S3_SECRET_KEY:-minioadmin}"
  fi
else
  if [ "${ARGUS_SWARM_DEV:-0}" = "1" ]; then
    S3_BUCKET="${S3_BUCKET:-argus-metrics}"
    S3_ENDPOINT="${S3_ENDPOINT:-http://minio:9000}"
    S3_ACCESS_KEY="${S3_ACCESS_KEY:-minioadmin}"
    S3_SECRET_KEY="${S3_SECRET_KEY:-minioadmin}"
    INGESTION_INTERVAL_SECONDS="${INGESTION_INTERVAL_SECONDS:-10}"
  fi
fi

# ── 3. per-stack overrides ──────────────────────────────────────────────
if [ -f ".env.${STACK_NAME}" ]; then
  # shellcheck disable=SC1090
  source ".env.${STACK_NAME}"
fi

set +a

# ── sanity before handing off to swarm ──────────────────────────────────
if [ "$ROLE_ARG" = "server" ] && [ -z "${S3_BUCKET:-}" ]; then
  echo "error: argus-server needs S3_BUCKET (set it in .env.${STACK_NAME}," >&2
  echo "or run via dev-setup.sh for the MinIO-backed dev default)" >&2
  exit 1
fi
if [ "$ROLE_ARG" = "client" ] && [ ! -f "$ARGUS_TARGETS_FILE" ]; then
  echo "==> no targets file at ${ARGUS_TARGETS_FILE}, generating"
  ./pingsvc/generate_targets.sh 20000 "$ARGUS_TARGETS_FILE"
fi
if ! docker image inspect "${DOCKER_IMAGE_BACKEND}:${TAG}" >/dev/null 2>&1; then
  echo "error: image ${DOCKER_IMAGE_BACKEND}:${TAG} not found -- run scripts/swarm/build.sh first" >&2
  exit 1
fi

echo "==> deploying stack ${STACK_NAME} (domain ${DOMAIN}, tag ${TAG})"
# --resolve-image never: don't try to pin registry digests for locally
# built images (single-node); set REGISTRY + build.sh --push for multi-node.
docker stack deploy --detach=true --prune --resolve-image never \
  -c "swarm/stack.${ROLE_ARG}.yml" "$STACK_NAME"

echo "==> deployed. Watch:  docker stack ps ${STACK_NAME}"
echo "    dashboard: ${SCHEME}://dashboard.${DOMAIN}"
echo "    api:       ${SCHEME}://api.${DOMAIN}"
