# Dynamic Hierarchy & Multi-Zone: Phase 0/1 Implementation Summary

Technical record of what Phase 0 and Phase 1 of `plan/dynamic-hierarchy-multi-zone-architecture.md` actually built. The plan doc describes the design and rationale; this doc records what shipped, in which PRs, with which technical details, so the history survives independently of any one branch (the plan doc's own branch was briefly lost before merge — see PR #46).

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

## What's next

Phase 2 — S3 bucket/prefix layout, IAM credential model (scoped writer + read-only reader per the security-engineer consultation in plan §4.4), Ed25519 payload signing, and the real object-storage push that replaces the bare spool sink — has not been started.
