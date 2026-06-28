#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$ROOT"

echo "==> [1/3] Service Health"
bash scripts/test-health.sh

echo ""
echo "==> [2/3] Device Connection Events"
bash scripts/test-events.sh

echo ""
echo "==> [3/3] User Authentication"
bash scripts/test-auth.sh

echo ""
echo "==> [Coverage Report]"
docker compose exec -T backend bash -c "
    cd /app/backend &&
    coverage run -m pytest tests/ -q --tb=no &&
    echo '' &&
    coverage report
"

echo ""
echo "All suites passed."
