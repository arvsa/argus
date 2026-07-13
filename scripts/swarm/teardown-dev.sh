#! /usr/bin/env bash

# Tear down the Swarm dev environment stood up by dev-setup.sh: every
# argus-server-*/argus-client-* app stack, plus the shared traefik/minio
# infra stacks.
#
#   ./scripts/swarm/teardown-dev.sh          # remove stacks, stay in swarm mode
#   ./scripts/swarm/teardown-dev.sh --leave  # also `docker swarm leave --force`
#
# Discovers stacks by name via `docker stack ls` rather than assuming a
# fixed count, since ARGUS_CLIENTS=N (dev-setup.sh) can deploy any number
# of numbered client zones.
#
# Named volumes (DB data, zone signing keys, MinIO data) are NOT removed --
# same policy as scripts/swarm/remove.sh: redeploying the same stack picks
# its identity back up. To destroy them too:
#   docker volume rm $(docker volume ls -q --filter name=argus-)
#   docker volume rm $(docker volume ls -q --filter name=minio_)

set -euo pipefail

LEAVE_SWARM=0
case "${1:-}" in
  --leave) LEAVE_SWARM=1 ;;
  "") ;;
  *) echo "Usage: $0 [--leave]" >&2; exit 1 ;;
esac

STACK_PATTERN='^(argus-(server|client)-[0-9]+|traefik|minio)$'

# Not mapfile/readarray -- both are bash 4+, but macOS still ships bash 3.2
# as /bin/bash (and thus what `env bash` resolves to) for GPLv2 reasons.
STACKS=()
while IFS= read -r stack; do
  STACKS+=("$stack")
done < <(docker stack ls --format '{{.Name}}' | grep -E "$STACK_PATTERN" || true)

if [ "${#STACKS[@]}" -eq 0 ]; then
  echo "No argus/traefik/minio stacks found."
else
  echo "==> removing stacks: ${STACKS[*]}"
  docker stack rm "${STACKS[@]}"

  echo "==> waiting for services to drain"
  SERVICE_PATTERN='^(argus-(server|client)-[0-9]+|traefik|minio)_'
  for _ in $(seq 1 30); do
    docker service ls --format '{{.Name}}' | grep -qE "$SERVICE_PATTERN" || break
    sleep 1
  done
fi

if [ "$LEAVE_SWARM" -eq 1 ]; then
  echo "==> leaving swarm mode"
  docker swarm leave --force
fi

cat <<EOF

Done. Data volumes were left in place (db data, zone signing keys, MinIO
data) -- remove them too for a clean slate:
  docker volume rm \$(docker volume ls -q --filter name=argus-) 2>/dev/null
  docker volume rm \$(docker volume ls -q --filter name=minio_) 2>/dev/null
EOF
