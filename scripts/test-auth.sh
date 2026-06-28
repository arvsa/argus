#!/usr/bin/env bash
# Suite 3: User Authentication
# Phase A – pytest: full auth test suite inside the backend container.
# Phase B – curl smoke tests: live stack round-trips for fast feedback.
# Run from the repo root: bash scripts/test-auth.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."

# Load credentials from .env for curl smoke tests (handles spaces around = and quotes)
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

echo "--- Phase A: pytest ---"
docker compose exec -T backend \
    pytest tests/api/routes/test_login.py \
           tests/api/routes/test_users.py \
           tests/crud/test_user.py \
    -v --tb=short

echo ""
echo "--- Phase B: curl smoke tests ---"

# 1. Valid login returns a token
echo "  [smoke] valid login returns a token..."
TOKEN=$(curl -sf -X POST "${BACKEND}/login/access-token" \
    --data-urlencode "username=${FIRST_SUPERUSER:?FIRST_SUPERUSER not set}" \
    --data-urlencode "password=${FIRST_SUPERUSER_PASSWORD:?FIRST_SUPERUSER_PASSWORD not set}" \
    | jq -r '.access_token')
if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    echo "FAIL: login did not return access_token"
    exit 1
fi
echo "    token received: ${TOKEN:0:24}..."

# 2. Valid token accepted by /login/test-token
echo "  [smoke] valid token accepted..."
STATUS=$(curl -so /dev/null -w "%{http_code}" \
    -X POST "${BACKEND}/login/test-token" \
    -H "Authorization: Bearer ${TOKEN}")
if [ "$STATUS" != "200" ]; then
    echo "FAIL: test-token returned HTTP $STATUS (expected 200)"
    exit 1
fi
echo "    test-token: OK (HTTP 200)"

# 3. Wrong password returns 400
echo "  [smoke] wrong password rejected..."
STATUS=$(curl -so /dev/null -w "%{http_code}" \
    -X POST "${BACKEND}/login/access-token" \
    --data-urlencode "username=${FIRST_SUPERUSER}" \
    --data-urlencode "password=definitelywrong_$(date +%s)")
if [ "$STATUS" != "400" ]; then
    echo "FAIL: wrong password returned HTTP $STATUS (expected 400)"
    exit 1
fi
echo "    bad credentials: OK (HTTP 400)"

# 4. Missing token on protected endpoint returns 401 or 403
echo "  [smoke] missing token on protected endpoint..."
STATUS=$(curl -so /dev/null -w "%{http_code}" "${BACKEND}/users/")
if [ "$STATUS" != "401" ] && [ "$STATUS" != "403" ]; then
    echo "FAIL: unauthenticated /users/ returned HTTP $STATUS (expected 401 or 403)"
    exit 1
fi
echo "    no-token: OK (HTTP $STATUS)"

# 5. Forged token returns 403
echo "  [smoke] forged token rejected..."
STATUS=$(curl -so /dev/null -w "%{http_code}" \
    "${BACKEND}/users/" \
    -H "Authorization: Bearer not.a.real.token")
if [ "$STATUS" != "403" ]; then
    echo "FAIL: forged token returned HTTP $STATUS (expected 403)"
    exit 1
fi
echo "    forged token: OK (HTTP 403)"

echo ""
echo "User Authentication: PASS"
