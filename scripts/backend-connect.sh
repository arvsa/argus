#!/bin/bash

# Open a bash shell inside the backend container.
#
#   ./scripts/backend-connect.sh                 # Compose stack
#   ./scripts/backend-connect.sh argus-client-2  # a specific Swarm stack's backend container

set -euo pipefail

STACK="${1:-}"

if [ -z "$STACK" ]; then
  docker compose exec backend bash
else
  CONTAINER=$(docker ps -q -f "name=${STACK}_backend\.")
  if [ -z "$CONTAINER" ]; then
    echo "No running backend container found for stack '${STACK}' (looked for '${STACK}_backend.*')." >&2
    echo "Check: docker stack ps ${STACK}" >&2
    exit 1
  fi
  docker exec -it "$CONTAINER" bash
fi
