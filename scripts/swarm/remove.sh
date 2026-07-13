#! /usr/bin/env bash

# Remove one Argus Swarm stack:
#
#   ./scripts/swarm/remove.sh client 2   # removes stack argus-client-2
#
# Named volumes (DB data, the zone's Ed25519 signing key under
# <stack>_argus-data) survive removal on purpose -- redeploying the same
# numbered stack picks its identity back up. To destroy a zone for good:
#   docker volume rm $(docker volume ls -q --filter name=argus-client-2_)

set -euo pipefail

usage() {
  echo "Usage: $0 <client|server> [number>=1]" >&2
  exit 1
}

ROLE_ARG="${1:-}"
NUM="${2:-1}"
case "$ROLE_ARG" in client|server) ;; *) usage ;; esac
[[ "$NUM" =~ ^[0-9]+$ ]] || usage

docker stack rm "argus-${ROLE_ARG}-${NUM}"
