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

```

If no targets file is provided, it defaults to pinging `8.8.8.8` and `1.1.1.1`.

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
