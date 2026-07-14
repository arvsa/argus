#! /usr/bin/env bash

# Rebuild the image(s) for one Argus role and redeploy just that stack --
# without touching any other running stack (other client zones, the
# server, minio, traefik). Complements build.sh (builds all three images
# unconditionally) and deploy.sh (deploys from whatever images already
# exist); this is the "I changed backend code, kick argus-client-2" loop.
#
#   ./scripts/swarm/rebuild.sh client            # rebuild backend/pingsvc/frontend, redeploy argus-client-1
#   ./scripts/swarm/rebuild.sh client 2           # ... argus-client-2
#   ./scripts/swarm/rebuild.sh server             # rebuild backend/frontend (no pingsvc), redeploy argus-server-1
#
# server stacks don't run pingsvc (see swarm/stack.server.yml), so only
# client rebuilds touch the pingsvc image.
#
# `docker stack deploy` alone won't restart already-running tasks when the
# image tag string is unchanged (default TAG=latest, same as deploy.sh's
# --resolve-image never) -- it only diffs the compose spec, not image
# content. So once the stack already exists, this force-updates the
# affected services directly (the documented workaround for "same tag,
# new local image bits") instead of re-running `docker stack deploy`.
# Single-node only, like deploy.sh's default -- for multi-node swarms set
# REGISTRY and push the rebuilt images yourself before this will help.

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

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

TAG="${TAG:-latest}"
REGISTRY="${REGISTRY:-}"
BACKEND_IMAGE="${REGISTRY}${DOCKER_IMAGE_BACKEND:-backend}:${TAG}"
FRONTEND_IMAGE="${REGISTRY}${DOCKER_IMAGE_FRONTEND:-frontend}:${TAG}"
PINGSVC_IMAGE="${REGISTRY}${DOCKER_IMAGE_PINGSVC:-pingsvc}:${TAG}"

STACK_NAME="argus-${ROLE_ARG}-${NUM}"

echo "==> building ${BACKEND_IMAGE}"
docker build -f backend/Dockerfile -t "$BACKEND_IMAGE" .

echo "==> building ${FRONTEND_IMAGE} (prod target)"
docker build -f frontend/Dockerfile --target prod -t "$FRONTEND_IMAGE" .

# prestart and backend share the backend image (see swarm/stack.*.yml)
SERVICES=(prestart backend frontend)
if [ "$ROLE_ARG" = "client" ]; then
  echo "==> building ${PINGSVC_IMAGE}"
  docker build -f pingsvc/Dockerfile -t "$PINGSVC_IMAGE" ./pingsvc
  SERVICES+=(pingsvc)
fi

if ! docker stack ls --format '{{.Name}}' | grep -qx "$STACK_NAME"; then
  echo "==> stack '${STACK_NAME}' not deployed yet -- deploying it now"
  exec ./scripts/swarm/deploy.sh "$ROLE_ARG" "$NUM"
fi

echo "==> forcing running services in ${STACK_NAME} to pick up the new images"
for svc in "${SERVICES[@]}"; do
  full="${STACK_NAME}_${svc}"
  if docker service inspect "$full" >/dev/null 2>&1; then
    echo "    ${full}"
    docker service update --force --detach=true "$full" >/dev/null
  else
    echo "    ${full} not found, skipping"
  fi
done

echo "==> done. Watch:  docker stack ps ${STACK_NAME}"
