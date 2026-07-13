# Docker Swarm orchestration for argus-client / argus-server (v1)

## Goal

Run argus-server and each argus-client zone as **independent Docker Swarm
stacks** with dynamic names — `argus-server-<#>` / `argus-client-<#>` — so one
swarm (or one box) can host the central server plus any number of numbered
zones side by side, each with its own DB/Redis/volumes, all routed through a
single shared Traefik. Plus scripts that automate development setup and image
builds.

## Why separate stack files (not compose.yml reuse)

`docker stack deploy` reads compose files but ignores/rejects the parts the
dev compose relies on: `build:` (swarm deploys prebuilt images only),
`profiles:` (how compose.yml gates redis/pingsvc per role), `depends_on`
conditions, `restart:`, and — critically — **container-level `labels:`**
(swarm-mode Traefik reads `deploy.labels`, so compose.yml's routing labels
are invisible to it). Hand-maintained swarm stack files per role are the
standard answer; the drift cost is noted in swarm/README.md.

## Design

- `swarm/stack.server.yml` — db, prestart (migrations, `restart_policy:
  condition: none`), backend `ROLE=server`, frontend (prod nginx image).
- `swarm/stack.client.yml` — the above plus redis and pingsvc (`cap_add:
  NET_RAW`, targets bind-mounted, `argus-data` volume for the signing key),
  backend `ROLE=client`.
- `swarm/stack.traefik.yml` / `stack.traefik.dev.yml` — swarm-provider
  Traefik (`deploy.labels`, manager placement). The dev variant is HTTP-only
  with a dummy `https-redirect` middleware (mirroring compose.override.yml's
  trick); prod mirrors compose.traefik.yml (Let's Encrypt, basic-auth
  dashboard).
- `swarm/stack.minio.yml` — dev-only S3 (MinIO + one-shot bucket-init),
  reachable cross-stack via a `minio` network alias on `traefik-public`.
- Cross-stack isolation for free: swarm prefixes volumes/networks/services
  with the stack name, so `argus-client-1` and `argus-client-2` get separate
  DBs, Redis, spool volumes, and signing keys. The only shared surface is
  the `traefik-public` overlay network and (dev) MinIO.
- Per-stack routing: every stack gets its own `DOMAIN`
  (`dashboard.<stack>.…`, `api.<stack>.…`), defaulted by the deploy script to
  `<stack>.localhost` for dev (Chrome resolves `*.localhost` natively).

## Scripts (`scripts/swarm/`)

- `build.sh` — builds/tags the three images (backend, pingsvc, frontend
  `prod` target) as `${DOCKER_IMAGE_*}:${TAG}`; optional `REGISTRY` prefix +
  `--push` for multi-node swarms.
- `deploy.sh <client|server> [#]` — computes `STACK_NAME=argus-<role>-<#>`,
  layers env (base `.env` → computed per-stack defaults → optional
  `.env.argus-<role>-<#>` override), validates required vars, `docker stack
  deploy`.
- `remove.sh <client|server> [#]` — tears one stack down (volumes survive).
- `dev-setup.sh` — one command from zero: `swarm init` (if needed), create
  the `traefik-public` overlay, deploy dev Traefik + MinIO, `build.sh`,
  deploy `argus-server-1` + `argus-client-1` wired together through MinIO,
  wait for health, print URLs/credentials. Idempotent.

## Known limits (accepted for v1)

- Single-node assumption for the bind mounts (`pingsvc/targets.txt`,
  `hierarchy.yaml`): fine for dev and for the one-box-per-role EC2 demo
  topology. Multi-node needs swarm configs (500 KB cap — too small for a
  9,600-line targets file) or registry-baked files; deferred.
- `prestart` runs migrations once per deployed image tag; on the very first
  deploy the backend may crash-loop for a few seconds until migrations
  finish (swarm restarts it; it converges). Same behavior class as compose's
  `service_completed_successfully`, minus the ordering guarantee.
- Rolling updates, replicas > 1, secrets-as-swarm-secrets: out of scope for
  v1; the stack files leave room (`deploy:` blocks) to add them.

## Verification

Live, not just lint: `dev-setup.sh` on a fresh (inactive-swarm) Docker
Desktop, then curl through Traefik with per-stack Host headers — both roles'
`/utils/app-config`, client exporter pushing to MinIO, server ingesting and
listing the zone — then `deploy.sh client 2` to prove the dynamic numbering,
then full teardown.
