#! /usr/bin/env bash

# Bring up the correct stack for this machine's role.
#
#   ./scripts/run.sh client   # a zone: backend + redis + pingsvc + frontend
#   ./scripts/run.sh server   # central argus-server: backend + frontend only
#                              #   (no local devices, so no redis/pingsvc)
#
# redis and pingsvc are gated behind compose.yml's "client" profile, so
# "server" mode never starts them at all -- not just leaves them idle.
#
# Project name is explicit (not the directory-basename fallback) so it's
# visible here rather than implicit Compose magic -- unchanged default value,
# just stated.

set -e

cd "$(dirname "$0")/.."

usage() {
  echo "Usage: $0 <client|server>" >&2
  exit 1
}

[ $# -ge 1 ] || usage
ROLE="$1"
shift
[ $# -eq 0 ] || usage

case "$ROLE" in
  client|server) ;;
  *) usage ;;
esac

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-argus}"

# ── preflight: Compose and Swarm dev setups can't run at once ───────────
# They share host ports 80/8090, and traefik-public needs a different
# network driver in each (see README.md's Swarm Quick Start section).
# scripts/swarm/dev-setup.sh already guards the reverse direction (Swarm
# detecting a leftover Compose-created bridge network); this is the
# missing other half -- without it, `docker compose up` fails with a raw
# "failed to bind host port for 0.0.0.0:80" error that gives no hint why.
SWARM_STACK_PATTERN='^(traefik|argus-(server|client)-[0-9]+)$'
if [ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)" = "active" ]; then
  swarm_stacks="$(docker stack ls --format '{{.Name}}' 2>/dev/null | grep -E "$SWARM_STACK_PATTERN" || true)"
  if [ -n "$swarm_stacks" ]; then
    echo "error: a Docker Swarm dev stack is already running ($(echo "$swarm_stacks" | tr '\n' ' ')) and holds the ports the Compose dev proxy needs (80/8090)." >&2
    echo "Tear it down first: ./scripts/swarm/teardown-dev.sh" >&2
    exit 1
  fi
fi

case "$ROLE" in
  client)
    export ROLE=client
    if [ ! -f pingsvc/targets.txt ]; then
      ./pingsvc/generate_targets.sh
    fi
    docker compose --profile client up -d --build
    ;;
  server)
    export ROLE=server
    docker compose up -d --build
    ;;
esac
