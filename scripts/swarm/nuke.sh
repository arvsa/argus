#! /usr/bin/env bash

# Wipe every trace of the Argus Swarm dev environment: stacks, volumes,
# the traefik-public network, and locally built images. Unlike
# teardown-dev.sh (which deliberately keeps DB data / zone signing keys /
# MinIO data so a stack can redeploy with the same identity), this is for
# resetting a dev swarm back to a blank slate.
#
#   ./scripts/swarm/nuke.sh            # prompts for confirmation
#   ./scripts/swarm/nuke.sh --force    # skip the prompt
#   ./scripts/swarm/nuke.sh --leave    # also `docker swarm leave --force`
#
# Removes:
#   - every argus-server-*/argus-client-*/traefik/minio stack
#   - all argus-*, minio_*, and traefik_* named volumes
#   - the traefik-public overlay network
#   - locally built backend/pingsvc/frontend images (all tags, honors
#     DOCKER_IMAGE_* / REGISTRY from .env same as build.sh)
#
# Does NOT touch stacks/images/volumes unrelated to Argus.

set -euo pipefail

FORCE=0
LEAVE_SWARM=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --leave) LEAVE_SWARM=1 ;;
    *)
      echo "Usage: $0 [--force] [--leave]" >&2
      exit 1
      ;;
  esac
done

cd "$(dirname "$0")/../.."

if [ "$FORCE" -ne 1 ]; then
  echo "This will permanently delete ALL Argus swarm stacks, their volumes"
  echo "(DB data, zone signing keys, MinIO data), the traefik-public"
  echo "network, and locally built backend/pingsvc/frontend images."
  read -r -p "Type 'nuke' to continue: " confirm
  if [ "$confirm" != "nuke" ]; then
    echo "Aborted."
    exit 1
  fi
fi

# ── 1. remove stacks ─────────────────────────────────────────────────────
STACK_PATTERN='^(argus-(server|client)-[0-9]+|traefik|minio)$'

STACKS=()
while IFS= read -r stack; do
  STACKS+=("$stack")
done < <(docker stack ls --format '{{.Name}}' | grep -E "$STACK_PATTERN" || true)

if [ "${#STACKS[@]}" -gt 0 ]; then
  echo "==> removing stacks: ${STACKS[*]}"
  docker stack rm "${STACKS[@]}"

  echo "==> waiting for services to drain"
  SERVICE_PATTERN='^(argus-(server|client)-[0-9]+|traefik|minio)_'
  for _ in $(seq 1 60); do
    docker service ls --format '{{.Name}}' | grep -qE "$SERVICE_PATTERN" || break
    sleep 1
  done
else
  echo "No argus/traefik/minio stacks found."
fi

# ── 2. remove volumes ────────────────────────────────────────────────────
echo "==> removing volumes"
VOLUMES=()
while IFS= read -r vol; do
  VOLUMES+=("$vol")
done < <(
  docker volume ls -q --filter name=argus-
  docker volume ls -q --filter name=minio_
  docker volume ls -q --filter name=traefik_
)

if [ "${#VOLUMES[@]}" -gt 0 ]; then
  # sort -u in case a volume matched more than one filter above
  mapfile -t VOLUMES < <(printf '%s\n' "${VOLUMES[@]}" | sort -u)
  if ! docker volume rm "${VOLUMES[@]}"; then
    echo "    some volumes are still attached -- retrying once after a pause"
    sleep 3
    docker volume rm "${VOLUMES[@]}" 2>/dev/null || echo "    still stuck; a container may not have exited cleanly, check 'docker ps -a'"
  fi
else
  echo "    none found"
fi

# ── 3. remove overlay network ────────────────────────────────────────────
echo "==> removing traefik-public overlay network"
docker network rm traefik-public 2>/dev/null || echo "    not found / already removed"

# ── 4. remove locally built images ───────────────────────────────────────
echo "==> removing locally built images"
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi
REGISTRY="${REGISTRY:-}"
IMAGES=(
  "${REGISTRY}${DOCKER_IMAGE_BACKEND:-backend}"
  "${REGISTRY}${DOCKER_IMAGE_PINGSVC:-pingsvc}"
  "${REGISTRY}${DOCKER_IMAGE_FRONTEND:-frontend}"
)
for img in "${IMAGES[@]}"; do
  ids="$(docker images -q "$img")"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    docker rmi -f $ids 2>/dev/null || true
  fi
done

# ── 5. optionally leave swarm mode ───────────────────────────────────────
if [ "$LEAVE_SWARM" -eq 1 ]; then
  echo "==> leaving swarm mode"
  docker swarm leave --force
fi

echo
echo "Done. Argus swarm state wiped clean."
