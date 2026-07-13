#! /usr/bin/env bash

# Build (and optionally push) the three Argus images for Swarm deploys.
# Swarm can't build (`docker stack deploy` ignores build:), so this is the
# build half that scripts/swarm/deploy.sh assumes has already run.
#
#   ./scripts/swarm/build.sh            # build backend/pingsvc/frontend :latest
#   TAG=v3 ./scripts/swarm/build.sh     # custom tag (deploy with the same TAG)
#   REGISTRY=ghcr.io/you/ TAG=v3 ./scripts/swarm/build.sh --push
#                                       # prefix + push, for multi-node swarms
#
# The frontend is always the prod nginx target: a Swarm stack is a
# deployment topology, not a hot-reload dev loop (use compose for that).

set -euo pipefail

cd "$(dirname "$0")/../.."

# Reuse image names from .env when present, same vars compose.yml uses.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

TAG="${TAG:-latest}"
REGISTRY="${REGISTRY:-}"   # e.g. ghcr.io/you/ -- include the trailing slash
PUSH=false
[ "${1:-}" = "--push" ] && PUSH=true

BACKEND_IMAGE="${REGISTRY}${DOCKER_IMAGE_BACKEND:-backend}:${TAG}"
PINGSVC_IMAGE="${REGISTRY}${DOCKER_IMAGE_PINGSVC:-pingsvc}:${TAG}"
FRONTEND_IMAGE="${REGISTRY}${DOCKER_IMAGE_FRONTEND:-frontend}:${TAG}"

echo "==> building ${BACKEND_IMAGE}"
docker build -f backend/Dockerfile -t "$BACKEND_IMAGE" .

echo "==> building ${PINGSVC_IMAGE}"
docker build -f pingsvc/Dockerfile -t "$PINGSVC_IMAGE" ./pingsvc

echo "==> building ${FRONTEND_IMAGE} (prod target)"
docker build -f frontend/Dockerfile --target prod -t "$FRONTEND_IMAGE" .

if $PUSH; then
  echo "==> pushing"
  docker push "$BACKEND_IMAGE"
  docker push "$PINGSVC_IMAGE"
  docker push "$FRONTEND_IMAGE"
fi

echo "done: $BACKEND_IMAGE $PINGSVC_IMAGE $FRONTEND_IMAGE"
