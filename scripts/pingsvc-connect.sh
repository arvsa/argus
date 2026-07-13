#!/bin/bash

# Open a shell inside the pingsvc container (alpine-based -- sh, not bash).
#
#   ./scripts/pingsvc-connect.sh                 # Compose stack
#   ./scripts/pingsvc-connect.sh argus-client-2  # a specific Swarm stack's pingsvc container

set -euo pipefail

STACK="${1:-}"

if [ -z "$STACK" ]; then
  docker compose exec pingsvc sh
else
  CONTAINER=$(docker ps -q -f "name=${STACK}_pingsvc\.")
  if [ -z "$CONTAINER" ]; then
    echo "No running pingsvc container found for stack '${STACK}' (looked for '${STACK}_pingsvc.*')." >&2
    echo "Check: docker stack ps ${STACK}" >&2
    exit 1
  fi
  docker exec -it "$CONTAINER" sh
fi
