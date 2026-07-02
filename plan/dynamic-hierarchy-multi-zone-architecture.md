# Dynamic Hierarchy & Multi-Zone Client/Server Architecture

## 1. Refined Business Goal

Argus currently assumes exactly one hierarchy shape, hardcoded at every layer: `Campus → Building → Room → Device`. This has two costs:

1. **Rigidity** — the system can't represent a different organization's asset hierarchy (e.g. `Region → Site → Floor → Rack → Device`, or a flat `Site → Device` with no intermediate levels) without a code change at the DB, API, and UI layers.
2. **Reachability** — a single central `pingsvc` instance can only ICMP devices it has a network route to. Devices sitting behind a customer's building-level NAT/firewall are unreachable from a central pinger, with no workaround today.

**Target architecture:** Argus becomes deployable in two roles from the *same* codebase:

- **argus-client** — deployed inside a "zone" (a network-isolated site, e.g. one building). Runs the full local stack (pingsvc + backend + dashboard), pings devices it has local network access to, and periodically pushes an aggregated metrics snapshot to external object storage.
- **argus-server** — a central instance that pulls snapshots from object storage (never talks to clients directly) and renders a unified multi-zone dashboard.

Object storage (S3-compatible) is the only integration surface between client and server, chosen because scoped access control on a bucket/prefix is far simpler to operate than building and securing a custom ingest API. Each zone may define its own hierarchy shape; the server does not force a single taxonomy across zones.

This plan was produced with input from four domain-expert consultations (Go/pingsvc architecture, SQL/data-modeling, cloud security/auth, and network topology), summarized in §3 and fully reflected in the technical plan in §4.

## 2. Terminology

| Term | Meaning |
|---|---|
| **Zone** | A network-isolated site (e.g. one building) where an argus-client runs and can reach local devices directly. |
| **argus-client** | pingsvc + backend + dashboard running inside a zone; writes to local Redis/MySQL, pushes aggregated snapshots outward. |
| **argus-server** | Central instance; reads snapshots from object storage, has no route into any zone. |
| **Node / NodeType** | Generalization of `Campus`/`Building`/`Room` into an arbitrary-depth, admin-configurable hierarchy (§4.1). |

## 3. Expert Input Summary

**Go / pingsvc architecture (golang-pro):** Add a `-role=pingsvc\|exporter\|both` flag to the existing binary rather than forking it — keep the current worker pool/batcher/Lua pipeline untouched, and add an independent `runExporter` goroutine on its own ticker that reads `stats:*`/`pings:state` directly (no shared channels with the ping pipeline, so a slow S3 call can never backpressure ping workers). Export aggregated JSON snapshots, not raw ping events — the existing Redis rollups are already the right shape. On push failure, spool to local disk (not memory) so an outage survives a process restart, with age/size-bounded eviction. No sidecar process — same binary, `role=both` in production zones.

**Data modeling (sql-pro):** Replace the four fixed tables with a self-referencing `node(id, parent_id, node_type_id, name)` table plus a `node_type(id, tenant_id, name, rank, parent_type_id)` table that defines each tenant's allowed hierarchy shape. Adjacency list beats closure table/nested sets here because structure changes are rare while device-state writes are frequent — closure/nested-set optimize the wrong axis. Keep `Device` a distinct table (it has ping-specific fields) with a `node_id` FK. Denormalize a precomputed ancestor path onto each node/device so aggregation doesn't require a recursive query per ping event. Migrate via a compatibility view layer (old `Campus`/`Building`/`Room` become views over `node`), not dual-write — hierarchy row counts are tiny relative to ping-event volume, so a backfill + cutover is safe.

**Storage auth (security-engineer):** One shared bucket, per-tenant prefixes (`s3://argus-metrics/{tenant_id}/{zone_id}/...`), with IAM policies scoped by a principal tag rather than one hand-written policy per client. MVP writer credential: a scoped IAM user restricted to `PutObject` on its own prefix only (no `Get`/`List`/`Delete`); plan to graduate to STS AssumeRole via a small broker before real multi-tenant onboarding, since short-lived session credentials bound the blast radius of a leaked edge-site credential. Reader (argus-server) gets `GetObject`+`ListBucket` across all prefixes with writes explicitly denied — cross-tenant isolation is enforced entirely on the writer side (each client can only ever write its own prefix), not the reader side. Sign payloads with a per-client Ed25519 keypair independent of AWS auth (IAM proves *who* wrote an object, not that it's untampered or unreplayed); reject stale/out-of-order sequence numbers on the server.

**Network topology (network-engineer):** Push-over-outbound-HTTPS to object storage is the right call, not a VPN mesh or reverse tunnel — sites are behind arbitrary customer-managed NAT/firewalls with no guarantee of inbound cooperation, and outbound HTTPS is the one pattern virtually every corporate network permits by default. Local ping engine must stay fully decoupled from push success (zone stays 100% functional locally regardless of WAN state). Fixed 5-minute baseline push interval, layered with immediate (debounced) pushes on significant state deltas. Server should detect "zone went dark" via staleness of last-successful-push-per-zone, not rely on the client self-reporting failure. ICMP-only blind spots (devices that block ICMP but respond on TCP) are a known secondary risk, worth flagging but not a v1 blocker. Keep server ingestion storage-agnostic so a future mixed mode (some zones centrally pingable) doesn't require a redesign.

## 4. Technical Plan

### 4.1 Backend: dynamic hierarchy data model

Replace the rigid FK chain in `backend/app/models.py` (`Campus` :231-237, `Building` :219-229, `Room` :239-249) with:

- `NodeType(id, tenant_id, name, rank, parent_type_id)` — defines a tenant's hierarchy shape (e.g. rank 0 = Campus-equivalent, rank 1 = Building-equivalent, ...).
- `Node(id, parent_id NULLABLE, node_type_id, name, path_ids JSON, created_at)` — self-referencing tree. `path_ids` is a denormalized ancestor-id array, recomputed only on structural writes (rare), used to avoid recursive queries on the hot device-state-change path.
- `Device` (`backend/app/models.py:252-261`) keeps its own table (ip_address, device_type stay device-specific) but its FK becomes `node_id` instead of `room_id`, still nullable/`ondelete=CASCADE`.

**Compatibility layer:** keep `CampusPublic`/`BuildingPublic`/`RoomPublic`-shaped API responses working during migration by adding a repository-layer shim (or DB views) over `node` filtered by `node_type.rank`, so `backend/app/api/routes/{campuses,buildings,rooms}.py` don't need to break in the same deploy as the schema change. Existing route-level validation gaps (no parent-existence check before insert, noted in exploration — e.g. `rooms.py:60-73`) should be fixed as part of this change: validate `parent_id`'s `node_type` against the tenant's configured `parent_type_id` chain at the API boundary, since a generic `node` table loses the DB-level FK-per-level guarantee that made the old design self-enforcing.

Migration path: backfill `node_type`/`node` rows from existing `campus`/`building`/`room` data, cut `Device.room_id` over to `Device.node_id`, then retire the old tables once compatibility views are no longer needed. Single backfill + cutover, not dual-write (hierarchy data volume is small).

### 4.2 Redis key generalization

Today `pingsvc`'s Lua script (`pingsvc/cmd/pingsvc/main.go:46-108`) hardcodes exactly two aggregation levels: `stats:room:<id>` / `stats:bldg:<id>`, and channels `events:room:<id>` / `events:bldg:<id>` (falling back to flat `pings:events` today, since `RoomID`/`BldgID` are currently never populated — see §4.3).

Generalize to `stats:node:<id>` / `events:node:<id>`, one entry per ancestor in the device's `path_ids`. On a device state change, walk the (denormalized, precomputed) ancestor list and `HINCRBY`/`PUBLISH` for each — fan-out becomes proportional to depth, not to a fixed level count, so adding a hierarchy level never requires a script or schema change. The backend's Redis listener (`backend/app/core/redis.py:54-83`) currently only subscribes to the flat `pings:events` channel — per-node subscriptions for scoped WebSocket delivery are a natural follow-up but not required for v1 (the `Broadcaster` in `backend/app/core/broadcast.py` already fans out to all connected clients with no filtering; leave that as-is for v1 and revisit if per-zone dashboard scoping is needed).

The `members:room:<id>` Redis set maintained by `backend/app/api/routes/devices.py` (:65-68, :98-103, :128-129) and read by `rooms.py:117-170` needs the same generalization to `members:node:<id>`.

### 4.3 pingsvc: client/exporter role

Per golang-pro's recommendation:

- Add `-role=pingsvc|exporter|both` (default `pingsvc`, preserving current behavior exactly). The existing worker pool + batcher + Lua pipeline (`main.go` lines ~350-472) is gated behind `role != exporter`; a new `runExporter(ctx, rdb, cfg)` goroutine is gated behind `role != pingsvc`.
- **Wire up the currently-dead `Target{Addr, RoomID, BldgID}` struct** (`main.go:110-114`) — this is the concrete first step that makes per-node aggregation (§4.2) actually populate instead of always falling through to the flat `pings:events` channel as it does today. `loadTargets()` (`main.go:513-521`) needs to read a richer target file format (addr + node_id) instead of bare IPs, or resolve node_id via a lookup against the backend's node table at startup.
- `runExporter` independently `HGETALL`s `stats:node:*` and `pings:state`, builds a gzip JSON snapshot (`{zone_id, ts, nodes: {node_id: {up, down}}, devices: {addr: {ok, ts}}}`) every ~30-60s in-memory, but only **pushes** to object storage on the 5-minute baseline / event-driven cadence from §4.4-4.5 below.
- On push failure: spool to local disk (`/var/lib/argus/pending/<ts>.json.gz`), age/size-bounded eviction, retry oldest-first on next tick, with a Prometheus gauge for spool depth so operators get alerted before eviction.
- `argus-client` = this binary running with `role=both`, colocated with the backend + frontend dashboard, all pointed at a zone-local Redis/MySQL — i.e. the full existing stack, deployed once per zone.

### 4.4 Object storage transport + auth

- Bucket layout: single shared bucket, `s3://argus-metrics/{tenant_id}/{zone_id}/YYYY/MM/DD/HH/<unix_ts>.json.gz`. Objects are immutable and idempotent (safe to retry/duplicate).
- **Phase 1 (MVP) credential:** a scoped IAM user per zone, `PutObject`-only on its own prefix, no `Get`/`List`/`Delete`. Provisioned by a small internal admin CLI (not a public endpoint) that also handles out-of-band delivery of the initial key.
- **Phase 2 credential:** graduate the writer path to STS AssumeRole via a lightweight broker (short-lived session credentials, centralized revocation) before onboarding zones outside a single trusted operator.
- Reader (argus-server): separate IAM role, `GetObject`+`ListBucket` across all prefixes, writes explicitly denied. Cross-tenant isolation is enforced by the writer-side prefix scoping, not the reader.
- Payload integrity: per-client Ed25519 keypair generated at provisioning time (independent of the AWS credential), client signs `{payload_hash, ts, sequence_number}`; server verifies signature and rejects stale/out-of-order sequence numbers to catch replay. S3 versioning on for audit/recovery.
- Push cadence: fixed 5-minute baseline + immediate (30-60s debounced) push on significant state deltas, per network-engineer's recommendation.

### 4.5 argus-server ingestion

New ingestion job (polls the bucket, or subscribes to S3 event notifications if available) reads objects per zone and writes:

- `client_snapshot(client_id, zone_id, pulled_at, hierarchy_json, device_states_json, storage_ref)` — the zone's own node/device tree plus device states, stored as opaque JSON (per sql-pro: don't force cross-zone taxonomy unification). Dashboards rehydrate a zone's tree from this JSON per-request.
- A separate lightweight `zone_summary(zone_id, up_count, down_count, pulled_at)` table, computed at ingest time, if/when cross-zone rollup views ("total devices down across all zones") are needed — independent of any per-zone hierarchy shape.
- Staleness tracking: last-successful-pull-per-zone, alerting when a zone exceeds ~2x its expected push interval without a new object — this is how "zone went dark" is detected, since the zone itself can't self-report a WAN outage.

### 4.6 Frontend (deferred scope for v1)

The frontend's hierarchy assumption is baked in at the routing/component level: fixed 4-level routes in `frontend/src/App.tsx` (`/campuses`, `/buildings`, `/rooms`, `/devices` and their `:id` detail variants), with `CampusDetail.tsx` and `BuildingDetail.tsx` doing client-side filtering by exact parent-id field name (`campus_id`, `building_id`) rather than a generic parent relationship, and a manually-built `HierarchyBreadcrumb` per page.

For the initial stages, **do not** build a fully generic, arbitrary-depth tree UI — that's real effort (`Campuses.tsx`/`Buildings.tsx`/`Rooms.tsx`/`Devices.tsx` and their `Detail.tsx` counterparts, plus `frontend/src/api/{campuses,buildings,rooms,devices}.ts`, would all need to become one data-driven component) and the backend compatibility layer (§4.1) means the existing 4-level UI keeps working unmodified against a single-zone argus-client for as long as that zone's `node_type` config happens to match the old 4-level shape (the common case, since most deployments will still look like Campus→Building→Room→Device initially). The only frontend work needed for v1 is on the **argus-server** side: a zone selector/switcher so an operator can pick which zone's snapshot to view, reusing the existing per-level pages against whichever zone is selected. Generalizing the tree UI to arbitrary depth is a v2+ item, only needed once a real deployment actually configures a non-4-level hierarchy.

### 4.7 Per-zone hierarchy configuration (YAML)

Each zone needs a way to declare its own hierarchy *shape* (the `NodeType` chain from §4.1) without a code change or an admin manually clicking through a setup wizard — that's the actual question the plan file's original name (`dynamic-model-yaml-file.md`) was pointing at, so it's worth making explicit rather than leaving it implied by "NodeType rows exist somehow."

- **Format:** a `hierarchy.yaml` file per zone, sitting alongside that zone's `.env` (same deployment-config tier, not checked into the app repo — it's environment-specific like `MYSQL_DATABASE`). Rank is implicit from list order, so a college zone writes:
  ```yaml
  tenant_id: campus-a
  levels:
    - name: Campus
    - name: Building
    - name: Room
  ```
  and an enterprise zone writes:
  ```yaml
  tenant_id: acme-corp
  levels:
    - name: Region
    - name: Site
    - name: Rack
  ```
  This only expresses a strict linear chain (each level has exactly one parent level) — matches what the current 4-table design already assumes, and keeps the file trivial to hand-write. If a future deployment needs branching types at the same rank (e.g. both "Room" and "OutdoorArea" as valid children of "Building"), extend the format with an explicit `parent:` field per level rather than positional order; not needed for v1.
- **Loading:** a new `backend/app/seed_hierarchy.py`, run by `backend/scripts/prestart.sh` in the same slot as the existing `alembic upgrade head` → `python app/initial_data.py` sequence (`prestart.sh:8-12`) — i.e. hierarchy shape is seeded as part of the same prestart step that already bootstraps the DB, not a separate admin action. The script upserts `NodeType` rows for `tenant_id`, matching rank to list index; if it's a fresh zone, this is the only setup an operator needs.
- **Idempotency vs drift:** on re-run (every container restart), the script must be a no-op if `hierarchy.yaml` still matches the DB's existing `NodeType` rows for that tenant. If the file has changed in a way that would rename/reorder/remove a rank that already has `Node` rows under it, **fail prestart loudly** rather than silently applying it — this is the same "schema drift" risk already flagged in §6, and prestart is exactly the wrong place to silently migrate live hierarchy data. A real structural change (e.g. splitting "Building" into "Wing" + "Floor") should go through an explicit, reviewed migration, not an unattended file edit.
- **Day-to-day node/device creation** (the actual Buildings/Rooms/Devices an admin adds after setup) is unaffected by this — that still goes through the generic Node CRUD API from §4.1, same as today's `POST /buildings`, `POST /rooms` flow, just validated against whichever `NodeType` chain that zone's `hierarchy.yaml` established.
- **Multi-tenant SaaS later:** once argus-server hosts hierarchy config for multiple *self-service* tenants (rather than one zone = one deploy an operator controls the filesystem of), replace file-based seeding with the same underlying `NodeType` CRUD API driven by an admin UI screen — `hierarchy.yaml` becomes an import/export format at that point rather than the only mechanism. Not needed for v1.

## 5. Phased Rollout

Each phase follows the repo's TDD loop and Feature Branch Workflow (branch → RED → implement → GREEN → review diff → commit) from `CLAUDE.md`, one feature branch per phase (or per sub-item within a phase):

| Phase | Scope | User-visible change |
|---|---|---|
| **0** | `Node`/`NodeType` tables + compatibility views; `path_ids` denormalization; generalized `stats:node:<id>`/`events:node:<id>` Redis keys (dual-write alongside old keys during transition); `hierarchy.yaml` + `seed_hierarchy.py` prestart step (§4.7) | None — existing API/UI keep working |
| **1** | pingsvc `-role` flag; wire up `Target.RoomID/BldgID` → `Target.NodeID`; `runExporter` goroutine + local disk spool; no object-storage push yet, just prove snapshot generation | None — opt-in flag |
| **2** | Object storage bucket/prefix + Phase-1 scoped IAM credentials; Ed25519 signing; argus-server ingestion job + `client_snapshot`/`zone_summary` tables; staleness alerting | New: a second argus-server instance can render one zone's data |
| **3** | Multi-zone selector on argus-server dashboard; STS-broker credential upgrade if/when onboarding beyond a single trusted operator | New: multi-zone dashboard |
| **4 (later)** | Generic arbitrary-depth tree UI on the frontend, once a real deployment needs a non-4-level hierarchy | Full dynamic hierarchy UI |

## 6. Open Questions / Risks

- **ICMP-only blind spot** (network-engineer): some devices block ICMP but respond on TCP, producing false-down. Not a v1 blocker; flag for a future per-device protocol-fallback config.
- **CSV bulk upload** (`backend/app/api/routes/devices.py:134-254`) currently replaces the devices table wholesale keyed by the old flat schema — needs updating to the `node_id` model in Phase 0.
- **Multi-tenant SaaS timing**: the shared-bucket-per-tenant-prefix design (§4.4) is deliberately chosen to defer the harder per-tenant-bucket/account decision until there's a real compliance or blast-radius driver — don't build that ahead of need.
- **Schema drift across zones over time**: if a zone's `node_type` config changes after devices/history already reference the old shape, `client_snapshot` JSON blobs from before/after the change will disagree — worth a version field on `hierarchy_json` even in v1 to avoid silent misrendering later.
- **Existing route-level validation gaps** (e.g. `rooms.py:60-73` never validates `building_id` exists before insert, relying solely on the DB FK) must be replaced with explicit `node_type`/`parent_id` validation in Phase 0, since the generic `node` table can't rely on a fixed set of per-level FK constraints to catch this anymore.

## 7. Key File Touch Points

| Area | Files |
|---|---|
| Backend models | `backend/app/models.py` (Campus/Building/Room/Device sections) |
| Backend routes | `backend/app/api/routes/{campuses,buildings,rooms,devices}.py`, `private.py` |
| Backend Redis | `backend/app/core/redis.py`, `backend/app/core/broadcast.py`, `backend/app/config.py` |
| pingsvc | `pingsvc/cmd/pingsvc/main.go` (Target struct, loadTargets, Lua script, batcher) |
| Frontend | `frontend/src/App.tsx`, `frontend/src/pages/{Campuses,CampusDetail,Buildings,BuildingDetail,Rooms,RoomDetail,Devices,DeviceDetail}.tsx`, `frontend/src/api/{campuses,buildings,rooms,devices}.ts` |
| Hierarchy seeding | `backend/scripts/prestart.sh`, `backend/app/initial_data.py` (new sibling `seed_hierarchy.py`) |

## 8. Repo Topology, Versioning & CI/CD (devops-engineer)

Current state: single monorepo, one `compose.yml` builds/runs all services together, and `.github/workflows/deploy-production.yml` deploys the whole stack to one self-hosted-runner target on every published GitHub Release — a single-tenant, single-stack deploy model. That model doesn't survive the client/server split (dozens of independently-owned zones on networks CI has no route into), so the following changes are part of this plan, not a separate initiative:

- **Repo topology — stay monorepo.** argus-client and argus-server are the same codebase differentiated by role/config, not different products; splitting into a "core" repo consumed by separate client/server repos would recreate coupling through version pins instead of one PR, for no isolation benefit. Split build *artifacts* (images, compose files), not source.
- **Versioning — semver on the app, a separate `schema_version` on the wire contract.** One git tag = one build of both images. The thing that actually needs a compatibility promise is the object-storage payload format (§4.4's JSON snapshot, plus `hierarchy_json` from §4.7) — give it its own `schema_version` field, independent of app semver, and keep argus-server tolerant of at least the last 2 schema versions, since clients will lag the server for months by design (§4.4/§6).
- **Images — client is config, not a separate build.** Same backend/frontend image for both roles, selected by a `ROLE=client|server` env var (mirrors pingsvc's planned `-role` flag). Replace the single `compose.yml` with `compose.client.yml` (full stack: backend+frontend+pingsvc+local redis/db) and `compose.server.yml` (backend+frontend+ingestion job, no pingsvc), so which topology is running is visible in the invocation, not buried in `.env`.
- **CI/CD — push-based deploy dies for clients, survives for the server.** `deploy-production.yml`'s "release → `docker compose up -d` on one runner" can't reach client zones on customer networks. Replace with: CI builds/tags/pushes versioned images to a registry (GHCR) and stops there for the client path; each argus-client zone self-upgrades via a small pull-based mechanism (scheduled `docker compose pull && up -d` against a configured channel, e.g. `stable` / `pinned-vX.Y`) it runs itself, with a per-zone opt-in/opt-out channel and a documented rollback (`pull <prev-tag>`) rather than a fleet-management platform. Keep the existing push-based deploy pattern for argus-server only, since that remains centrally owned — `deploy-staging.yml`'s current pattern doesn't need to change.
- **Tests — add a role matrix + payload contract test, not per-zone CI.** The existing `test-backend.yml`/`test-pingsvc.yml`/`test-frontend.yml` stay as-is for "does this commit build and pass." Add a `ROLE=client`/`ROLE=server` matrix and a contract test pinning the exporter's payload shape (§4.3/§4.4) against the server's ingestion parser (§4.5) for the last 2 supported `schema_version`s — that's the one genuinely new test surface this refactor introduces. Don't try to run CI against every zone's live config/version combo — that's what per-zone staleness alerting (§4.5) is for, not CI.
