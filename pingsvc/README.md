# Ping Service (pingsvc)

Go script pinging 20k+ devices. It uses [`goroutine`](https://go.dev/tour/concurrency/1) for concurency. It also publishes state changes as events in batches and timeouts to redis pub/sub channels. 
## 

- Publishes ping events to Redis channel `pings:events`
- Stores latest ping state in Redis hash `pings:state`
- Configurable via command-line flags or environment variables
- Docker-ready with health checks

## Configuration

```bash
-redis  // REDIS_URL
-interval // ping interval per host
-timeout // per-host timeout
-targets // text file containing targets
-workers // goroutine worker count. def 50
-batch // redis batch size. def 500
-batch-flush-ms // redis batch flush in milliseconds. def 200 

```

If no targets file is provided, it defaults to pinging `8.8.8.8` and `1.1.1.1`.

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

### Building Locally

```bash
cd pingsvc
go build -o pingsvc ./cmd/pingsvc
./pingsvc -redis localhost:6379 -targets targets.txt
```

## Health Check

The service includes a Docker health check that verifies the pingsvc process is running.
