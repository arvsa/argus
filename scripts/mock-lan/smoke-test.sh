#! /usr/bin/env bash

# Proves the mock-LAN environment (plan/device-discovery-v1.md §2.9)
# actually works, standing in for automated tests since there's no Go/
# Python code in this branch to unit-test: ping each device container from
# netshoot, then snmpwalk the snmpsim fixture and confirm its values come
# back. Nonzero exit on any failure.
#
#   ./scripts/mock-lan/smoke-test.sh

set -euo pipefail

cd "$(dirname "$0")/../.."

COMPOSE="docker compose -f compose.mock-lan.yml"
EXEC="$COMPOSE exec -T netshoot"

fail=0

for ip in 172.28.0.11 172.28.0.12 172.28.0.13; do
  echo -n "==> ping $ip ... "
  if $EXEC ping -c 1 -W 2 "$ip" >/dev/null 2>&1; then
    echo "ok"
  else
    echo "FAILED"
    fail=1
  fi
done

echo -n "==> snmpwalk snmpsim (172.28.0.21) sysDescr/sysName ... "
out="$($EXEC snmpwalk -v2c -c public -t 2 -r 1 172.28.0.21 1.3.6.1.2.1.1 2>&1 || true)"
if grep -q "Mock Argus Test Device" <<<"$out" && grep -q "mock-device-01" <<<"$out"; then
  echo "ok"
else
  echo "FAILED"
  echo "$out" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "==> smoke test FAILED" >&2
  exit 1
fi

echo "==> smoke test passed"
