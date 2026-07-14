#! /usr/bin/env bash

# Tail logs for one service in an Argus Swarm stack.
#
#   ./scripts/swarm/logs.sh client backend              # argus-client-1_backend
#   ./scripts/swarm/logs.sh client pingsvc 2             # argus-client-2_pingsvc
#   ./scripts/swarm/logs.sh server backend
#   ./scripts/swarm/logs.sh minio minio                   # minio_minio (no number)
#   ./scripts/swarm/logs.sh traefik traefik               # traefik_traefik (no number)
#
# Defaults to `--follow --tail 100`. Any trailing args override that and
# are passed straight through to `docker service logs`:
#
#   ./scripts/swarm/logs.sh client backend --tail 500 --since 10m
#   ./scripts/swarm/logs.sh server backend 1 --no-task-ids

set -euo pipefail

usage() {
  echo "Usage: $0 <client|server> <service> [number] [docker service logs args...]" >&2
  echo "       $0 <minio|traefik> <service> [docker service logs args...]" >&2
  exit 1
}

ROLE_ARG="${1:-}"
SERVICE="${2:-}"
[ -n "$ROLE_ARG" ] && [ -n "$SERVICE" ] || usage
shift 2

case "$ROLE_ARG" in
  client|server)
    NUM=1
    if [ $# -gt 0 ] && [[ "$1" =~ ^[0-9]+$ ]]; then
      NUM="$1"
      shift
    fi
    STACK_NAME="argus-${ROLE_ARG}-${NUM}"
    ;;
  minio|traefik)
    STACK_NAME="$ROLE_ARG"
    ;;
  *)
    usage
    ;;
esac

SERVICE_NAME="${STACK_NAME}_${SERVICE}"

if ! docker service inspect "$SERVICE_NAME" >/dev/null 2>&1; then
  echo "error: service '$SERVICE_NAME' not found." >&2
  echo "known services in stack '$STACK_NAME':" >&2
  docker stack services "$STACK_NAME" --format '  {{.Name}}' 2>/dev/null >&2 \
    || echo "  (stack '$STACK_NAME' not deployed)" >&2
  exit 1
fi

ARGS=("$@")
[ "${#ARGS[@]}" -eq 0 ] && ARGS=(--follow --tail 100)

docker service logs "${ARGS[@]}" "$SERVICE_NAME"
