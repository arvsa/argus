#! /usr/bin/env bash

# Tear down the mock-LAN dev/test environment (plan/device-discovery-v1.md
# §2.9), removing containers, network, and volumes.
#
#   ./scripts/mock-lan/down.sh

set -euo pipefail

cd "$(dirname "$0")/../.."

# See up.sh's comment -- compose.mock-lan.yml no longer pins its own
# project name, so this script states its standalone identity explicitly.
export COMPOSE_PROJECT_NAME=argus-mock-lan
docker compose -f compose.mock-lan.yml --profile mock-lan down -v --remove-orphans
