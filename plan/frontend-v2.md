# Argus Web Frontend v2 — Product Plan & Implementation Plan

## Context

The previous frontend was deleted (see `plan/frontend-dashboard-v1.md` and
the PRs retiring it) — it was built entirely on the fixed
`Campus → Building → Room → Device` hierarchy, which has since been
retired in favor of the generalized, arbitrary-depth `NodeType`/`Node`
model (`plan/dynamic-hierarchy-multi-zone-architecture.md`). This document
is the product/design/implementation plan for a new frontend, built from
scratch against the current backend.

A backend capabilities audit (cross-checked directly against
`backend/app/core/redis.py`, `backend/app/api/routes/{pings,nodes}.py`,
`backend/app/models.py`) surfaced three small, real API gaps that would
otherwise block good frontend features. These are fixed first, as
**Phase 0**, rather than building a frontend that quietly works around
them.

This is a large effort, implemented phase-by-phase — mirroring the
dynamic-hierarchy epic's delivery pattern: each phase split into TDD
sub-steps, each sub-step its own feature branch + PR, reviewed and merged
before the next begins.

## Product description

Argus Dashboard is the operator-facing web UI for Argus. It gives network
operators a single place to log in, browse their organization's asset
hierarchy (an arbitrary-depth, admin-configurable tree — e.g.
`Region → Site → Rack` or `Campus → Building → Room`, no longer a fixed
shape), see live and historical ping status for monitored devices, and —
where the deployment is a multi-zone `argus-server` — check remote zone
health. A superuser role manages user accounts. The frontend is scoped to
what the backend can actually support and degrades **visibly and
honestly** (a labeled empty state, not a silent gap or a fake spinner)
wherever backend capability runs out.

## Key product/backend findings driving scope

- **`NodeType` defines rank levels per tenant** (a linear chain, e.g.
  `Region(0) → Site(1) → Rack(2)`, configured via `hierarchy.yaml`);
  `Node` instances branch into an actual tree via `parent_id`. The UI
  cannot hardcode level count or names — it must fetch `NodeType` rows
  sorted by `rank` and render `Node` as a recursive, arbitrary-depth tree.
- **No `Node` ↔ device/IP link exists at all.** `Node` has only `name`,
  `node_type_id`, `parent_id`, `path_ids`. pingsvc's target file (real
  ICMP targets) is a wholly separate flat file. **"Click a node, see its
  device's live ping status" cannot be built today** — out of scope for
  v1; it needs real backend data-model work later.
- **`admission_status` exists on `User` but isn't exposed on
  `UserPublic`**, and isn't enforced anywhere (login only checks
  `is_active`; self-signup sets `is_active=True` regardless of admission
  status). v1 exposes/manages the field for record-keeping; it does
  **not** enforce it at login — that's a separate, deliberate
  security/product decision for later.
- **The WebSocket only ever delivers hierarchy-less fallback events.**
  `redis_listener_task` (`backend/app/core/redis.py`) does a plain
  `pubsub.subscribe(settings.REDIS_CHANNEL)` (`"pings:events"` only) —
  never `events:node:<id>`, which is where pingsvc's Lua script actually
  publishes for any ping target wired into the hierarchy. Fixed in
  Phase 0b.
- **`GET /nodes/` takes only `skip`/`limit`** (`backend/app/api/routes/
  nodes.py`) — no `parent_id` or `tenant_id` filter, so a tree UI would
  have to fetch every node in the database today. Fixed in Phase 0c.
- **`/ws/pings` has no auth** and actually resolves at
  `/api/v1/ws/pings` (the router's own comment claiming a bare
  `/ws/pings` path is stale — `api_router` is mounted with the
  `/api/v1` prefix in `backend/app/main.py`). Documented as a known gap,
  not fixed in v1 — WS auth is a bigger design question (token-in-query-
  string leakage, etc.), not a "cheap" Phase 0 item.
- **Zones (`GET /zones/summary`) is dormant unless `S3_BUCKET` is
  configured** — a plain single-zone deployment always returns an empty
  list. This must render as a labeled "not configured for this
  deployment" state, never an error or infinite spinner.
- No notification/alerting system exists anywhere (zone staleness is
  logged server-side only) — out of scope for v1.

## Phase 0 — backend fixes (do first, 3 small PRs)

1. **0a — Expose `admission_status` on `UserPublic`.** One field addition
   in `backend/app/models.py`. Test: `GET /users/me` response includes it.
2. **0b — WS delivers per-node events.** `redis_listener_task`
   additionally `psubscribe`s `events:node:*`; `Broadcaster.broadcast`
   (`backend/app/core/broadcast.py`) changes from raw passthrough to
   `{"channel": "<matched-channel>", "data": <payload>}` so the frontend
   can tell which node a message is scoped to (the node id lives in the
   channel name, not the payload body). Test: integration test publishing
   to `events:node:<id>` on Redis, asserting a connected `/ws/pings`
   client receives the enveloped message.
3. **0c — Query filters on list endpoints.** `GET /nodes/?parent_id=<uuid|null>`
   and `GET /nodes/?tenant_id=<str>` (joins through `NodeType`, since
   `tenant_id` isn't directly on `Node`); mirror the `tenant_id` filter on
   `GET /node-types/`.

Each is its own branch/PR, TDD (RED → GREEN), per `CLAUDE.md`'s workflow.

## Feature list for v1

**Must-have:**
1. Login, logout, session persistence.
2. Self-registration + forgot/reset password.
3. Profile: view/edit own info, change password.
4. NodeType admin (list/create-append/rename/delete rank levels) + Node
   tree (recursive, lazy-loaded per-expand via Phase 0c's `parent_id`
   filter) with create/rename/delete, respecting the API's own
   rename-only update constraint (form fields for type/parent are
   disabled on edit, not just validated).
5. Global stats tile (`GET /stats`, public).
6. Paginated device-state table (`GET /state`).
7. Zone health view (`GET /zones/summary`) with a real "not configured"
   empty state, distinct from loading/error.
8. User administration: list/create/edit (incl. new `admission_status`
   field)/delete, superuser-gated.

**Nice-to-have (time-permitting, not launch blockers):**
9. Best-effort live feed panel off the raw `/ws/pings` firehose, clearly
   labeled as unscoped/best-effort.
10. Per-node aggregate live up/down badges in the tree (needs Phase 0b) —
    falls back to static/poll-only if unavailable.
11. `GET /state_scan` as an alternate/fallback device view.

**Explicitly deferred past v1:** admission-status login enforcement,
notifications/alerting, node ↔ device linkage, CSV bulk import (no
surviving backend route), WS auth.

## Tech stack & architecture

- **React + Vite + TS + Tailwind** — matches the prior frontend's
  vocabulary; no reason to switch for an internal-tool-shaped SPA behind
  a login wall (no SSR/Next.js needed).
- **TanStack Query (React Query)** for data fetching — a good fit for
  tree lazy-loading (`useQuery(['nodes', parentId])`), mutate-then-
  invalidate flows (user/node CRUD), and interval polling (`/stats`,
  `/zones/summary`).
- **Zustand** for `auth` and `toast` stores only. WebSocket state is
  *not* a separate parallel store — a `useLiveFeed`/`useWsIndicator` hook
  pushes into React Query's cache (`queryClient.setQueryData`) so
  "device state" has one source of truth regardless of whether it
  arrived via poll or WS.
- **zod** for form validation.

### Navigation

```
/login  /register  /forgot-password  /reset-password   (AuthLayout)
/                    → Dashboard (stats tile, tree entry point, live feed)
/hierarchy           → Node tree (recursive, expand-in-place)
/hierarchy/types     → NodeType admin — superuser only
/devices             → paginated device-state table
/zones               → zone health view (with not-configured empty state)
/profile             → self-service profile + password change
/admin/users         → user list/create/edit/approve — superuser only
```

`AppShell` (top nav + `WsIndicator` + `Toaster` mount) wraps everything
past `RequireAuth`; a new `RequireSuperuser` gate wraps `/hierarchy/types`
and `/admin/users`.

### Components — reused vs new

**Reused as-is (same concept/shape as the deleted frontend):**
`PageHeader`, `StatCard`, `StatusBadge`, `Toaster`, `ConfirmDialog`,
`SlideOver` (create/edit forms), `WsIndicator`, `Spinner`, `ErrorState`.

**New, required for the arbitrary-depth model:**
- `NodeTree` — recursive, depth-agnostic, lazy-loads children via
  `GET /nodes/?parent_id=`.
- `NodeBreadcrumb` — built from `Node.path_ids` (already denormalized
  root-first by the backend), replaces the old fixed-depth
  `HierarchyBreadcrumb`.
- `NodeTypeChainEditor` — tenant's rank-chain list UI; visibly disables
  "insert in the middle" since the API only allows appending.
- `NodeStatusBadge` — renders an aggregate count (`"12 up / 2 down"`),
  distinct from `StatusBadge`'s binary dot, since a `Node` maps to a
  subtree count, never a single device.
- `ZoneEmptyState` — dedicated "zone tracking not configured" state,
  shown whenever `GET /zones/summary` returns `[]` (not a 4xx/5xx).
- `AdmissionBadge` / `PendingStatusFilter` — surfaces the new
  `admission_status` field in the admin Users table.

**Dropped, not replaced:** `CsvUploader` (no backend route survives for
bulk device import against the new model).

## Phased implementation plan

| Phase | Scope |
|---|---|
| 0 | Backend fixes (0a/0b/0c above) |
| 1 | Frontend scaffold + auth |
| 2 | NodeType/Node tree |
| 3 | Device/ping status views |
| 4 | Zone health view |
| 5 | User admin |

- **1a** Vite+TS+Tailwind scaffold: `AppShell`/`AuthLayout`/`RequireAuth`,
  React Query provider, Zustand `auth`/`toast` stores, `api/client.ts`
  (JWT header injection + 401→logout interceptor).
- **1b** Login/Register/ForgotPassword/ResetPassword pages.
- **1c** Profile page.
- **2a** `NodeTypeChainEditor` (list/create-append/rename/delete).
- **2b** `NodeTree` read-only (root fetch + lazy expand) + `NodeBreadcrumb`.
- **2c** Node CRUD (create/rename/delete) via `SlideOver`/`ConfirmDialog`.
- **3a** `StatCard` dashboard tile polling `GET /stats`.
- **3b** Paginated device table against `GET /state`.
- **3c** `useLiveFeed` hook + best-effort feed panel + real `WsIndicator`.
- **3d** (needs Phase 0b) `NodeStatusBadge` wired into `NodeTree` via the
  `{channel, data}` WS envelope, falling back to poll if no envelope
  arrives.
- **4a** Zone summary page — dedicated test asserting the empty-list case
  renders `ZoneEmptyState`, not `ErrorState`/infinite spinner.
- **5a** User list with `AdmissionBadge`/`PendingStatusFilter`, gated by
  `RequireSuperuser`.
- **5b** Create/edit/delete user forms (incl. `admission_status`).

## Critical files

- `backend/app/models.py` — `UserPublic` (0a); source of truth for
  frontend TS types across all phases
- `backend/app/core/redis.py`, `backend/app/core/broadcast.py` — 0b
- `backend/app/api/routes/nodes.py`, `backend/app/api/routes/node_types.py` — 0c
- `backend/app/api/routes/zones.py` — `ZoneSummaryPublic.is_stale` shape
  driving `ZoneEmptyState`/zone view logic
- `frontend/` (new) — scaffolded fresh in Phase 1, no code carried over
  from the deleted repo (only naming/UX conventions)

## Verification

- Backend Phase 0: each sub-step follows the standard TDD loop
  (`./scripts/test.sh` RED → GREEN).
- Frontend: vitest component tests per page/hook; `npm run build` (tsc
  strict) and `npm run lint` (oxlint) must pass each sub-step; manually
  exercise each page against a running `docker compose` stack before
  opening its PR (login flow, tree expand/collapse, zone empty state on
  a plain dev stack with no `S3_BUCKET` set, live feed connecting via
  `WsIndicator`).
- End-to-end: once Phase 3d lands, verify a real per-node badge updates
  live by pinging a target configured with `node_ids` in
  `pingsvc/targets.txt` and watching the tree update without a manual
  refresh.
