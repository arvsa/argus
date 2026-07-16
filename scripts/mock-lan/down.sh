#! /usr/bin/env bash

# Tear down the mock-LAN dev/test environment (plan/device-discovery-v1.md
# §2.9), removing containers, network, and volumes.
#
#   ./scripts/mock-lan/down.sh

set -euo pipefail

cd "$(dirname "$0")/../.."

docker compose -f compose.mock-lan.yml down -v --remove-orphans
