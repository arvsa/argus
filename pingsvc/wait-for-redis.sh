#!/usr/bin/env bash
set -euo pipefail

REDIS_URL="${REDIS_URL:-}"
REDIS_HOST="${REDIS_HOST:-redis}"
REDIS_PORT="${REDIS_PORT:-6379}"
TIMEOUT="${WAIT_TIMEOUT:-30}"

if [ -n "${REDIS_URL}" ]; then
  tmp="${REDIS_URL#redis://}"
  tmp="${tmp#*:*@}"
  hostport="${tmp%%/*}"
  if [[ "${hostport}" == *:* ]]; then
    REDIS_HOST="${hostport%%:*}"
    REDIS_PORT="${hostport##*:}"
  else
    REDIS_HOST="${hostport}"
  fi
fi

echo "Waiting for Redis at ${REDIS_HOST}:${REDIS_PORT} for up to ${TIMEOUT}s..."
start_ts=$(date +%s)
while true; do
  if nc -z "${REDIS_HOST}" "${REDIS_PORT}" >/dev/null 2>&1; then
    echo "Redis reachable"
    break
  fi
  now=$(date +%s)
  elapsed=$((now - start_ts))
  if [ "${elapsed}" -ge "${TIMEOUT}" ]; then
    echo "Timeout waiting for Redis after ${TIMEOUT}s" >&2
    exit 1
  fi
  sleep 1
done

exec "$@"
