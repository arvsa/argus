#! /usr/bin/env bash

# Tear down the local dev stack started by run.sh.
#
#   ./scripts/teardown.sh              # stop and remove containers/networks
#   ./scripts/teardown.sh -v           # also remove volumes (db data, redis
#                                       #   data, argus spool/export data)
#   ./scripts/teardown.sh -v --images  # also remove images built for this
#                                       #   project (backend/frontend/pingsvc)
#
# Always includes both compose profiles (default + "client") and
# compose.override.yml if present, so this cleans up regardless of which
# mode run.sh was started in. Deliberately excludes compose.traefik.yml --
# that's a separate standalone production overlay (real Traefik + Let's
# Encrypt, requires DOMAIN/EMAIL/USERNAME/HASHED_PASSWORD), never combined
# with compose.yml locally, and run.sh doesn't reference it either.
#
# Does NOT set COMPOSE_PROJECT_NAME -- unlike scripts/test.sh's isolated
# "argus-test" project, this is meant to tear down your actual local dev
# stack (the plain "argus" project), so it must target the same project
# compose would use by default.

set -e

usage() {
  echo "Usage: $0 [-v|--volumes] [--images]" >&2
  exit 1
}

REMOVE_VOLUMES=0
REMOVE_IMAGES=0

while [ $# -gt 0 ]; do
  case "$1" in
    -v|--volumes)
      REMOVE_VOLUMES=1
      shift
      ;;
    --images)
      REMOVE_IMAGES=1
      shift
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

COMPOSE_FILES=(-f compose.yml)
[ -f compose.override.yml ] && COMPOSE_FILES+=(-f compose.override.yml)

COMPOSE=(docker compose "${COMPOSE_FILES[@]}" --profile client)

DOWN_ARGS=(--remove-orphans)
[ "$REMOVE_VOLUMES" -eq 1 ] && DOWN_ARGS+=(-v)
[ "$REMOVE_IMAGES" -eq 1 ] && DOWN_ARGS+=(--rmi local)

echo "Tearing down argus stack..."
"${COMPOSE[@]}" down "${DOWN_ARGS[@]}"

if [ "$REMOVE_VOLUMES" -eq 1 ]; then
  echo "Volumes removed: app-db-data, redis-data, argus-data"
else
  echo "Volumes preserved (pass -v to remove db/redis/export data too)."
fi
