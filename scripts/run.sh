#! /usr/bin/env bash

# Bring up the correct stack for this machine's role.
#
#   ./scripts/run.sh client                  # a zone: backend + redis + pingsvc + frontend
#   ./scripts/run.sh client --with-mock-lan  # ...plus the mock-LAN fixture environment
#                                             #   (plan/device-discovery-v1.md §2.9), joined
#                                             #   onto pingsvc's own network -- see
#                                             #   compose.mock-lan.yml/compose.mock-lan-client.yml.
#                                             #   Add an Infrastructure Target at "snmpsim"
#                                             #   (Compose DNS name, community "public") to see
#                                             #   discovery actually find the 3 mock devices.
#   ./scripts/run.sh server                  # central argus-server: backend + frontend only
#                                             #   (no local devices, so no redis/pingsvc)
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
  echo "Usage: $0 <client|server> [--with-mock-lan]" >&2
  exit 1
}

[ $# -ge 1 ] || usage
ROLE="$1"
shift
WITH_MOCK_LAN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --with-mock-lan) WITH_MOCK_LAN=1 ;;
    *) usage ;;
  esac
  shift
done

case "$ROLE" in
  client|server) ;;
  *) usage ;;
esac

if [ "$ROLE" = "server" ] && [ "$WITH_MOCK_LAN" -eq 1 ]; then
  echo "error: --with-mock-lan only makes sense with 'client' -- a server has no local pingsvc to poll the mock router" >&2
  exit 1
fi

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
    if [ "$WITH_MOCK_LAN" -eq 1 ]; then
      COMPOSE="docker compose -f compose.yml -f compose.override.yml -f compose.mock-lan.yml -f compose.mock-lan-client.yml --profile client --profile mock-lan"
    else
      COMPOSE="docker compose --profile client"
    fi
    $COMPOSE up -d --build
    ;;
  server)
    export ROLE=server
    docker compose up -d --build
    ;;
esac

if [ "$WITH_MOCK_LAN" -eq 1 ]; then
  echo "==> waiting for snmpsim to answer"
  for _ in $(seq 1 30); do
    if $COMPOSE exec -T netshoot snmpget -v2c -c public -t 1 -r 0 \
        snmpsim 1.3.6.1.2.1.1.5.0 >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  if [ -z "${ready:-}" ]; then
    echo "warning: snmpsim not answering yet -- check: $COMPOSE logs snmpsim" >&2
  fi
  cat <<EOF

Mock-LAN devices are on pingsvc's own network now -- add an Infrastructure
Target at address "snmpsim" (community "public") to see discovery find
device1/2/3 (172.28.0.11/.12/.13).

Discovery only runs if pingsvc's backend connection is configured
(ARGUS_BACKEND_URL/ARGUS_PINGSVC_SYNC_TOKEN in .env) -- see
development.md#exercising-device-discovery-with-the-mock-lan-fixture for
the full walkthrough.
EOF
fi
