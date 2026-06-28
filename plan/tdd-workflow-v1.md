# TDD Development Workflow

**Version**: 1.0  
**Date**: 2026-06-28  
**Status**: Proposed

---

## TDD Loop

Every feature follows this cycle before moving on:

```
1. Write test  →  run suite  →  confirm RED (test fails as expected)
2. Implement feature
3. Run suite  →  confirm GREEN (test passes)
4. Refactor if needed  →  re-run  →  must stay GREEN
5. Move to next feature
```

All three suites must pass before a feature branch is considered shippable.

---

## Dev Loop Entry Point

A single command runs all suites in dependency order:

```bash
./scripts/test-all.sh
```

Create this file as:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "==> [1/3] Service Health"
bash scripts/test-health.sh

echo "==> [2/3] Device Connection Events"
bash scripts/test-events.sh

echo "==> [3/3] User Authentication"
bash scripts/test-auth.sh

echo ""
echo "All suites passed."
```

The three suite scripts are defined below. Each is independently runnable.

---

## Suite 1 — Service Health

### Purpose

Confirm that every Docker Compose service is up and reachable before any feature tests run. This is infrastructure-level pre-flight, not business logic.

### When it runs

- **Dev session start**: always first, before writing any test
- **After any `compose.yml` change**: service config, healthcheck, image version
- **CI**: first job in the pipeline — blocks all downstream jobs on failure

### What to write before implementing (TDD red step)

Before you wire up a new service or healthcheck, write the assertion:

```bash
# e.g., for a new service "minio":
curl -sf http://localhost:9000/minio/health/live
```

Run it. It should fail (exit 1). Then add the service to `compose.yml`, bring it up, and re-run until it passes.

### Bash commands (`scripts/test-health.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail

# Load env for credentials
set -o allexport
source .env
set +o allexport

# 1. Bring the stack up and wait for healthchecks
docker compose up -d --wait --quiet-pull

# 2. Confirm no service is in a non-running state
UNHEALTHY=$(docker compose ps --format json \
  | jq -r '.[] | select(.State != "running") | .Name')
if [ -n "$UNHEALTHY" ]; then
  echo "FAIL: the following services are not running:"
  echo "$UNHEALTHY"
  docker compose ps
  exit 1
fi

# 3. Backend HTTP health endpoint
echo "  checking backend health endpoint..."
curl -sf http://localhost:8000/api/v1/utils/health-check/ > /dev/null
echo "  backend: OK"

# 4. Redis PING
echo "  checking redis..."
docker compose exec -T redis redis-cli ping | grep -q "PONG"
echo "  redis: OK"

# 5. MySQL
echo "  checking db..."
docker compose exec -T db \
  mysqladmin ping -h localhost -u root -p"${MYSQL_ROOT_PASSWORD}" --silent 2>/dev/null
echo "  db: OK"

# 6. pingsvc Prometheus metrics
echo "  checking pingsvc metrics..."
curl -sf http://localhost:9090/metrics | grep -q "^# HELP"
echo "  pingsvc: OK"

echo "Service Health: PASS"
```

### Expected output / exit codes

| Check | Expected stdout | Exit code |
|---|---|---|
| `docker compose up --wait` | Services started | 0 |
| Unhealthy check | (empty — no output) | 0 |
| Backend health endpoint | HTTP 200, body ignored | 0 |
| Redis PING | `PONG` | 0 |
| MySQL ping | (silent) | 0 |
| pingsvc metrics | Line starting `# HELP` | 0 |

Any non-zero exit aborts the script (`set -e`), printing the failed line.

### Failure surfacing

- `set -euo pipefail` stops at the first failure with the line number in stderr
- Follow up with `docker compose logs <service>` for the failing container
- In CI: the job step output shows the exact failing command; downstream jobs are blocked

---

## Suite 2 — Device Connection Events

### Purpose

Verify that the full pipeline from a device state change to a client-visible event works correctly:

```
Redis state write → /state endpoint → pings:index sorted set
Redis PUBLISH     → backend subscriber → WebSocket broadcast
```

Because pingsvc does real ICMP (cannot run in test environments), the strategy is to inject events directly into Redis and assert the backend responds correctly. This tests everything in the pipeline except the ping itself.

### When it runs

- After any change to: `pingsvc/cmd/pingsvc/main.go` (Lua script), `backend/app/api/routes/pings.py`, `backend/app/core/broadcast.py`, `backend/app/core/redis.py`
- After any change to the `Device` model or device routes (create/update/delete affects `members:room`)
- After any Redis key schema change

### What to write before implementing (TDD red step)

Write a pytest test stub that asserts the behaviour you want, then run it and confirm it fails. Example for the `/state` fix from `optimization-v1.md`:

```python
# tests/api/routes/test_pings.py
def test_state_returns_seeded_device(redis_client):
    redis_client.hset("pings:state", "10.0.0.1", '{"addr":"10.0.0.1","ok":true}')
    redis_client.zadd("pings:index", {10.0.0.1: 1700000000000})
    r = client.get("/state")
    assert r.status_code == 200
    addrs = [i["addr"] for i in r.json()["items"]]
    assert "10.0.0.1" in addrs
```

Run it — it should fail while the index is empty. Implement the fix (already done in `optimization-v1.md`), re-run until green.

### Bash commands (`scripts/test-events.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail

# Load env
set -o allexport
source .env
set +o allexport

REDIS="docker compose exec -T redis redis-cli"
BACKEND="http://localhost:8000"
TEST_ADDR="10.255.255.1"
TEST_TS=1700000000000
TEST_PAYLOAD="{\"addr\":\"${TEST_ADDR}\",\"ok\":true,\"ts\":${TEST_TS},\"interval\":5000}"

echo "  seeding Redis state..."
$REDIS HSET pings:state "${TEST_ADDR}" "${TEST_PAYLOAD}" > /dev/null
$REDIS ZADD pings:index "${TEST_TS}" "${TEST_ADDR}" > /dev/null

# ---- /state (sorted-set pagination) ----
echo "  checking /state endpoint..."
RESULT=$(curl -sf "${BACKEND}/api/v1/state?size=1000")
FOUND=$(echo "$RESULT" | jq -r --arg addr "$TEST_ADDR" \
  '[.items[] | select(.addr == $addr)] | length')
if [ "$FOUND" -lt 1 ]; then
  echo "FAIL: /state did not return seeded device ${TEST_ADDR}"
  echo "  Response: $RESULT"
  exit 1
fi
echo "  /state: OK (device visible)"

# ---- /state_scan (HSCAN cursor) ----
echo "  checking /state_scan endpoint..."
RESULT=$(curl -sf "${BACKEND}/api/v1/state_scan?count=1000")
FOUND=$(echo "$RESULT" | jq -r --arg addr "$TEST_ADDR" \
  '[.items[] | select(.addr == $addr)] | length')
if [ "$FOUND" -lt 1 ]; then
  echo "FAIL: /state_scan did not return seeded device ${TEST_ADDR}"
  echo "  Response: $RESULT"
  exit 1
fi
echo "  /state_scan: OK (device visible)"

# ---- WebSocket fanout ----
# Requires: pip install websocket-client  (or: apk add websocat inside container)
echo "  checking WebSocket fanout..."
WS_RECEIVED=$(docker compose exec -T backend \
  python3 - <<'EOF'
import asyncio, json, sys
import websockets

async def check():
    uri = "ws://localhost:8000/ws/pings"
    async with websockets.connect(uri) as ws:
        import redis as r
        rc = r.Redis(host="redis", port=6379)
        event = json.dumps({"addr": "10.255.255.2", "ok": False, "ts": 1700000000001})
        rc.publish("pings:events", event)
        try:
            msg = await asyncio.wait_for(ws.recv(), timeout=3)
            data = json.loads(msg)
            if data.get("addr") == "10.255.255.2":
                print("received")
                return
        except asyncio.TimeoutError:
            pass
    print("timeout")

asyncio.run(check())
EOF
)

if [ "$WS_RECEIVED" != "received" ]; then
  echo "FAIL: WebSocket did not deliver the published event (got: ${WS_RECEIVED})"
  exit 1
fi
echo "  WebSocket fanout: OK"

# ---- members:room key integrity ----
# TDD: write this assertion before implementing create_device Redis cache
echo "  checking members:room key on device create/update/delete..."
docker compose exec -T backend pytest tests/api/routes/test_devices.py -q --tb=short
echo "  members:room: OK"

# Clean up seeded test keys
$REDIS HDEL pings:state "${TEST_ADDR}" > /dev/null
$REDIS ZREM pings:index "${TEST_ADDR}" > /dev/null

echo "Device Connection Events: PASS"
```

### Pytest tests to write first (`tests/api/routes/test_devices.py`)

This file does not exist yet — create it with these stubs **before** implementing the device route changes. Each test should fail on first run.

```python
# tests/api/routes/test_devices.py

import uuid
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.core.config import settings
from tests.utils.utils import get_superuser_token_headers


def _auth(client):
    return get_superuser_token_headers(client)


def test_create_device_adds_to_members_room(client: TestClient, db: Session):
    """members:room:<room_id> must contain the new device IP after create."""
    headers = _auth(client)
    room_id = _seed_room(client, headers)

    r = client.post(f"{settings.API_V1_STR}/devices/", headers=headers, json={
        "name": "sw-test-1", "device_type": "switch",
        "ip_address": "10.1.1.1", "room_id": str(room_id),
    })
    assert r.status_code == 200

    from app.core.redis import get_sync_redis_client
    rc = get_sync_redis_client()
    members = rc.smembers(f"members:room:{room_id}")
    assert b"10.1.1.1" in members


def test_update_device_moves_members_room(client: TestClient, db: Session):
    """Old IP removed from old room set; new IP added to new room set."""
    headers = _auth(client)
    room_a = _seed_room(client, headers)
    room_b = _seed_room(client, headers)

    r = client.post(f"{settings.API_V1_STR}/devices/", headers=headers, json={
        "name": "sw-test-2", "device_type": "switch",
        "ip_address": "10.1.1.2", "room_id": str(room_a),
    })
    device_id = r.json()["id"]

    client.put(f"{settings.API_V1_STR}/devices/{device_id}", headers=headers, json={
        "name": "sw-test-2", "device_type": "switch",
        "ip_address": "10.1.1.2", "room_id": str(room_b),
    })

    from app.core.redis import get_sync_redis_client
    rc = get_sync_redis_client()
    assert b"10.1.1.2" not in rc.smembers(f"members:room:{room_a}")
    assert b"10.1.1.2" in rc.smembers(f"members:room:{room_b}")


def test_delete_device_removes_from_members_room(client: TestClient, db: Session):
    """IP removed from members:room set on delete."""
    headers = _auth(client)
    room_id = _seed_room(client, headers)

    r = client.post(f"{settings.API_V1_STR}/devices/", headers=headers, json={
        "name": "sw-test-3", "device_type": "switch",
        "ip_address": "10.1.1.3", "room_id": str(room_id),
    })
    device_id = r.json()["id"]
    client.delete(f"{settings.API_V1_STR}/devices/{device_id}", headers=headers)

    from app.core.redis import get_sync_redis_client
    rc = get_sync_redis_client()
    assert b"10.1.1.3" not in rc.smembers(f"members:room:{room_id}")


def _seed_room(client, headers) -> uuid.UUID:
    """Helper: create campus → building → room, return room UUID."""
    campus = client.post(f"{settings.API_V1_STR}/campuses/",
                         headers=headers, json={"name": "Test Campus"}).json()
    bldg = client.post(f"{settings.API_V1_STR}/buildings/",
                       headers=headers,
                       json={"name": "Bldg A", "campus_id": campus["id"]}).json()
    room = client.post(f"{settings.API_V1_STR}/rooms/",
                       headers=headers,
                       json={"name": "Room 1", "building_id": bldg["id"]}).json()
    return uuid.UUID(room["id"])
```

### Expected output / exit codes

| Check | Expected | Exit code |
|---|---|---|
| `/state` contains seeded addr | `FOUND >= 1` | 0 |
| `/state_scan` contains seeded addr | `FOUND >= 1` | 0 |
| WebSocket receives published event within 3 s | `received` | 0 |
| `test_devices.py` pytest suite | All tests passed | 0 |

### Failure surfacing

- Bash checks print `FAIL:` with the actual response body before exiting 1
- pytest output is printed inline; `--tb=short` shows the relevant assertion lines
- For WebSocket timeout: check `docker compose logs backend` for subscription errors

---

## Suite 3 — User Authentication

### Purpose

Cover the full authentication lifecycle: token issuance, token use, rejection on bad credentials, token expiry, and the `admission_status` field introduced to gate user access.

### When it runs

- After any change to: `backend/app/api/routes/login.py`, `backend/app/core/security.py`, `backend/app/models.py` (User/UserUpdate), `backend/app/crud.py` (user-related functions)
- After any change to JWT config in `.env` (`SECRET_KEY`, token expiry)

### What to write before implementing (TDD red step)

Before adding a new auth rule (e.g., reject `admission_status == "pending"` users), write the test first:

```python
def test_pending_user_cannot_access_protected_route(client, db):
    # create user with pending status, get token, try protected endpoint
    # should get 403
    ...
```

Run it — confirm it fails (pending users currently get through). Implement the guard. Re-run until green.

### Bash commands (`scripts/test-auth.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail

set -o allexport
source .env
set +o allexport

BACKEND="http://localhost:8000"

echo "  running pytest auth suite inside backend container..."
docker compose exec -T backend \
  pytest tests/api/routes/test_login.py tests/api/routes/test_users.py \
  tests/crud/test_user.py \
  -v --tb=short

# ---- Smoke tests via curl (fast feedback on the live stack) ----

echo "  [smoke] valid login returns a token..."
TOKEN=$(curl -sf -X POST "${BACKEND}/api/v1/login/access-token" \
  --data-urlencode "username=${FIRST_SUPERUSER}" \
  --data-urlencode "password=${FIRST_SUPERUSER_PASSWORD}" \
  | jq -r '.access_token')
[ -n "$TOKEN" ] || { echo "FAIL: no token returned"; exit 1; }
echo "    got token: ${TOKEN:0:20}..."

echo "  [smoke] valid token accepted by /login/test-token..."
STATUS=$(curl -so /dev/null -w "%{http_code}" \
  -X POST "${BACKEND}/api/v1/login/test-token" \
  -H "Authorization: Bearer $TOKEN")
[ "$STATUS" = "200" ] || { echo "FAIL: test-token returned $STATUS"; exit 1; }

echo "  [smoke] wrong password returns 400..."
STATUS=$(curl -so /dev/null -w "%{http_code}" \
  -X POST "${BACKEND}/api/v1/login/access-token" \
  --data-urlencode "username=${FIRST_SUPERUSER}" \
  --data-urlencode "password=definitelywrong")
[ "$STATUS" = "400" ] || { echo "FAIL: bad password returned $STATUS, expected 400"; exit 1; }

echo "  [smoke] missing token on protected endpoint returns 401 or 403..."
STATUS=$(curl -so /dev/null -w "%{http_code}" \
  "${BACKEND}/api/v1/users/")
[ "$STATUS" = "401" ] || [ "$STATUS" = "403" ] || \
  { echo "FAIL: unauthenticated /users/ returned $STATUS, expected 401/403"; exit 1; }

echo "  [smoke] forged token returns 403..."
STATUS=$(curl -so /dev/null -w "%{http_code}" \
  "${BACKEND}/api/v1/users/" \
  -H "Authorization: Bearer not.a.real.token")
[ "$STATUS" = "403" ] || \
  { echo "FAIL: forged token returned $STATUS, expected 403"; exit 1; }

echo "User Authentication: PASS"
```

### Pytest tests to add (`tests/api/routes/test_login.py`)

The following cases are not yet covered. Write them before implementing the related feature.

```python
def test_no_token_returns_401(client: TestClient):
    """Unauthenticated request to a protected endpoint must return 401."""
    r = client.get(f"{settings.API_V1_STR}/users/")
    assert r.status_code in (401, 403)


def test_forged_token_returns_403(client: TestClient):
    """A syntactically valid but unsigned JWT must be rejected."""
    r = client.get(
        f"{settings.API_V1_STR}/users/",
        headers={"Authorization": "Bearer not.a.real.token"},
    )
    assert r.status_code == 403


def test_non_superuser_cannot_list_users(
    client: TestClient, normal_user_token_headers: dict[str, str]
):
    """Only superusers may list all users."""
    r = client.get(f"{settings.API_V1_STR}/users/", headers=normal_user_token_headers)
    assert r.status_code == 403


def test_admission_status_round_trip(
    client: TestClient, superuser_token_headers: dict[str, str], db: Session
):
    """PUT /users/{id} with admission_status must persist the value."""
    from tests.utils.utils import random_email, random_lower_string
    from app.crud import create_user
    from app.models import UserCreate

    user = create_user(
        session=db,
        user_create=UserCreate(
            email=random_email(),
            password=random_lower_string(),
            full_name="Pending User",
        ),
    )
    # Default should be "pending"
    assert user.admission_status == "pending"

    r = client.patch(
        f"{settings.API_V1_STR}/users/{user.id}",
        headers=superuser_token_headers,
        json={"admission_status": "approved"},
    )
    assert r.status_code == 200

    db.refresh(user)
    assert user.admission_status == "approved"
```

### Expected output / exit codes

| Check | Expected | Exit code |
|---|---|---|
| Full pytest suite | `X passed` (no failures) | 0 |
| Valid login smoke test | HTTP 200, `access_token` non-empty | 0 |
| Token accepted by test-token | HTTP 200 | 0 |
| Wrong password | HTTP 400 | 0 |
| No token on protected route | HTTP 401 or 403 | 0 |
| Forged token | HTTP 403 | 0 |

### Failure surfacing

- pytest prints the failing test name and assertion diff inline
- curl smoke tests print `FAIL: <description>` with actual vs expected status code before exiting 1
- Both are captured by CI logs; either is enough to identify which auth rule is broken

---

## CI Integration

Map each suite to a CI step so failures block the pipeline at the earliest possible stage:

```yaml
# .github/workflows/test.yml (illustrative)
jobs:
  health:
    steps:
      - run: bash scripts/test-health.sh

  events:
    needs: health
    steps:
      - run: bash scripts/test-events.sh

  auth:
    needs: health
    steps:
      - run: bash scripts/test-auth.sh
```

`events` and `auth` both depend on `health` but are independent of each other, so they run in parallel once the stack is confirmed healthy. A failure in `health` blocks both.

---

## Quick Reference

| Command | What it does |
|---|---|
| `bash scripts/test-all.sh` | Run all three suites in order |
| `bash scripts/test-health.sh` | Service health pre-flight only |
| `bash scripts/test-events.sh` | Device events + Redis pipeline |
| `bash scripts/test-auth.sh` | Auth pytest + curl smoke |
| `docker compose exec -T backend pytest tests/ -v` | Full pytest suite inside container |
| `docker compose exec -T backend pytest tests/api/routes/test_login.py -v` | Auth tests only |
| `docker compose exec -T backend pytest tests/api/routes/test_devices.py -v` | Device tests only |
