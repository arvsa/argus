# Dynamic Hierarchy & Multi-Zone: Implementation Summary

Technical record of what Phases 0-3 of `plan/dynamic-hierarchy-multi-zone-architecture.md` actually built. The plan doc describes the design and rationale; this doc records what shipped, in which PRs, with which technical details, so the history survives independently of any one branch (the plan doc's own branch was briefly lost before merge — see PR #46).

## Phase 0 — dynamic hierarchy foundation (PRs #40, #41, #42, merged to `main`)

**PR #40 — `Node`/`NodeType` data model** (`backend/app/models.py`, `backend/app/crud.py`, migration `9f1c2d3e4a5b_add_node_type_and_node_tables.py`)
- `NodeType(id, tenant_id, name, rank, parent_type_id, created_at)` — one row per hierarchy *level* per tenant. `parent_type_id` self-references `node_type.id` (`ondelete=CASCADE`). `UniqueConstraint(tenant_id, rank)`.
- `Node(id, parent_id, node_type_id, name, path_ids, created_at)` — one row per hierarchy *instance*. `parent_id` self-references `node.id` (`ondelete=CASCADE`). `path_ids` is a denormalized JSON array of ancestor ids (root-first), recomputed only on insert, so aggregation never needs a recursive query.
- `crud.create_node_type` validates: root types (`parent_type_id=None`) must have `rank=0`; child types must have `rank == parent.rank + 1` and the same `tenant_id`.
- `crud.create_node` validates: a node's `parent_id` must reference a `Node` whose `node_type_id` matches the new node's `node_type.parent_type_id`; computes `path_ids = parent.path_ids + [parent.id]`.
- Fully additive — `Campus`/`Building`/`Room`/`Device` tables and every existing route/response are untouched. Compatibility views and the `Device.room_id` → `node_id` cutover were explicitly deferred, not yet done.
- Along the way: found and documented (not fixed) an orphaned `floor` table migration on `main` with no corresponding model — dead schema from unrelated abandoned work.

**PR #41 — generalized Redis aggregation keys** (`pingsvc/cmd/pingsvc/main.go`, `redis_test.go`)
- `Event` gained `NodeIDs []string` (json tag `node_ids`) alongside the pre-existing `RoomID`/`BldgID`.
- The Lua script `publishIfChangedAndAggregateScript` now loops over a comma-separated `nodeIDsCSV` ARGV, doing `HINCRBY stats:node:<id>` + `PUBLISH events:node:<id>` per ancestor — replaces the old hardcoded two-level `stats:room:<id>`/`stats:bldg:<id>` fan-out with one proportional to actual depth.
- `RoomID`/`BldgID` keep working unchanged (dual-write) so nothing existing breaks; the generic `pings:events` fallback only fires if none of node/room/bldg published.
- At this point nothing in production populated `NodeIDs` yet (same as `RoomID`/`BldgID` always being empty) — this PR only generalized the *mechanism*.

**PR #42 — `hierarchy.yaml` prestart seeding** (`backend/app/seed_hierarchy.py`, `backend/scripts/prestart.sh`)
- Parses a zone's `hierarchy.yaml` (`tenant_id` + ordered `levels: [{name: ...}]` list, rank = list index) and idempotently upserts `NodeType` rows via `crud.create_node_type`.
- `HierarchyDriftError` raised if a rank that already has rows would be renamed or removed (structural changes need an explicit migration, not unattended prestart mutation). Extending with a new trailing level is allowed.
- Wired into `prestart.sh` right after `alembic upgrade head`, before `initial_data.py`. **No `hierarchy.yaml` present is a silent no-op** — every deployment without one is completely unaffected.
- Added `pyyaml`/`types-PyYAML` deps.

## Phase 1 — pingsvc client role (PRs #43, #44, #45, merged to `main`)

**PR #43 — `-role` flag** (`pingsvc/cmd/pingsvc/role.go`, `main.go`)
- `Role` type (`pingsvc`/`exporter`/`both`), `ParseRole` validates, `RunsPingPipeline()`/`RunsExporter()` predicates.
- `-role` flag defaults to `pingsvc` (byte-identical current behavior). Ping pipeline (worker pool, batcher, ticker) is skipped via an early-return guard when the role doesn't include it, rather than a full restructuring of `main()`. Exporter path was a log-only stub in this PR, replaced by real logic in #45.
- Verified via a runtime smoke test (`main()` itself has no unit tests): `-role=bogus` exits 1, `-role=exporter` disables the pipeline entirely, `-role=both` runs both, default behavior unchanged.

**PR #44 — real `NodeID` ancestor chains in targets** (`pingsvc/cmd/pingsvc/main.go`, `util_test.go`)
- `Target` reshaped from dead `{Addr, RoomID, BldgID}` (never actually constructed anywhere in the codebase — confirmed by grep before touching it) to `{Addr string, NodeIDs []string}`.
- `loadTargets` now returns `[]Target` and parses an optional richer line format: `addr,ancestor1;ancestor2;...`. Bare-IP lines (no comma) stay fully backward compatible — `generate_targets.sh`'s output needs no changes.
- The ancestor chain now flows into every `Event` the worker pool builds (both ping-error paths and the success path) via an `addr -> NodeIDs` map built once at startup.
- Verified end-to-end against a real Redis: a target `127.0.0.1,campus-1;building-2;room-3` produced `stats:node:campus-1`/`building-2`/`room-3` all `up:1`; an ancestor-less target created no node stats.

**PR #45 — `runExporter`** (`pingsvc/cmd/pingsvc/exporter.go`, `exporter_test.go`, `main.go`)
- `Snapshot{ZoneID, TS, Nodes map[string]NodeCounts, Devices map[string]DeviceState}` — the periodic export payload. `buildSnapshot` reads `stats:node:*` (via `KEYS`+`HGETALL`) and `pings:state` from Redis, pure data-gathering, no disk I/O, so it's unit-testable against miniredis alone.
- `writeSnapshotToSpool` gzip-encodes the JSON to `<spool-dir>/<unix_ts>.json.gz`.
- `runExporter(ctx, rdb, cfg) func()` starts an independent goroutine on its own ticker (deliberately no shared channels with the ping pipeline, so a slow export cycle can't backpressure ping workers) and returns a `stop func()` that cancels and waits cleanly.
- New flags: `-zone-id`, `-export-interval` (default 30s), `-spool-dir` (default `/var/lib/argus/pending`). New metrics: `pings_exporter_snapshots_written_total`, `pings_exporter_errors_total`, plus a spool-depth gauge.
- **No object-storage push yet** — intentional, matches the plan's Phase 1 scope exactly ("prove snapshot generation," not ship the S3 integration). The spool becomes the retry buffer once Phase 2 adds the real push.
- Verified end-to-end with `role=both`: exporter wrote a new snapshot every ~1s while the ping pipeline ran concurrently on its own 500ms interval; clean shutdown, no hang.

## Phase 2 — object storage transport (PRs #48, #49, merged to `main`)

**PR #48 — S3-compatible object storage push** (`pingsvc/cmd/pingsvc/objectstore.go`, `exporter.go`, `main.go`)
- `ObjectStore` interface + `S3ObjectStore` backed by `aws-sdk-go-v2`. `Endpoint` is configurable (empty = real AWS S3; set for MinIO/S3-compatible endpoints). Credentials are optional — falls back to the AWS SDK's default credential chain (env vars, shared config, IAM role) when unset, matching the plan's scoped-IAM-credential recommendation (§4.4).
- `objectKeyForSpoolFile` derives `{tenant_id}/{zone_id}/YYYY/MM/DD/HH/<ts>.json.gz` from the timestamp already embedded in the spool filename.
- `flushSpool` pushes every spooled file oldest-first, stopping at the first failed push rather than hammering a possibly-down endpoint every cycle, and removes files only on success — implements the plan's "retry oldest-first on next tick" spec exactly.
- `ExporterConfig.Store` is optional (`nil` = Phase 1's exact spool-only behavior, unchanged). New flags: `-tenant-id`, `-s3-bucket` (empty disables push entirely), `-s3-region`, `-s3-endpoint`, `-s3-access-key`/`-s3-secret-key`.
- Verified end-to-end against a real MinIO container: 5 real snapshots landed in a live bucket with exactly the specified key structure.

**PR #49 — Ed25519 payload signing** (`pingsvc/cmd/pingsvc/signature.go`)
- `Manifest{PayloadHash, TS, PublicKey, Signature}` — IAM proves *who* wrote an object; this proves *what* they wrote hasn't been tampered with or replayed (plan §4.4).
- `signManifest`/`verifyManifest` (sha256 + ed25519), paired so the signing scheme is round-trip tested rather than re-derived later.
- `loadOrGenerateSigningKey` generates a key once and persists it to disk — a changing key every restart would defeat the point of a server registering it once.
- `flushSpool` pushes a signed `<key>.manifest.json` alongside each snapshot when a `Signer` is configured (new `ExporterConfig.Signer`, optional). A manifest push failure counts as failure of the whole file (stays in spool, retries both objects next cycle — harmless since object keys are immutable).
- New `-signing-key-path` flag, empty by default (signing disabled).
- Verified end-to-end against real MinIO: downloaded and inspected an actual manifest object — structurally correct 64-hex sha256 hash, 64-hex ed25519 public key, 128-hex signature.
- **This completes Phase 2's application-code scope.** Actual IAM/bucket provisioning (a "small internal admin tool" per the plan) is ops/Terraform tooling, not pingsvc code, and hasn't been built.

## Phase 3 — argus-server ingestion (PRs #50, #51 merged to `main`; #52 open)

**PR #50 — `ClientSnapshot`/`ZoneSummary`/`ZoneSigningKey` data model** (`backend/app/models.py`, `backend/app/crud.py`, migration `b3c4d5e6f7a8_...`)
- `ClientSnapshot(tenant_id, zone_id, snapshot_ts, storage_key [unique], nodes_json, devices_json, signature_verified, pulled_at)` — one row per ingested S3 object; the unique `storage_key` is the idempotency guard.
- `ZoneSummary(tenant_id, zone_id, up_count, down_count, last_snapshot_ts, last_pulled_at)` — upserted (not appended) per `(tenant_id, zone_id)`, independent of any zone's hierarchy shape.
- `ZoneSigningKey(tenant_id, zone_id, public_key_hex)` — registered public keys for manifest verification; rotation replaces the key in place.
- **Deviates from the plan's original `hierarchy_json` sketch**: pingsvc's actual exported `Snapshot` (Phases 1-2) is `{zone_id, ts, nodes, devices}` with no hierarchy shape data at all, since pingsvc has no connection to the backend's `Node`/`NodeType` model. `ClientSnapshot` matches what pingsvc really produces — documented in the model's own comments.
- Along the way: `VARCHAR(1024)` unique index on `storage_key` exceeded MySQL InnoDB's 3072-byte key-length limit under `utf8mb4`; reduced to 512.

**PR #51 — the ingestion job** (`backend/app/core/ingestion.py`, wired into `backend/app/main.py`'s lifespan)
- `parse_storage_key`, `verify_manifest` (sha256 + ed25519 in Python via `cryptography` — **always verifies against the registered `ZoneSigningKey`, never the manifest's own embedded public key**, since trusting an attacker-supplied key would defeat the entire point of out-of-band registration), `ingest_object` (idempotent; best-effort verification — unregistered zone leaves `signature_verified=None`/unknown, registered-but-invalid marks `False` but still stores the data), `run_ingestion_cycle` (lists the bucket, skips `.manifest.json` companions and already-seen keys), `ingestion_task` (background loop mirroring `redis_listener_task`'s shape; boto3 is sync, so each cycle runs via `asyncio.to_thread`).
- No-ops entirely if `S3_BUCKET` isn't configured (new settings: `S3_BUCKET`/`S3_REGION`/`S3_ENDPOINT`/`S3_ACCESS_KEY`/`S3_SECRET_KEY`/`INGESTION_INTERVAL_SECONDS`). New deps: `boto3`, `moto[s3]` (test-only).
- Up/down counts for `ZoneSummary` are derived from `devices` (one entry per device), not summed across `nodes` — `nodes` is an ancestor rollup, so a single device is counted under every ancestor id simultaneously and summing it would wildly over-count.
- **Bug caught by the end-to-end smoke test, not unit tests**: `snapshot_ts` used a plain MySQL `INT` (32-bit), but pingsvc's real millisecond timestamps are 13 digits — overflow. Test fixtures used small values like `1000`, which never exercised this; only surfaced once a real pingsvc binary's real output was fed through the ingestion job. Fixed with `BigInteger` on `ClientSnapshot.snapshot_ts` and `ZoneSummary.last_snapshot_ts`.
- Verified full pipeline end-to-end: real pingsvc binary (signed) → real MinIO bucket → backend ingestion → MySQL, with `signature_verified=True` and correct up/down counts.

**PR #52 — staleness tracking** (`backend/app/crud.py`, `backend/app/core/ingestion.py`, new `backend/app/api/routes/zones.py`)
- `crud.get_stale_zones` queries `ZoneSummary` rows past a threshold using `last_pulled_at`.
- `is_zone_stale` (pure predicate) and `check_and_log_stale_zones` (logs a warning per stale zone) wired into `ingestion_task`'s poll loop — the "zone went dark" signal from plan §4.5, since a zone's own WAN outage means it can't self-report.
- New `GET /api/v1/zones/summary` route — the first way to observe `ZoneSummary`/zone health via the API at all, with a computed `is_stale` field. New setting `STALENESS_THRESHOLD_SECONDS` (default 120s, one global default — no per-zone push-interval registration exists yet).
- **Bug caught by an HTTP-round-trip test, not crud-level tests**: MySQL round-trips `DateTime(timezone=True)` columns as *naive* datetimes (no native tz-aware type) even though the app always writes `datetime.now(timezone.utc)`. Crud-level tests compared against in-memory objects that never round-tripped through a fresh query, so they missed it; the route test (real HTTP request → DB write → DB read) caught it. Fixed by treating a naive `last_pulled_at` as UTC.
- **This completes Phase 3.**

## What's next

Phase 4 — a frontend zone selector so an operator can view a specific zone's dashboard, reusing the existing per-level pages against whichever zone is selected (plan §4.6) — has not been started.
