#! /usr/bin/env bash

# Bring up the correct stack for this machine's role.
#
#   ./scripts/run.sh client   # a zone: backend + redis + pingsvc + frontend
#   ./scripts/run.sh server   # central argus-server: backend + frontend only
#                             #   (no local devices, so no redis/pingsvc)
#
# redis and pingsvc are gated behind compose.yml's "client" profile, so
# "server" mode never starts them at all -- not just leaves them idle.

set -e

usage() {
  echo "Usage: $0 <client|server>" >&2
  exit 1
}

[ $# -eq 1 ] || usage
ROLE="$1"

case "$ROLE" in
  client)
    export ROLE=client
    if [ ! -f pingsvc/targets.txt ]; then
      ./pingsvc/generate_targets.sh
    fi
    docker compose --profile client up -d
    ;;
  server)
    export ROLE=server
    docker compose up -d
    ;;
  *)
    usage
    ;;
esac
