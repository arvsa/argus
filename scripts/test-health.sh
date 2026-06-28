#!/usr/bin/env bash
# Suite 1: Service Health
# Verifies all Docker Compose services are up and reachable.
# Run from the repo root: bash scripts/test-health.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."

# Load env vars from .env (handles spaces around = and quoted values)
if [ -f .env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        # skip blanks and comments
        [[ "$line" =~ ^[[:space:]]*$ ]] && continue
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        # strip leading/trailing spaces and inline spaces around =
        key="${line%%=*}"; key="${key// /}"
        val="${line#*=}";  val="${val#"${val%%[! ]*}"}"; val="${val%"${val##*[! ]}"}"
        # strip surrounding quotes
        val="${val#\"}"; val="${val%\"}"; val="${val#\'}"; val="${val%\'}"
        [ -n "$key" ] && export "$key=$val"
    done < .env
fi

echo "  bringing stack up..."
# Start only the services needed for testing; the override file references
# a frontend/ directory that does not exist in this repo.
docker compose up -d --quiet-pull db redis prestart backend pingsvc

# Wait for containers that declare healthchecks (db, backend) to become healthy.
# Retry up to 60 s before giving up.
DEADLINE=$(( $(date +%s) + 60 ))
while true; do
    UNHEALTHY=$(docker compose ps --format json 2>/dev/null \
        | jq -r 'if type == "array" then .[] else . end | select(.Health == "unhealthy") | .Name' \
        2>/dev/null || true)
    NOT_RUNNING=$(docker compose ps --format json 2>/dev/null \
        | jq -r 'if type == "array" then .[] else . end | select(.State != "running" and .State != "exited") | .Name' \
        2>/dev/null || true)
    if [ -z "$UNHEALTHY" ] && [ -z "$NOT_RUNNING" ]; then
        break
    fi
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
        echo "FAIL: timed out waiting for services"
        echo "  unhealthy: ${UNHEALTHY:-none}"
        echo "  not running: ${NOT_RUNNING:-none}"
        docker compose ps
        exit 1
    fi
    sleep 2
done

# 1. Backend HTTP health endpoint — retry up to 60 s for the app to finish starting
echo "  checking backend health endpoint..."
DEADLINE=$(( $(date +%s) + 60 ))
while true; do
    HTTP_STATUS=$(curl -so /dev/null -w "%{http_code}" --max-time 5 \
        http://localhost:8000/api/v1/utils/health-check/ 2>/dev/null || echo "000")
    [ "$HTTP_STATUS" = "200" ] && break
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
        echo "FAIL: backend health endpoint returned HTTP $HTTP_STATUS after 60 s"
        docker compose logs --tail=30 backend
        exit 1
    fi
    sleep 3
done
echo "  backend: OK (HTTP 200)"

# 2. Redis PING
echo "  checking redis..."
REDIS_REPLY=$(docker compose exec -T redis redis-cli ping 2>/dev/null | tr -d '\r')
if [ "$REDIS_REPLY" != "PONG" ]; then
    echo "FAIL: redis-cli ping returned '${REDIS_REPLY}' (expected PONG)"
    docker compose logs --tail=20 redis
    exit 1
fi
echo "  redis: OK (PONG)"

# 3. MySQL admin ping
echo "  checking db..."
if ! docker compose exec -T db \
        mysqladmin ping -h localhost -u root -p"${MYSQL_ROOT_PASSWORD:-root}" \
        --silent 2>/dev/null; then
    echo "FAIL: mysqladmin ping failed"
    docker compose logs --tail=20 db
    exit 1
fi
echo "  db: OK"

# 4. pingsvc Prometheus metrics endpoint
echo "  checking pingsvc metrics..."
if ! curl -sf http://localhost:9090/metrics 2>/dev/null | grep -q "^# HELP"; then
    echo "FAIL: pingsvc metrics endpoint not reachable or returned no HELP lines"
    docker compose logs --tail=20 pingsvc
    exit 1
fi
echo "  pingsvc: OK (metrics endpoint responding)"

echo ""
echo "Service Health: PASS"
