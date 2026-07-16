# Ping Service (pingsvc)

Go service pinging thousands of devices concurrently via ICMP. It uses
[`goroutine`](https://go.dev/tour/concurrency/1) worker pools for
concurrency, and publishes state changes (not every ping) as batched events
to Redis pub/sub channels via a Lua script that atomically diffs previous
state. See [../CLAUDE.md](../CLAUDE.md) for how this fits into the full
ping pipeline.

- Publishes ping events to Redis channel `pings:events` (plus scoped
  `events:node:<id>` channels)
- Stores latest ping state in Redis hash `pings:state`, and aggregated
  up/down counters in `stats:node:<id>`
- Configurable via command-line flags or environment variables
- Exposes Prometheus metrics at `:9090/metrics`
- Docker-ready with health checks

## Requirements

- Go 1.24+ (see `go.mod`)
- A reachable Redis instance

## Configuration

```bash
-redis  // REDIS_URL
-interval // ping interval per host
-timeout // per-host timeout
-targets // text file containing targets
-workers // goroutine worker count. def 50
-batch // redis batch size. def 500
-batch-flush-ms // redis batch flush in milliseconds. def 200
-metrics-addr // address to serve /metrics on. def :9090
-role // pingsvc | exporter | both (ARGUS_ROLE). def pingsvc
-backend-url // this zone's own backend, e.g. http://backend:8000 (ARGUS_BACKEND_URL). empty = target hot-reload disabled
-sync-token // shared secret for the backend's targets-hash/targets-export-internal routes (ARGUS_PINGSVC_SYNC_TOKEN)
-sync-interval // how often to poll the backend for target-list changes (ARGUS_TARGET_SYNC_INTERVAL_SECONDS). def 30s
```

If no targets file is provided, it defaults to pinging `8.8.8.8` and `1.1.1.1`.

## Exporter / `argus-client` role

`-role`/`ARGUS_ROLE` gates which subsystems run in this process:

- `pingsvc` (default) — just the ping pipeline above.
- `exporter` — just the independent goroutine that periodically signs and
  pushes an aggregated snapshot to S3-compatible object storage.
- `both` — both at once; this is what makes a deployment a full
  `argus-client` zone.

`both`/`exporter` need `ARGUS_ZONE_ID`, `ARGUS_TENANT_ID`, `ARGUS_S3_BUCKET`
(+ endpoint/keys for non-AWS S3), and `ARGUS_SIGNING_KEY_PATH` pointed at a
persistent volume — full variable reference in
[../deployment.md](../deployment.md#deploying-a-zone-argus-client). Real
ICMP also needs the `NET_RAW`/`NET_ADMIN` capabilities added to the
container (`cap_add:` in `compose.yml`/`swarm/stack.client.yml`) — without
them every device reports down. See
[../development.md](../development.md#running-a-full-argus-client--argus-server-locally)
for a full local walkthrough of both roles talking to each other.

## Target hot-reload

By default pingsvc reads its target list from `-targets` once at startup --
picking up a device/hierarchy change from the backend (see
`plan/device-node-assignment-bridge-v1.md`) otherwise requires a manual
`scripts/regenerate-targets.sh` + restart.

Setting `-backend-url`/`ARGUS_BACKEND_URL` (this zone's own backend, e.g.
`http://backend:8000` in Compose, `http://<stack-name>_backend:8000` in
Swarm) turns on an independent goroutine that polls the backend's
`GET /devices/targets-hash` every `-sync-interval` (default 30s) and only
fetches the full `GET /devices/targets-export-internal` body when the hash
has actually changed, then hot-swaps the live target list with no restart.
Both routes are gated by `-sync-token`/`ARGUS_PINGSVC_SYNC_TOKEN`, which
must match the backend's own `PINGSVC_SYNC_TOKEN` -- pingsvc has no user
account, so this is a separate shared secret from the human JWT every other
route uses. Off by default (empty `ARGUS_BACKEND_URL`), same opt-in posture
as the exporter's S3 config.

A successful reload also overwrites the local `-targets` file with the
fetched body (so a later real restart picks up the same state) and runs the
same removed-target Redis cleanup startup already does, so a
deleted/unassigned device stops contributing stale up/down counts within one
sync interval instead of only at the next restart.

## Development

### Building locally

```bash
cd pingsvc
go build -o pingsvc ./cmd/pingsvc
./pingsvc -redis localhost:6379 -targets targets.txt
```

### Tests

```bash
cd pingsvc
go vet ./...
go test ./...
```

Test files live alongside the code in `cmd/pingsvc/` (`util_test.go`,
`redis_test.go`).

### Metrics

Prometheus metrics are served at `:9090/metrics` (configurable via
`-metrics-addr`), including counters for total/successful/failed pings,
state changes, dropped events/jobs, Redis publish/error counts, ping RTT
histogram, and job/result queue depth gauges.

## Usage

### Running with Docker Compose

Run these commands from the **repo root**:

```bash
# Generate targets first — must exist as a file before Docker starts
./pingsvc/generate_targets.sh

# Start pingsvc (also starts redis if not already running)
docker compose up pingsvc -d
```

> **Gotcha:** If `pingsvc/targets.txt` doesn't exist when Docker starts, Docker creates a directory there instead of a file. The service will start but log `0 targets`. Fix: stop the container, `rmdir pingsvc/targets.txt`, generate the file, then `docker compose up pingsvc -d --force-recreate`.

### Redis Events

To subscribe to ping events in real-time:

```bash
docker compose exec redis redis-cli

SUBSCRIBE pings:events
SUBSCRIBE pings:state
```

Events are published as JSON objects with the following structure:

```json
{
  "addr": "8.8.8.8",
  "ok": true,
  "rtt_ms": 12.345,
  "ts": 1642370000000,
  "interval_ms": 1000
}
```

## Health Check

The service includes a Docker health check that verifies the pingsvc process is running.
