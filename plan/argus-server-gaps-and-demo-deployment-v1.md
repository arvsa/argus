# argus-server Gap Analysis & Demo Deployment Plan (v1)

## 1. Problem & Goal

Argus deploys from one codebase in two roles. The **argus-client** side (zone-local
pingsvc + Redis + backend + dashboard, S3 snapshot export) is in a working state.
The **argus-server** side (central ingestion + multi-zone dashboard) has real gaps —
most visibly, it serves the *same UI as the client*, with the landing page and half
the nav broken because the ping-pipeline routes are (correctly) unmounted on
`ROLE=server`.

**Goal:** close the gaps that block a credible online demo, then deploy:

- **argus-client** on an AWS EC2 instance (real ICMP targets, real S3 export)
- **argus-server** on AWS (see §4 — Vercel can only host the static frontend, not
  the backend; recommendation is to skip it for v1)
- Finish with a written production-deployment tutorial (`deployment-tutorial.md`),
  authored during the actual deployment so every step is verified.

This plan was produced from a three-way audit (backend server-role, frontend
server-mode, cloud architecture) against
[dynamic-hierarchy-multi-zone-architecture.md](dynamic-hierarchy-multi-zone-architecture.md)
and its [implementation summary](dynamic-hierarchy-multi-zone-implementation-summary.md).

## 2. What already works (no action needed)

- **Backend `ROLE` split shipped** (PR #81): `ROLE: Literal["client","server"]`
  (`backend/app/core/config.py:107`), lifespan gates Redis/WS on `client` and
  `ingestion_task` on `server` (`backend/app/main.py:42`, `:82`), `pings.router`
  only mounted for `client` (`backend/app/api/main.py:27`). A Redis-less
  argus-server starts and ingests today.
- **Ingestion pipeline is real**: paginated bucket listing, idempotent by
  `storage_key`, Ed25519 verification against the *registered* key, `ZoneSummary`
  upserts, staleness flag on `GET /api/v1/zones/summary`.
- **Auth is role-agnostic**: login/register/profile/user-admin work unchanged on a
  server instance (`login`/`users` routers always mounted, `api/main.py:24-25`).
- **compose is role-capable**: `ROLE=${ROLE:-client}` (`compose.yml:125`), Redis
  optional via profile, `scripts/run.sh` wrapper; Traefik + Let's Encrypt path
  exists (`compose.traefik.yml`, `deployment.md`).

## 3. Gap analysis

### 3.1 Blockers for the demo

| # | Gap | Evidence | Spec ref |
|---|---|---|---|
| G1 | **No zone drill-down API.** `ClientSnapshot.nodes_json`/`devices_json` are stored but write-only — the only zones route is `GET /zones/summary` (`backend/app/api/routes/zones.py`, 39 lines, one route). `ClientSnapshotPublic` exists (`models.py:352`) but nothing returns it. | zones.py:14-38 | §4.5, §4.6 |
| G2 | **No API/CLI to register a `ZoneSigningKey`.** `crud.create_zone_signing_key` (`crud.py:213`) is reachable only via a hand-run Python shell against MySQL (`deployment.md:244` admits this). An operator can't enable signature verification. | crud.py:213 | §4.4 |
| G3 | **Frontend has zero role awareness.** No `VITE_ROLE`, no capabilities probe, static nav (`AppShell.tsx:29-39`). On a server instance: Dashboard `/` is broken (`/stats` 404 + WS fail), Devices broken (`/state` 404), `NodeTree` per-node stats 404 (`/node-stats`), and `LiveFeedProvider`/`WsIndicator` (`AppShell.tsx:125,159`) show a permanent connection error on every page. | Dashboard.tsx:13-34, Devices.tsx:19, NodeTree.tsx:62-63 | §4.6 |
| G4 | **No zone detail UI.** `Zones.tsx` is a flat, non-clickable summary table; no `/zones/:id` route, no per-zone node/device view. This is the actual argus-server product feature (plan Phase 4, "not started"). | Zones.tsx, App.tsx:26-47 | §4.6 |
| G5 | **compose production gotchas**: pingsvc `cap_add: [NET_RAW, NET_ADMIN]` commented out (`compose.yml:251-253` — every device reports down without it); no volume for `/var/lib/argus` (Ed25519 key regenerates on restart, breaking the server's registered-key trust); bogus Traefik labels on pingsvc routing `api.${DOMAIN}` to `pingsvc:8000` (`compose.yml:254-270`); frontend always builds the `dev` Vite target (`compose.yml:167`), never the prod nginx stage. | compose.yml | §8 |

### 3.2 Important (should land before/with the demo, not strictly blocking)

| # | Gap | Evidence | Spec ref |
|---|---|---|---|
| G6 | **No `schema_version` on the wire payload.** Exporter `Snapshot` is `{zone_id, ts, nodes, devices}` (`pingsvc/cmd/pingsvc/exporter.go:41-46`); ingestion `.get()`s fields with defaults, so a format change silently degrades. | exporter.go:41 | §8 |
| G7 | **No replay/sequence protection.** Spec mandates signing `{payload_hash, ts, sequence_number}` and rejecting stale/out-of-order sequences; no sequence number exists anywhere. Idempotency is exact-`storage_key` only — a validly-signed old payload re-uploaded under a new key re-ingests as fresh. | ingestion.py:46,83 | §4.4 |
| G8 | **Unbounded `ClientSnapshot` growth.** Every cycle inserts, nothing ever deletes (`crud.py:156`). Weeks-scale problem, not demo-day, but a running "production" hits it. | crud.py:156 | — |
| G9 | **Zone summaries have no human metadata** — raw `tenant_id`/`zone_id` strings only, no display name (`models.py:363-391`). | models.py:363 | §4.6 |
| G10 | **Staleness threshold is one global default** (`STALENESS_THRESHOLD_SECONDS=120`, `config.py:118-122`), no per-zone expected-push-interval. | config.py:118 | §4.5 |
| G11 | **CI deploy workflows don't pass `S3_*`/`ARGUS_*` secrets** (`deployment.md:347`) — a CI-deployed server starts with ingestion disabled. | deploy-production.yml | §8 |

### 3.3 Deferred (recorded, deliberately not in this plan's scope)

- **Tenancy scoping** — any authenticated user sees all tenants' zones
  (`zones.py:16,23-26`; `User` has no `tenant_id`). Real gap for a shared server;
  irrelevant for a single-operator, single-tenant demo. Revisit before any
  multi-tenant use.
- **Signature-failure surfacing/alerting** (`signature_verified=False` rows are
  stored but invisible) — partially addressed by G1's drill-down exposing the flag.
- Historical-snapshot listing route; `seed_hierarchy` being conceptually
  client-only (harmless no-op on a server); stale
  `backend-lifespan-role-split-v1.md` doc (describes pre-PR-#81 code).
- `compose.server.yml`/`compose.client.yml` split from §8 — the shipped
  `ROLE` env + compose profiles approach is a functional deviation; keeping it.

## 4. Cloud architecture (recommendation)

### 4.1 Vercel reality check

The argus-server backend **cannot run on Vercel**: it is a long-lived FastAPI
process whose ingestion loop is a persistent asyncio lifespan task polling S3
forever — serverless functions are request-scoped and frozen between invocations,
so the loop would run zero iterations. MySQL and WebSockets don't fit either.
Only the static React build could go on Vercel, and today even that can't: the
frontend hardcodes a relative `baseURL: "/api/v1"` (`frontend/src/api/client.ts:5`),
builds its WS URL from `window.location.host` (`useLiveFeed.tsx:25-26`), and
`BACKEND_CORS_ORIGINS` defaults to empty. Vercel rewrites also don't proxy
WebSocket upgrades (breaks the client dashboard's live feed).

**Recommendation: skip Vercel for v1.** The repo already ships a complete
same-origin HTTPS path (Traefik + Let's Encrypt + the frontend's prod nginx stage
proxying `/api` and WS). A Vercel-hosted server dashboard is a clean *optional
follow-up* (Phase V below) because the server UI is plain REST — but it needs the
`VITE_API_URL` + CORS work first.

### 4.2 Recommended topology: two ARM EC2 instances + one S3 bucket

The demo's point is *two visibly separate deployments connected only through
object storage* — so use two boxes. They never talk directly; keeping them
network-isolated demonstrates the architecture.

- **Instance A — argus-client** (`t4g.small`, 2 GB, 20 GB gp3): Traefik, MySQL,
  Redis, backend `ROLE=client`, pingsvc `ARGUS_ROLE=both`, frontend (prod target).
  ICMP targets: public anycast IPs (8.8.8.8, 1.1.1.1) + optionally Instance B's
  private/public IP with ICMP allowed in its security group. IAM **instance
  profile** with `s3:PutObject` on `arn:aws:s3:::<bucket>/<tenant>/<zone>/*` only —
  leave `ARGUS_S3_ACCESS_KEY` unset so the SDK default chain uses the role (already
  supported, `config.py:115` / deployment.md).
- **S3 bucket** (private, SSE-S3, Block Public Access): lifecycle rule expiring
  objects after 7 days (~5,760 PUTs/day/zone at a 30 s export interval — pennies,
  but only with expiry).
- **Instance B — argus-server** (`t4g.small`): Traefik, MySQL, backend
  `ROLE=server` + `S3_BUCKET`, frontend (prod target). No Redis, no pingsvc. IAM
  instance profile: `s3:GetObject`+`s3:ListBucket`, read-only, never the writer
  credential. One-time: register zone A's Ed25519 **public** key (via the new G2
  API; private key never leaves Instance A).
- **MySQL in Docker, not RDS**: demo data is reconstructible (client seeds from
  `hierarchy.yaml`; server rebuilds by replaying the bucket). RDS ×2 (~$28/mo)
  costs more than both EC2 boxes. Optional nightly `mysqldump | gzip | aws s3 cp`.
- **TLS/domains**: one domain (~$10/yr), wildcard A records per box
  (`*.argus.example.com` → B, `*.hq.argus.example.com` → A), Traefik + Let's
  Encrypt as documented in `deployment.md`. No ALB.
- **Secrets**: instance profiles for S3 (no static keys); per-instance `.env`
  (`chmod 600`) with generated `SECRET_KEY`/DB passwords; Ed25519 key on a named
  volume (G5); don't expose Adminer publicly; SSH via SSM Session Manager (no
  port 22) if feeling tidy.
- **Cost**: ≈ **$39/mo** (2× t4g.small + EBS + 2 public IPv4 + S3 + domain).
  Cheaper alternative: one box running both compose projects (~$21/mo) — saves
  $16 but collapses the two-deployment story and shares failure domains; not
  recommended.
- **Explicitly skipped at demo scale**: k8s/ECS, RDS/Multi-AZ, ALB/CloudFront/WAF,
  NAT/private subnets, VPC peering (S3 *is* the interface), Terraform (clickops +
  notes is fine for 2 instances; graduate when zone #3 appears), Secrets Manager.
- **Graduation path (later, in order)**: RDS single-AZ when data stops being
  reconstructible → Terraform for bucket/IAM/instances → ECR + pull-based deploys
  → per-zone staleness registration (G10) → Prometheus/Grafana on pingsvc's
  `:9090/metrics` + Sentry (`SENTRY_DSN` already wired) → Multi-AZ/ALB only with
  a second operator and an availability SLO.

## 5. Phased rollout

Each phase = one feature branch + PR, TDD loop per `CLAUDE.md` (RED →
implement → GREEN → `./scripts/test.sh` → show diff → wait for review).

### Phase 1 — server API surface (backend)

**1a. Zone drill-down endpoints** (fixes G1) — `feature/zone-snapshot-detail-api`
- `GET /api/v1/zones/{tenant_id}/{zone_id}/latest` → latest `ClientSnapshot` for
  the zone rendered via `ClientSnapshotPublic` (nodes_json rollups, devices_json
  states, `signature_verified`, `snapshot_ts`). 404 if the zone has no snapshots.
- Auth: `CurrentUser` (matches `/zones/summary`).
- Tests: seeded snapshot → correct payload; unknown zone → 404; newest-of-several
  selected.

**1b. Signing-key management API** (fixes G2) — `feature/zone-signing-key-api`
- `PUT /api/v1/zones/{tenant_id}/{zone_id}/signing-key` (superuser-only) wrapping
  `crud.create_zone_signing_key` — register or rotate in place. `GET` companion
  returning the registered public key (public half only — safe to read back).
- Tests: non-superuser 403; invalid hex 422; rotation replaces; subsequent
  ingestion verifies against the new key.

**1c. Zone display names** (fixes G9, small) — fold into 1a's branch if trivial:
optional `display_name` on `ZoneSummary` + a superuser `PATCH` to set it, exposed
on `/zones/summary`. If it grows, split out.

### Phase 2 — frontend server mode

**2a. Role awareness** (fixes G3) — `feature/frontend-role-awareness`
- Backend: tiny public `GET /api/v1/utils/app-config` returning `{"role": settings.ROLE}`
  (runtime endpoint, not `VITE_ROLE` — same image must serve both roles, per §8
  "client is config, not a separate build").
- Frontend: fetch once at app boot (React Query, cached); in `server` mode —
  nav shows Zones (landing page `/` → redirect or render Zones), Hierarchy Types,
  Users, Profile; hide Dashboard/Devices; don't mount `LiveFeedProvider`/`WsIndicator`;
  `NodeTree` skips `/node-stats`. Client mode byte-identical to today.
- Tests: vitest for nav gating both roles; backend test for the config route.

**2b. Zone detail page** (fixes G4) — `feature/zone-detail-page`
- `/zones/:tenantId/:zoneId` route; `Zones.tsx` rows become clickable.
- Renders Phase 1a's payload: summary header (counts, staleness,
  `signature_verified` badge), device-state table (addr, up/down, last-change ts),
  node rollup list. Snapshot data is opaque per-zone JSON — render generically,
  no assumption about hierarchy shape.
- Empty/error states per the frontend-v2 "visibly and honestly" rule.

### Phase 3 — pipeline hardening (backend + pingsvc)

**3a. `schema_version` on the wire** (fixes G6) — `feature/snapshot-schema-version`
- Exporter adds `schema_version: 1` to `Snapshot`; ingestion records it on
  `ClientSnapshot`, accepts absent-or-1, warns+skips unknown future versions.
- Contract test pinning the exporter's JSON shape against the ingestion parser
  (the §8 "one genuinely new test surface").

**3b. Replay guard** (fixes G7) — `feature/snapshot-replay-guard`
- Minimal-but-honest version: ingestion rejects (logs + marks, doesn't summarize)
  any snapshot whose `ts` ≤ the zone's `last_snapshot_ts` — monotonic-timestamp
  guard using data already present. Full `sequence_number` in the signed manifest
  can follow later; document the residual gap.

**3c. Snapshot retention** (fixes G8) — `feature/client-snapshot-retention`
- Prune inside the ingestion loop: delete `ClientSnapshot` rows older than
  `SNAPSHOT_RETENTION_DAYS` (default 7), always keeping the newest per zone.

### Phase 4 — deploy prep (compose/config)

**4a. compose production fixes** (fixes G5) — `fix/compose-production-gaps`
- Uncomment `cap_add: [NET_RAW, NET_ADMIN]` on pingsvc; add named volume for
  `/var/lib/argus`; delete the bogus pingsvc Traefik labels; make the frontend
  image target selectable (`prod` for deploys) — verified by bringing the stack up
  in both roles locally.
- Note in `deployment.md` for G11 (CI deploys need `S3_*` secrets) — actual CI
  wiring optional since the demo deploy is manual first.

### Phase 5 — deploy + tutorial (the finish line)

- Provision per §4.2 (bucket + lifecycle, 2 IAM roles/profiles, 2 EC2, DNS).
- Deploy Instance A (client), confirm snapshots land in S3; deploy Instance B
  (server), register the signing key via Phase 1b's API, confirm
  `signature_verified=true` and the zone appears fresh in the new UI.
- **Write `deployment-tutorial.md`** as the deployment happens — every command
  actually run, in order: AWS provisioning, DNS, `.env` setup, compose invocations
  per role, key registration, smoke checks, teardown/rollback. This is the
  tutorial deliverable; writing it during (not after) the deploy keeps it honest.

### Phase V (optional follow-up) — Vercel-hosted server dashboard

Only if the "Vercel line on the demo" is wanted: introduce `VITE_API_URL` threaded
through `api/client.ts`/`api/auth.ts`, add the Vercel origin to
`BACKEND_CORS_ORIGINS`, deploy the static build to Vercel pointed at Instance B's
API. Server UI is REST-only so no WS problem; the *client* dashboard stays
same-origin on Instance A.

## 6. Open questions / risks

- **Phase 2a role probe is public** — exposing `{"role": "server"}` unauthenticated
  is harmless (it's evident from which routes 404 anyway), but flag it.
- **G10 (per-zone staleness)** stays deferred; for the demo, tune the global
  `STALENESS_THRESHOLD_SECONDS` to ~3× the client's export interval.
- **Replay guard (3b)** is monotonic-ts, not the spec's full sequence-number
  scheme — a deliberate scope cut, recorded here so it isn't mistaken for done.
- **Demo is single-tenant by construction**; the tenancy gap (§3.3) must be
  re-opened before any second real user org touches the server.

## 7. Key file touch points

| Area | Files |
|---|---|
| Server API | `backend/app/api/routes/zones.py`, `backend/app/crud.py`, `backend/app/models.py` |
| App config route | `backend/app/api/routes/utils.py`, `backend/app/core/config.py` |
| Ingestion | `backend/app/core/ingestion.py` |
| Exporter | `pingsvc/cmd/pingsvc/exporter.go`, `exporter_test.go` |
| Frontend role/nav | `frontend/src/layouts/AppShell.tsx`, `frontend/src/App.tsx`, `frontend/src/api/client.ts` |
| Zone UI | `frontend/src/pages/Zones.tsx`, new `frontend/src/pages/ZoneDetail.tsx`, `frontend/src/api/zones.ts` |
| Deploy | `compose.yml`, `compose.traefik.yml`, `deployment.md`, new `deployment-tutorial.md` (Phase 5) |
