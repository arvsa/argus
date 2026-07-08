# Backend Lifespan Role Split

## 1. Problem

The FastAPI backend is meant to run in one of two roles from the same codebase — a
zone's local `argus-client` (pingsvc + backend + dashboard, real-time WS to local
devices) or the central `argus-server` (pulls signed snapshots from object storage,
no local devices, no local pingsvc) — per
[dynamic-hierarchy-multi-zone-architecture.md §8](dynamic-hierarchy-multi-zone-architecture.md):
"Images — client is config, not a separate build... selected by a `ROLE=client|server`
env var." That env var was never actually added; today the two roles are not really
separated in code.

Confirmed while investigating a deployment question (argus-server on a host with no
local Redis):

- `get_lifespan_or_none()` ([backend/app/main.py:30-31](../backend/app/main.py#L30-L31))
  gates the *entire* startup/shutdown lifespan — Redis client creation, the 30s Redis
  ping-retry loop, `redis_listener_task`, **and** `ingestion_task` — on
  `settings.REDIS_URL is not None`. `REDIS_URL` defaults to
  `"redis://redis:6379/0"` ([config.py:58](../backend/app/core/config.py#L58)), a
  non-`Optional` `str`, so in practice this is never `None` and the full lifespan
  always runs, regardless of role.
- `ingestion_task` itself has no Redis dependency at all — it only reads
  `settings.S3_BUCKET`, no-ops if unset
  ([ingestion.py:198-200](../backend/app/core/ingestion.py#L198-L200)), and otherwise
  polls S3 + writes MySQL via SQLModel. `S3_BUCKET` is the only thing that should
  matter for "am I ingesting," and today it's fully decoupled from whether the
  lifespan runs at all.
- Three REST routes call `get_sync_redis_client()` directly —
  `/stats`, `/state`, `/state_scan`
  ([pings.py:51](../backend/app/api/routes/pings.py#L51),
  [:63](../backend/app/api/routes/pings.py#L63),
  [:100](../backend/app/api/routes/pings.py#L100)) — and raise `RuntimeError` if the
  client was never initialized ([redis.py:33-36](../backend/app/core/redis.py#L33-L36)).
  `/ws/pings` itself only touches the `Broadcaster`, not Redis directly
  ([pings.py:33-45](../backend/app/api/routes/pings.py#L33-L45)), but it's meaningless
  without `redis_listener_task` feeding the broadcaster.
- Net effect: a "central-only, no local zone" argus-server deployment cannot simply
  omit Redis today — the app either needs a real (unused) Redis instance just to get
  `ingestion_task` to start, or it needs this split.

## 2. Goal

Make Redis/WS startup and `ingestion_task` startup fully independent, and make role
explicit via config rather than incidental on `REDIS_URL` having a non-empty default.
After this change:

- A central argus-server can run with **no Redis at all** and still ingest.
- A zone's argus-client keeps today's behavior exactly (default role) — no change to
  the common case.
- Routes that are meaningless on a Redis-less server (`/ws/pings`, `/stats`,
  `/state`, `/state_scan`) aren't mounted there at all (404, not a 500 crash).

## 3. Design

### 3.1 Explicit `ROLE` setting

Add to `backend/app/core/config.py`, next to `S3_BUCKET`:

```python
ROLE: Literal["client", "server"] = "client"
```

Default `"client"` preserves current behavior for every existing deployment
(single-stack and zone) with zero config changes required. This mirrors the
`-role` flag already planned for pingsvc in §4.3 of the multi-zone doc, so `ROLE`
means the same thing on both sides of the stack.

### 3.2 Split `lifespan()` in `backend/app/main.py`

Replace the single Redis-gated lifespan with two independent pieces composed in one
`lifespan()`:

- **Ping-pipeline block** (Redis clients, the ping-retry loop, `redis_listener_task`)
  — runs only when `settings.ROLE == "client"`. Wrapped so nothing under it executes
  when `ROLE == "server"`.
- **Ingestion block** (`ingestion_task`) — always started unconditionally in
  `lifespan()` regardless of `ROLE`; it already self-no-ops on missing `S3_BUCKET`
  ([ingestion.py:198-200](../backend/app/core/ingestion.py#L198-L200)), so this needs
  no new guard, just removal of the incidental Redis dependency.
- `get_lifespan_or_none()` goes away — `lifespan` always runs now (ingestion needs to
  start even with no Redis configured at all), so `app = FastAPI(..., lifespan=lifespan)`
  directly.

### 3.3 Conditional route registration

In `backend/app/api/main.py`, mount `pings.router` only when `settings.ROLE ==
"client"`, mirroring the existing `ENVIRONMENT == "local"` pattern for `private.router`
([api/main.py:24-25](../backend/app/api/main.py#L24-L25)):

```python
if settings.ROLE == "client":
    api_router.include_router(pings.router)
```

A central argus-server then returns 404 for `/ws/pings`, `/stats`, `/state`,
`/state_scan` instead of crashing with `RuntimeError` — the routes simply don't
exist on that instance, which matches "argus-server... has no route into any zone"
from the architecture doc's terminology table.

### 3.4 Docker Compose

`ROLE=server` is the config knob that eventually backs `compose.server.yml` from
§8 of the multi-zone doc; no compose file changes are required by this plan itself
(no `compose.server.yml` exists yet), but the env var name is chosen now so that
work doesn't need to rename anything later.

## 4. Phased Rollout (TDD, per CLAUDE.md)

One branch, since this is a single cohesive refactor (not several independent
features):

`fix/backend-lifespan-role-split`

1. **RED**: add a test asserting `ingestion_task` starts and runs (mocked S3 client)
   with `REDIS_URL` unset/`ROLE=server` and no Redis reachable — should fail against
   current code (lifespan never runs without reachable Redis).
2. **RED**: add a test asserting `GET /ws/pings`, `/stats`, `/state`, `/state_scan`
   return 404 when `ROLE=server`.
3. **RED**: add/keep a regression test that `ROLE=client` (default) behavior is
   byte-for-byte unchanged — Redis clients created, `redis_listener_task` running,
   ping routes mounted, ingestion still no-ops without `S3_BUCKET`.
4. Implement: `ROLE` setting → split `lifespan()` → conditional `pings.router`
   inclusion.
5. **GREEN**: run `./scripts/test.sh`, full suite.
6. Stop, show diff, wait for review before commit (per Feature Branch Workflow).

## 5. Open Questions / Risks

- **Health/readiness checks**: if anything external (compose healthcheck, k8s probe)
  currently assumes `/stats` or similar exists on every backend instance, it needs to
  target a role-agnostic endpoint instead once `ROLE=server` stops mounting `pings.router`.
- **`REDIS_URL` still has a non-`Optional` default**: leaving it as-is is fine post-split
  since `ROLE` (not `REDIS_URL`'s nullability) becomes the actual gate — but worth a
  short code comment at the setting so a future reader doesn't reintroduce the same
  "default masks the real gate" confusion this plan started from.
- **No `compose.server.yml` yet**: this plan only adds the `ROLE` env var and the code
  branches; wiring an actual Redis-less compose/deploy target for argus-server is
  follow-up scope from §8 of the multi-zone doc, not part of this change.

## 6. Key File Touch Points

| Area | Files |
|---|---|
| Config | `backend/app/core/config.py` (new `ROLE` setting) |
| Lifespan | `backend/app/main.py` (`lifespan`, `get_lifespan_or_none` removal) |
| Route registration | `backend/app/api/main.py` (conditional `pings.router` include) |
| Tests | `backend/app/tests/` — new lifespan/role tests (mirror existing test layout) |
