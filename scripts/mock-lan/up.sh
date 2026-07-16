#! /usr/bin/env bash

# Bring up the mock-LAN dev/test environment (plan/device-discovery-v1.md
# §2.9): a handful of ICMP-only "device" containers and an snmpsim agent
# serving fixture SNMP data, all on a fixed-subnet bridge network.
#
#   ./scripts/mock-lan/up.sh
#
# Idempotent: re-running just brings any stopped/changed services back up.

set -euo pipefail

cd "$(dirname "$0")/../.."

COMPOSE="docker compose -f compose.mock-lan.yml"

echo "==> building/starting mock-lan"
$COMPOSE up -d --build

echo "==> waiting for snmpsim to answer"
for _ in $(seq 1 30); do
  if $COMPOSE exec -T netshoot snmpget -v2c -c public -t 1 -r 0 \
      172.28.0.21 1.3.6.1.2.1.1.5.0 >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ -z "${ready:-}" ]; then
  echo "warning: snmpsim not answering yet -- check: docker compose -f compose.mock-lan.yml logs snmpsim" >&2
fi

cat <<'EOF'

Mock-LAN environment ready.

  devices:   172.28.0.11 / .12 / .13  (ICMP only, for arpsweep testing)
  snmpsim:   172.28.0.21              (community: public)
  netshoot:  172.28.0.31              (toolbox: ping, snmpwalk, dig)

  smoke test:  ./scripts/mock-lan/smoke-test.sh
  shell in:    docker compose -f compose.mock-lan.yml exec netshoot sh
  logs:        docker compose -f compose.mock-lan.yml logs -f snmpsim
  teardown:    ./scripts/mock-lan/down.sh
EOF
