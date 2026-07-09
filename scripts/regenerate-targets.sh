#!/usr/bin/env bash
# Regenerate pingsvc/targets.txt from the backend's Device table (the
# source of truth for device-to-node assignment; see
# plan/device-node-assignment-bridge-v1.md and hierarchy.md) and restart
# pingsvc to pick it up. pingsvc has no hot-reload -- this is a manual/
# scripted step, not a live sync.
#
# Run from the repo root: bash scripts/regenerate-targets.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."

# Load superuser credentials from .env (handles spaces around = and quotes)
if [ -f .env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        [[ "$line" =~ ^[[:space:]]*$ ]] && continue
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        key="${line%%=*}"; key="${key// /}"
        val="${line#*=}";  val="${val#"${val%%[! ]*}"}"; val="${val%"${val##*[! ]}"}"
        val="${val#\"}"; val="${val%\"}"; val="${val#\'}"; val="${val%\'}"
        [ -n "$key" ] && export "$key=$val"
    done < .env
fi

BACKEND="http://localhost:8000/api/v1"

echo "  acquiring superuser token..."
TOKEN=$(curl -sf -X POST "${BACKEND}/login/access-token" \
    --data-urlencode "username=${FIRST_SUPERUSER:?FIRST_SUPERUSER not set}" \
    --data-urlencode "password=${FIRST_SUPERUSER_PASSWORD:?FIRST_SUPERUSER_PASSWORD not set}" \
    | jq -r '.access_token')
if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    echo "FAIL: could not acquire superuser token"
    exit 1
fi

echo "  exporting devices to pingsvc/targets.txt..."
curl -sf "${BACKEND}/devices/targets-export" -H "Authorization: Bearer ${TOKEN}" \
    -o pingsvc/targets.txt

echo "  restarting pingsvc..."
docker compose up pingsvc -d --force-recreate

echo "Done. $(wc -l < pingsvc/targets.txt) target(s) written."
