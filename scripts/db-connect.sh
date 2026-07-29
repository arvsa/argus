#!/bin/bash

# Open a PostgreSQL shell inside the db container.
#
#   ./scripts/db-connect.sh                 # Compose stack
#   ./scripts/db-connect.sh argus-client-2  # a specific Swarm stack's db container

set -euo pipefail

STACK="${1:-}"

if [ -z "$STACK" ]; then
  docker compose exec db psql -U postgres -d "${POSTGRES_DB:-argus}"
else
  CONTAINER=$(docker ps -q -f "name=${STACK}_db\.")
  if [ -z "$CONTAINER" ]; then
    echo "No running db container found for stack '${STACK}' (looked for '${STACK}_db.*')." >&2
    echo "Check: docker stack ps ${STACK}" >&2
    exit 1
  fi
  docker exec -it "$CONTAINER" psql -U postgres -d "${POSTGRES_DB:-argus}"
fi
