#!/bin/bash

# Open a redis-cli shell inside the redis container.
#
#   ./scripts/redis-connect.sh                 # Compose stack
#   ./scripts/redis-connect.sh argus-client-2  # a specific Swarm stack's redis container

set -euo pipefail

STACK="${1:-}"

if [ -z "$STACK" ]; then
  docker compose exec redis redis-cli
else
  CONTAINER=$(docker ps -q -f "name=${STACK}_redis\.")
  if [ -z "$CONTAINER" ]; then
    echo "No running redis container found for stack '${STACK}' (looked for '${STACK}_redis.*')." >&2
    echo "Check: docker stack ps ${STACK}" >&2
    exit 1
  fi
  docker exec -it "$CONTAINER" redis-cli
fi
