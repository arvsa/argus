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

You can generate dummy targets by running

```bash
chmod +x pingsvc/generate_targets.sh
./pingsvc/generate_targets.sh
```
Then run: 

```bash
docker compose up pingsvc -d
```

Auto starts the redis but does not destroy it!

### Redis Events

To subscribe to ping events in real-time:
Í
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
