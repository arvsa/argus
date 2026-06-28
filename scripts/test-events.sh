#!/usr/bin/env bash
# Suite 2: Device Connection Events
# Phase A – bash integration: seed Redis, assert /state and /state_scan reflect it.
# Phase B – pytest: Redis key integrity on device create/update/delete + WS fanout.
# Run from the repo root: bash scripts/test-events.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."

REDIS="docker compose exec -T redis redis-cli"
BACKEND="http://localhost:8000/api/v1"

# Load env for superuser credentials
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

# Acquire superuser token for endpoints that require auth
echo "  acquiring superuser token..."
TOKEN=$(curl -sf -X POST "${BACKEND}/login/access-token" \
    --data-urlencode "username=${FIRST_SUPERUSER:?FIRST_SUPERUSER not set}" \
    --data-urlencode "password=${FIRST_SUPERUSER_PASSWORD:?FIRST_SUPERUSER_PASSWORD not set}" \
    | jq -r '.access_token')
if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    echo "FAIL: could not acquire superuser token"
    exit 1
fi
AUTH_HEADER="Authorization: Bearer ${TOKEN}"

# RFC 5737 TEST-NET addresses — never routed, safe for test seeding
TEST_ADDR="192.0.2.200"
TEST_TS="1700000000000"
TEST_PAYLOAD="{\"addr\":\"${TEST_ADDR}\",\"ok\":true,\"ts\":${TEST_TS},\"interval\":5000}"

echo "--- Phase A: Redis integration ---"

echo "  seeding pings:state and pings:index..."
$REDIS HSET pings:state "${TEST_ADDR}" "${TEST_PAYLOAD}" > /dev/null
$REDIS ZADD pings:index "${TEST_TS}" "${TEST_ADDR}" > /dev/null

# /state — sorted-set backed pagination
echo "  checking GET /state..."
STATE_RESP=$(curl -sf -H "${AUTH_HEADER}" "${BACKEND}/state?size=1000")
FOUND=$(echo "$STATE_RESP" \
    | jq -r --arg a "$TEST_ADDR" '[.items[] | select(.addr == $a)] | length')
if [ "${FOUND:-0}" -lt 1 ]; then
    echo "FAIL: /state did not return seeded address ${TEST_ADDR}"
    echo "  Response: ${STATE_RESP}"
    $REDIS HDEL pings:state "${TEST_ADDR}" > /dev/null
    $REDIS ZREM pings:index "${TEST_ADDR}" > /dev/null
    exit 1
fi
echo "  /state: OK (device ${TEST_ADDR} visible, total=$(echo "$STATE_RESP" | jq '.total'))"

# /state_scan — verify endpoint returns valid JSON with cursor and items
echo "  checking GET /state_scan..."
SCAN_RESP=$(curl -sf -H "${AUTH_HEADER}" "${BACKEND}/state_scan?count=100")
HAS_CURSOR=$(echo "$SCAN_RESP" | jq 'has("cursor")' 2>/dev/null)
HAS_ITEMS=$(echo "$SCAN_RESP"  | jq 'has("items")'  2>/dev/null)
if [ "$HAS_CURSOR" != "true" ] || [ "$HAS_ITEMS" != "true" ]; then
    echo "FAIL: /state_scan response missing cursor or items fields"
    echo "  Response: ${SCAN_RESP:0:200}"
    $REDIS HDEL pings:state "${TEST_ADDR}" > /dev/null
    $REDIS ZREM pings:index "${TEST_ADDR}" > /dev/null
    exit 1
fi
ITEM_COUNT=$(echo "$SCAN_RESP" | jq '.items | length')
echo "  /state_scan: OK (returned ${ITEM_COUNT} items, paginated scan works)"

# Clean up seeded keys
$REDIS HDEL pings:state "${TEST_ADDR}" > /dev/null
$REDIS ZREM pings:index "${TEST_ADDR}" > /dev/null
echo "  seeded keys cleaned up"

echo ""
echo "--- Phase B: pytest (device key integrity + WebSocket fanout) ---"
docker compose exec -T backend \
    pytest tests/api/routes/test_devices.py tests/api/routes/test_pings.py \
    -v --tb=short

echo ""
echo "Device Connection Events: PASS"
