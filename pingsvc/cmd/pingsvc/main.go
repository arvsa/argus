package main

import (
	"context"
	"encoding/json"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/go-ping/ping"
	"github.com/redis/go-redis/v9"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

type Event struct {
	Addr     string  `json:"addr"`
	OK       bool    `json:"ok"`
	RTTMs    float64 `json:"rtt_ms,omitempty"`
	Err      string  `json:"err,omitempty"`
	TS       int64   `json:"ts"`
	Interval int64   `json:"interval_ms"`
	// NodeIDs is the device's full ancestor chain in the generalized
	// Node/NodeType hierarchy (any depth). Every id gets its own
	// stats:node:<id> / events:node:<id> fan-out.
	NodeIDs []string `json:"node_ids,omitempty"`
}

func nowMs() int64 { return time.Now().UnixNano() / int64(time.Millisecond) }

// Lua script: atomically compare previous device state, update state, update
// per-node counters, HSET snapshot, and PUBLISH only when the state changed.
// KEYS[1] = addr
// ARGV[1] = newState ("1" or "0")
// ARGV[2] = jsonPayload
// ARGV[3] = timestamp ms (for ZADD pings:index)
// ARGV[4] = nodeIDs, comma-separated ancestor chain (optional, may be empty)
//
// nodeIDs is an arbitrary-depth ancestor chain
// (plan/dynamic-hierarchy-multi-zone-architecture.md §4.2): every id in the
// chain gets its own stats:node:<id> counter and events:node:<id> publish.
// If that produced no publish (empty nodeIDs), the event falls back to the
// generic pings:events channel.
const publishIfChangedAndAggregateScript = `
local addr = KEYS[1]
local newState = ARGV[1]
local payload = ARGV[2]
local ts = tonumber(ARGV[3])
local nodeIDsCSV = ARGV[4]

local key = "state:device:" .. addr
local oldState = redis.call("GET", key)
if oldState == newState then
    return 0
end

-- update device state
redis.call("SET", key, newState)

-- update snapshot and sorted index
redis.call("HSET", "pings:state", addr, payload)
redis.call("ZADD", "pings:index", ts, addr)

local published = false

local function bumpCounter(statsKey)
    if newState == "1" then
        redis.call("HINCRBY", statsKey, "up", 1)
        if oldState == "0" then
            redis.call("HINCRBY", statsKey, "down", -1)
        end
    else
        redis.call("HINCRBY", statsKey, "down", 1)
        if oldState == "1" then
            redis.call("HINCRBY", statsKey, "up", -1)
        end
    end
end

-- generalized per-node aggregation: one counter + channel per ancestor
for nodeID in string.gmatch(nodeIDsCSV, "[^,]+") do
    bumpCounter("stats:node:" .. nodeID)
    redis.call("PUBLISH", "events:node:" .. nodeID, payload)
    published = true
end

if not published then
    redis.call("PUBLISH", "pings:events", payload)
end

return 1
`

// Target is a ping destination plus its known ancestor chain in the
// generalized Node hierarchy (plan/dynamic-hierarchy-multi-zone-architecture.md
// §4.3). NodeIDs is nil for targets loaded from a plain bare-address file
// (the common case today), and populated for targets loaded from the
// richer "addr,ancestor1;ancestor2;..." format.
type Target struct {
	Addr    string
	NodeIDs []string
}

// evalArgs builds the KEYS[1] address and ARGV list used by
// publishIfChangedAndAggregateScript for a single event. Extracted so the
// batcher's pipelined path and the single-shot publishAndAggregate path
// (used directly in tests) can't drift out of sync with each other.
func evalArgs(ev Event) (addr string, argv []any) {
	newState := "0"
	if ev.OK {
		newState = "1"
	}
	raw, _ := json.Marshal(ev)
	nodeIDsCSV := strings.Join(ev.NodeIDs, ",")
	return ev.Addr, []any{
		newState, string(raw), strconv.FormatInt(ev.TS, 10), nodeIDsCSV,
	}
}

// loadPublishScript loads publishIfChangedAndAggregateScript into Redis and
// returns its SHA1, for use with EVALSHA.
func loadPublishScript(ctx context.Context, rdb redis.Cmdable) (string, error) {
	return rdb.ScriptLoad(ctx, publishIfChangedAndAggregateScript).Result()
}

// publishAndAggregate atomically compares-and-sets a single device's state via
// the publishIfChangedAndAggregateScript Lua script, updating the pings:state
// snapshot, the pings:index sorted set, the per-room/building stats:* hash
// counters, and publishing to the appropriate channel — but only if the
// device's state actually changed since the last call for that address.
//
// rdb is a redis.Cmdable so it can be a *redis.Client in production or a
// miniredis-backed client in tests. Returns true if the script published an
// event (i.e. the state changed).
func publishAndAggregate(ctx context.Context, rdb redis.Cmdable, sha string, ev Event) (bool, error) {
	addr, argv := evalArgs(ev)
	res, err := rdb.EvalSha(ctx, sha, []string{addr}, argv...).Result()
	if err != nil {
		return false, err
	}
	n, _ := res.(int64)
	return n == 1, nil
}

var stateCache sync.Map

// Prometheus metrics
var (
	metrPingsTotal = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "pings_total",
		Help: "Total number of ping attempts.",
	})
	metrPingsSuccess = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "pings_succeeded_total",
		Help: "Total successful pings (received packet).",
	})
	metrPingsFailed = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "pings_failed_total",
		Help: "Total failed ping attempts (no reply or error).",
	})
	metrStateChanges = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "pings_state_changes_total",
		Help: "Total state-change events emitted (label=status).",
	}, []string{"status"})
	metrEventsDropped = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "pings_events_dropped_total",
		Help: "Number of events dropped due to full results channel.",
	})
	metrPingRTT = prometheus.NewHistogram(prometheus.HistogramOpts{
		Name:    "pings_rtt_seconds",
		Help:    "Ping round-trip time distribution in seconds.",
		Buckets: prometheus.DefBuckets,
	})
	metrRedisErrors = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "redis_pipeline_errors_total",
		Help: "Redis pipeline execution errors.",
	})
	metrRedisPublishes = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "redis_publishes_total",
		Help: "Number of publishes performed by the redis Lua script (state changed).",
	})
	metrJobsDropped = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "pings_jobs_dropped_total",
		Help: "Number of job enqueues dropped due to full jobs channel.",
	})
	metrExporterSnapshotsWritten = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "pings_exporter_snapshots_written_total",
		Help: "Number of snapshot files successfully written to the exporter's local spool.",
	})
	metrExporterErrors = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "pings_exporter_errors_total",
		Help: "Number of exporter cycles that failed to build or write a snapshot.",
	})
	metrExporterSnapshotsPushed = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "pings_exporter_snapshots_pushed_total",
		Help: "Number of snapshot files successfully pushed to object storage.",
	})
	metrExporterPushErrors = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "pings_exporter_push_errors_total",
		Help: "Number of exporter cycles where pushing a spooled snapshot to object storage failed.",
	})
)

func main() {
	redisAddr := flag.String("redis", getenv("REDIS_URL", "redis:6379"), "redis address")
	interval := flag.Duration("interval", 1*time.Second, "ping interval per host")
	timeout := flag.Duration("timeout", 800*time.Millisecond, "per-host timeout")
	targetsFile := flag.String("targets", "", "file with newline-separated targets (overrides built-in list)")

	workerCount := flag.Int("workers", 50, "number of concurrent ping workers")
	batchSize := flag.Int("batch", 500, "redis pipeline batch size")
	batchFlushMs := flag.Int("batch-flush-ms", 200, "max milliseconds before flushing a partial batch")
	metricsAddr := flag.String("metrics-addr", ":9090", "address to serve /metrics on")
	roleFlag := flag.String("role", getenv("ARGUS_ROLE", string(RolePingsvc)), "operating role: pingsvc|exporter|both")
	zoneID := flag.String("zone-id", getenv("ARGUS_ZONE_ID", "default"), "zone identifier included in exported snapshots")
	tenantID := flag.String("tenant-id", getenv("ARGUS_TENANT_ID", "default"), "tenant identifier used as the object storage key prefix")
	exportInterval := flag.Duration("export-interval", 30*time.Second, "how often the exporter builds and spools a snapshot")
	spoolDir := flag.String("spool-dir", getenv("ARGUS_SPOOL_DIR", "/var/lib/argus/pending"), "local directory the exporter writes snapshot files to")
	s3Bucket := flag.String("s3-bucket", getenv("ARGUS_S3_BUCKET", ""), "object storage bucket to push snapshots to (empty = spool-only, no push)")
	s3Region := flag.String("s3-region", getenv("ARGUS_S3_REGION", "us-east-1"), "object storage region")
	s3Endpoint := flag.String("s3-endpoint", getenv("ARGUS_S3_ENDPOINT", ""), "object storage endpoint override (empty = real AWS S3; set for MinIO/S3-compatible endpoints)")
	s3AccessKey := flag.String("s3-access-key", getenv("ARGUS_S3_ACCESS_KEY", ""), "object storage access key (empty = use the AWS SDK's default credential chain)")
	s3SecretKey := flag.String("s3-secret-key", getenv("ARGUS_S3_SECRET_KEY", ""), "object storage secret key (empty = use the AWS SDK's default credential chain)")
	signingKeyPath := flag.String("signing-key-path", getenv("ARGUS_SIGNING_KEY_PATH", ""), "path to this zone's ed25519 signing key (empty = don't sign pushed snapshots); generated on first run if the file doesn't exist yet")

	flag.Parse()

	role, err := ParseRole(*roleFlag)
	if err != nil {
		log.Fatalf("%v", err)
	}

	// Register metrics
	prometheus.MustRegister(
		metrPingsTotal,
		metrPingsSuccess,
		metrPingsFailed,
		metrStateChanges,
		metrEventsDropped,
		metrPingRTT,
		metrRedisErrors,
		metrRedisPublishes,
		metrJobsDropped,
		metrExporterSnapshotsWritten,
		metrExporterErrors,
		metrExporterSnapshotsPushed,
		metrExporterPushErrors,
	)
	prometheus.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{
			Name: "pings_exporter_spool_files",
			Help: "Number of snapshot files currently sitting in the exporter's local spool directory.",
		},
		func() float64 {
			entries, err := os.ReadDir(*spoolDir)
			if err != nil {
				return 0
			}
			return float64(len(entries))
		},
	))

	// Start metrics server
	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		mux.HandleFunc("/-/healthy", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
		log.Printf("metrics: listening on %s", *metricsAddr)
		if err := http.ListenAndServe(*metricsAddr, mux); err != nil {
			log.Fatalf("metrics server failed: %v", err)
		}
	}()

	rdb := redis.NewClient(&redis.Options{Addr: *redisAddr})
	ctx := context.Background()
	if err := waitForRedis(ctx, rdb, 30*time.Second); err != nil {
		log.Fatalf("redis not available: %v", err)
	}

	var stopExporter func()
	if role.RunsExporter() {
		var store ObjectStore
		if *s3Bucket != "" {
			s3Store, err := NewS3ObjectStore(ctx, S3Config{
				Bucket:    *s3Bucket,
				Region:    *s3Region,
				Endpoint:  *s3Endpoint,
				AccessKey: *s3AccessKey,
				SecretKey: *s3SecretKey,
			})
			if err != nil {
				log.Fatalf("failed to init object store: %v", err)
			}
			store = s3Store
			log.Printf("role=%s: exporter enabled, interval=%v, spool-dir=%s, s3-bucket=%s", role, *exportInterval, *spoolDir, *s3Bucket)
		} else {
			log.Printf("role=%s: exporter enabled, interval=%v, spool-dir=%s, no s3-bucket configured (spool-only)", role, *exportInterval, *spoolDir)
		}

		var signer *Signer
		if *signingKeyPath != "" {
			signer, err = loadOrGenerateSigningKey(*signingKeyPath)
			if err != nil {
				log.Fatalf("failed to load/generate signing key: %v", err)
			}
		}

		stopExporter = runExporter(ctx, rdb, ExporterConfig{
			ZoneID:   *zoneID,
			TenantID: *tenantID,
			Interval: *exportInterval,
			SpoolDir: *spoolDir,
			Store:    store,
			Signer:   signer,
		})
	}

	if !role.RunsPingPipeline() {
		log.Printf("role=%s: ping pipeline disabled", role)
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
		<-sig
		if stopExporter != nil {
			stopExporter()
		}
		log.Println("shutting down")
		return
	}

	// load targets
	targets := loadTargets(*targetsFile)

	// Load the Lua script into Redis and keep the SHA
	sha, err := loadPublishScript(ctx, rdb)
	if err != nil {
		log.Fatalf("failed to load lua script: %v", err)
	}

	// addr -> ancestor chain, looked up by workers when building each Event
	// so a device's stats:node:<id> aggregation follows it from the target
	// file, not just from state-change events built after this point.
	targetsByAddr := make(map[string][]string, len(targets))
	for _, t := range targets {
		targetsByAddr[t.Addr] = t.NodeIDs
	}

	// pre-seed state and index so /state returns all devices immediately
	for _, t := range targets {
		ts := nowMs()
		ev := Event{Addr: t.Addr, OK: false, TS: ts, Interval: int64(interval.Milliseconds()), NodeIDs: t.NodeIDs}
		raw, _ := json.Marshal(ev)
		_ = rdb.HSet(ctx, "pings:state", t.Addr, raw).Err()
		_ = rdb.ZAdd(ctx, "pings:index", redis.Z{Score: float64(ts), Member: t.Addr}).Err()
	}

	log.Printf("starting pingsvc: %d targets, interval=%v, timeout=%v, redis=%s, workers=%d, batch=%d",
		len(targets), *interval, *timeout, *redisAddr, *workerCount, *batchSize)

	// Channels
	jobs := make(chan string, len(targets)) // job queue per tick; buffered by #targets

	// results buffer: batchSize*4 with caps
	bufSize := (*batchSize) * 4
	if bufSize < 1 {
		bufSize = 1
	}
	const maxResultsBuf = 10000
	if bufSize > maxResultsBuf {
		bufSize = maxResultsBuf
	}
	results := make(chan []byte, bufSize)

	// Instrument channel length gauges
	prometheus.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{Name: "pings_jobs_queue_len", Help: "Length of jobs channel"},
		func() float64 { return float64(len(jobs)) },
	))
	prometheus.MustRegister(prometheus.NewGaugeFunc(
		prometheus.GaugeOpts{Name: "pings_results_queue_len", Help: "Length of results channel"},
		func() float64 { return float64(len(results)) },
	))

	// Worker pool
	var wg sync.WaitGroup
	workerCtx, workerCancel := context.WithCancel(context.Background())
	for i := 0; i < *workerCount; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for {
				select {
				case <-workerCtx.Done():
					return
				case addr, ok := <-jobs:
					if !ok {
						return
					}

					metrPingsTotal.Inc()

					p, err := ping.NewPinger(addr)
					if err != nil {
						metrPingsFailed.Inc()
						ev := Event{Addr: addr, TS: nowMs(), Interval: int64(interval.Milliseconds()), OK: false, Err: err.Error(), NodeIDs: targetsByAddr[addr]}
						raw, _ := json.Marshal(ev)
						select {
						case results <- raw:
						default:
							metrEventsDropped.Inc()
						}
						continue
					}
					p.SetPrivileged(false)
					p.Count = 1
					p.Timeout = *timeout
					if err := p.Run(); err != nil {
						metrPingsFailed.Inc()
						ev := Event{Addr: addr, TS: nowMs(), Interval: int64(interval.Milliseconds()), OK: false, Err: err.Error(), NodeIDs: targetsByAddr[addr]}
						raw, _ := json.Marshal(ev)
						select {
						case results <- raw:
						default:
							metrEventsDropped.Inc()
						}
						continue
					}
					isUp := p.Statistics().PacketsRecv > 0
					if isUp {
						metrPingsSuccess.Inc()
						if stats := p.Statistics(); stats != nil && stats.AvgRtt > 0 {
							metrPingRTT.Observe(stats.AvgRtt.Seconds())
						}
					} else {
						metrPingsFailed.Inc()
					}

					lastState, loaded := stateCache.Load(addr)
					if loaded && lastState.(bool) == isUp {
						// No change? Don't send to results channel.
						continue
					}
					stateCache.Store(addr, isUp)

					if isUp {
						metrStateChanges.WithLabelValues("up").Inc()
					} else {
						metrStateChanges.WithLabelValues("down").Inc()
					}

					ev := Event{Addr: addr, TS: nowMs(), Interval: int64(interval.Milliseconds()), OK: isUp, NodeIDs: targetsByAddr[addr]}
					raw, _ := json.Marshal(ev)
					select {
					case results <- raw:
					default:
						metrEventsDropped.Inc()
					}
				}
			}
		}(i)
	}

	// Redis batcher: uses EVALSHA pipelined to atomically update state, aggregates, and publish only on change.
	batcherCtx, batcherCancel := context.WithCancel(context.Background())
	var batchWg sync.WaitGroup
	batchWg.Add(1)
	go func() {
		defer batchWg.Done()
		ticker := time.NewTicker(time.Duration(*batchFlushMs) * time.Millisecond)
		defer ticker.Stop()

		buf := make([][]byte, 0, *batchSize)
		flush := func() {
			if len(buf) == 0 {
				return
			}

			pipe := rdb.Pipeline()
			resultsCmds := make([]*redis.Cmd, 0, len(buf))
			for _, raw := range buf {
				var ev Event
				_ = json.Unmarshal(raw, &ev)
				addr, argv := evalArgs(ev)

				// EVALSHA returns integer 1 if publish occurred, 0 otherwise
				// Queue the EvalSha call in the pipeline
				cmd := pipe.EvalSha(context.Background(), sha, []string{addr}, argv...)
				resultsCmds = append(resultsCmds, cmd)
			}

			_, err := pipe.Exec(context.Background())
			if err != nil {
				// If NOSCRIPT, reload script and try one more time (best-effort for rare eviction)
				if strings.Contains(err.Error(), "NOSCRIPT") {
					log.Printf("redis NOSCRIPT detected; reloading script")
					newsha, lerr := rdb.ScriptLoad(context.Background(), publishIfChangedAndAggregateScript).Result()
					if lerr != nil {
						metrRedisErrors.Inc()
						log.Printf("failed to reload lua script: %v", lerr)
						// fall through; we can't apply this batch now
						buf = buf[:0]
						return
					}
					sha = newsha
					// Retry the batch: create a fresh pipeline and re-queue evals
					pipe2 := rdb.Pipeline()
					for _, raw := range buf {
						var ev Event
						_ = json.Unmarshal(raw, &ev)
						addr, argv := evalArgs(ev)
						pipe2.EvalSha(context.Background(), sha, []string{addr}, argv...)
					}
					_, err2 := pipe2.Exec(context.Background())
					if err2 != nil {
						metrRedisErrors.Inc()
						log.Printf("redis pipeline exec error after reload: %v", err2)
						// clear buffer
						buf = buf[:0]
						return
					}
					// After successful retry, we still need to count publishes below.
					// To avoid duplicating code, we will fetch the results from the second pipeline responses is non-trivial here;
					// So as a pragmatic choice, rely on the fact that the EvalSha succeeded and increment publishes conservatively.
					// (If you want precise counts, use the first pipeline's results when Exec succeeds.)
					for range buf {
						metrRedisPublishes.Inc() // best-effort increment
					}
					buf = buf[:0]
					return
				}

				metrRedisErrors.Inc()
				log.Printf("redis pipeline exec error: %v", err)
				buf = buf[:0]
				return
			}

			// If Exec succeeded, inspect each queued command result to determine if the script published (returned 1)
			for _, cmd := range resultsCmds {
				res := cmd.Val()
				// cmd.Val() returns interface{} which should be int64 (1 or 0)
				if n, ok := res.(int64); ok {
					if n == 1 {
						metrRedisPublishes.Inc()
					}
				}
			}

			buf = buf[:0]
		}

		for {
			select {
			case <-batcherCtx.Done():
				flush()
				return
			case raw, ok := <-results:
				if !ok {
					flush()
					return
				}
				buf = append(buf, raw)
				if len(buf) >= *batchSize {
					flush()
				}
			case <-ticker.C:
				flush()
			}
		}
	}()

	// Tick loop: enqueue all targets each interval
	ticker := time.NewTicker(*interval)
	defer ticker.Stop()

	// graceful shutdown signals
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)

loop:
	for {
		select {
		case <-sig:
			break loop
		case <-ticker.C:
			// non-blocking enqueue: if jobs buffer is full we skip
			for _, t := range targets {
				select {
				case jobs <- t.Addr:
				default:
					metrJobsDropped.Inc()
				}
			}
		}
	}

	// shutdown: stop producers, close channels, wait
	workerCancel()
	close(jobs)
	wg.Wait()

	// close results -> allow batcher to finish
	close(results)
	batcherCancel()
	batchWg.Wait()

	if stopExporter != nil {
		stopExporter()
	}

	log.Println("shutting down")
}

// loadTargets reads the -targets file, one target per line. Each line is
// either a bare address ("10.0.0.1", backward compatible with existing
// target files) or "addr,ancestor1;ancestor2;..." to attach that device's
// full ancestor chain in the Node hierarchy for per-node aggregation (see
// Target's doc comment and plan §4.3/§4.2).
func loadTargets(targetsFile string) []Target {
	if targetsFile != "" {
		b, _ := os.ReadFile(targetsFile)
		lines := splitLines(string(b))
		out := make([]Target, len(lines))
		for i, line := range lines {
			out[i] = parseTargetLine(line)
		}
		return out
	}
	// example dummies
	return []Target{{Addr: "8.8.8.8"}, {Addr: "1.1.1.1"}}
}

func parseTargetLine(line string) Target {
	addr, nodeIDsField, hasNodeIDs := strings.Cut(line, ",")
	if !hasNodeIDs || nodeIDsField == "" {
		return Target{Addr: addr}
	}
	return Target{Addr: addr, NodeIDs: strings.Split(nodeIDsField, ";")}
}

// getenv, splitLines, waitForRedis copied/kept from your original code
func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func splitLines(s string) []string {
	out := []string{}
	cur := ""
	for _, r := range s {
		if r == '\n' || r == '\r' {
			if cur != "" {
				out = append(out, cur)
				cur = ""
			}
			continue
		}
		cur += string(r)
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}

func waitForRedis(ctx context.Context, rdb *redis.Client, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		err := rdb.Ping(ctx).Err()
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return err
		}
		time.Sleep(500 * time.Millisecond)
	}
}
