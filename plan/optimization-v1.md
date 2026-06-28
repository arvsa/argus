# Optimization Plan

**Version**: 1.0  
**Date**: 2026-06-28  
**Status**: Draft

---

## Issues

### P0 — Bugs (broken behavior)

#### 1. `/state` endpoint always returns empty
**File**: `backend/app/api/routes/pings.py:28`  
**Problem**: Reads from Redis sorted set `pings:index` which `pingsvc` never writes to. Only `pings:state` (hash) is written by the Go service.  
**Fix**: Add `ZADD pings:index <ts> <addr>` to the Lua script in `pingsvc/cmd/pingsvc/main.go` inside `publishIfChangedAndAggregateScript`, so both keys are kept in sync. Alternatively, rewrite `/state` to use `HSCAN` like `/state_scan` already does.  
**Recommended approach**: Update the Lua script — it keeps pagination ordered by timestamp and avoids duplicating scan logic.

#### 2. `UserUpdate.addimission_status` typo silently drops updates
**File**: `backend/app/models.py:39`  
**Problem**: Field is named `addimission_status` (extra `i`). The DB column is `admission_status`. Any `PUT /users/{id}` call with an admission status change silently does nothing because the field name never matches the DB column.  
**Fix**: Rename `addimission_status` → `admission_status`.

---

### P1 — Crash risk

#### 3. Stray `mypy` import in `models.py`
**File**: `backend/app/models.py:1`  
**Problem**: `from mypy.build import build` — unused import of `mypy`, which is a dev-only dependency (under `[dependency-groups] dev`). This will raise an `ImportError` in any environment where `mypy` is not installed (staging, production Docker image).  
**Fix**: Delete the line.

---

### P2 — Data integrity

#### 4. `members:room:<id>` Redis key leaks stale IPs
**File**: `backend/app/api/routes/devices.py:78-80`  
**Problem**: On device create, the device's IP is added to `members:room:<room_id>` in Redis via `SADD`. On device update (room change or IP change) and device delete, the old IP is never removed. The set grows stale indefinitely and will contain IPs that no longer belong to the room.  
**Fix**: In the `update_device` route, `SREM` the old IP from the old room set and `SADD` the new IP to the new room set. In `delete_device`, `SREM` the IP from its room set.

---

### P3 — Correctness (API responses)

#### 5. `RoomPublic` and `CampusPublic` omit `name`
**File**: `backend/app/models.py:175, 207`  
**Problem**: Both schemas return only `id` and `created_at`. The `name` field from `RoomBase`/`CampusBase` is not included, so any API consumer getting a room or campus back has no human-readable identifier.  
**Fix**: Inherit from `RoomBase` / `CampusBase` respectively (same pattern used by `BuildingPublic`).

---

### P4 — Dead code

#### 6. Identical branches in `read_devices`
**File**: `backend/app/api/routes/devices.py:24-43`  
**Problem**: The `if current_user.is_superuser / else` block runs the exact same query in both branches.  
**Fix**: Remove the branch entirely; keep one copy of the query.

#### 7. `jsonAddr` function unused in `pingsvc`
**File**: `pingsvc/cmd/pingsvc/main.go:482`  
**Problem**: Function is defined but never called. Will cause a `go vet` or linter warning.  
**Fix**: Delete the function.

---

## Execution Order

| Step | Issue | File(s) |
|------|-------|---------|
| 1 | Delete stray `mypy` import | `backend/app/models.py:1` |
| 2 | Fix `addimission_status` typo | `backend/app/models.py:39` |
| 3 | Fix `RoomPublic` / `CampusPublic` missing `name` | `backend/app/models.py:175, 207` |
| 4 | Remove dead branch in `read_devices` | `backend/app/api/routes/devices.py:24-43` |
| 5 | Fix Redis key leak on device update/delete | `backend/app/api/routes/devices.py:84-123` |
| 6 | Fix `/state` endpoint (update Lua script) | `pingsvc/cmd/pingsvc/main.go`, `backend/app/api/routes/pings.py` |
| 7 | Remove unused `jsonAddr` | `pingsvc/cmd/pingsvc/main.go:482` |

Steps 1–4 are safe, isolated one-liners. Step 5 requires care around transaction ordering. Step 6 is the most involved — the Lua script change must be tested against a live Redis instance.
