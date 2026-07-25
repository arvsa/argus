#! /usr/bin/env bash

# Deploy one Argus role as its own Swarm stack with a dynamic name:
#
#   ./scripts/swarm/deploy.sh server        # stack argus-server-1
#   ./scripts/swarm/deploy.sh client        # stack argus-client-1
#   ./scripts/swarm/deploy.sh client 2      # stack argus-client-2 (a 2nd zone)
#   ./scripts/swarm/deploy.sh client 1 --services backend,pingsvc
#                                            # only those two services, rest
#                                            # of the stack left untouched
#
# --services filters the rendered stack config down to just the named
# services (via `docker compose config`, which resolves them plus their
# transitive depends_on) before handing it to `docker stack deploy` --
# swarm/stack.*.yml files don't use depends_on today (see their own header
# comments), so there's nothing transitive to pull in for this repo's
# stacks as they stand. Variable interpolation happens as a whole-file pass
# before filtering, so every ${VAR?required} referenced anywhere in the
# stack file -- even by an excluded service -- must still be set; the .env
# sourcing below already covers this in practice. Omit the flag for
# unchanged full-stack-deploy behavior.
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
  echo "Usage: $0 <client|server> [number>=1] [--services svc1,svc2,...]" >&2
  exit 1
}

ROLE_ARG="${1:-}"
case "$ROLE_ARG" in client|server) ;; *) usage ;; esac
shift || usage

NUM=1
if [ $# -gt 0 ] && [[ "$1" =~ ^[0-9]+$ ]]; then
  NUM="$1"
  shift
fi

SERVICES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --services)
      SERVICES="${2:-}"
      [ -n "$SERVICES" ] || usage
      shift 2
      ;;
    *) usage ;;
  esac
done

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

# --resolve-image never: don't try to pin registry digests for locally
# built images (single-node); set REGISTRY + build.sh --push for multi-node.
if [ -n "$SERVICES" ]; then
  echo "==> deploying stack ${STACK_NAME} (domain ${DOMAIN}, tag ${TAG}, services: ${SERVICES})"
  IFS=',' read -r -a SERVICE_ARGS <<< "$SERVICES"
  # Unlike `docker stack deploy` reading the raw stack file directly (the
  # no-filter path below), routing through `docker compose config` first
  # bakes in Compose's OWN project-name inference as explicit `name:`
  # sub-fields on every network/volume -- COMPOSE_PROJECT_NAME=$STACK_NAME
  # makes that inferred name match what swarm would have derived from
  # $STACK_NAME anyway (e.g. "argus-client-3_default"), rather than some
  # unrelated directory-basename guess. The top-level `name:` (the
  # resolved project name at the document root) still has to be stripped
  # separately -- `docker stack deploy -c -` rejects that specific key
  # ("Additional property name is not allowed") even though the same name
  # baked into each resource's own `name:` sub-field is fine.
  COMPOSE_PROJECT_NAME="$STACK_NAME" docker compose -f "swarm/stack.${ROLE_ARG}.yml" config "${SERVICE_ARGS[@]}" \
    | grep -v '^name:' \
    | docker stack deploy --detach=true --prune --resolve-image never -c - "$STACK_NAME"
else
  echo "==> deploying stack ${STACK_NAME} (domain ${DOMAIN}, tag ${TAG})"
  docker stack deploy --detach=true --prune --resolve-image never \
    -c "swarm/stack.${ROLE_ARG}.yml" "$STACK_NAME"
fi

echo "==> deployed. Watch:  docker stack ps ${STACK_NAME}"
echo "    dashboard: ${SCHEME}://dashboard.${DOMAIN}"
echo "    api:       ${SCHEME}://api.${DOMAIN}"
