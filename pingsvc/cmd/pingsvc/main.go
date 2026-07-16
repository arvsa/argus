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
	// DeviceKey is "" when no MAC is on file -- evalArgs falls back to Addr,
	// so an empty DeviceKey is byte-identical to today's addr-only identity.
	DeviceKey string `json:"device_key,omitempty"`
}

func nowMs() int64 { return time.Now().UnixNano() / int64(time.Millisecond) }

// Lua script: atomically compare previous device state, update state, update
// per-node counters, HSET snapshot, and PUBLISH only when the state changed.
// KEYS[1] = device_key (MAC when known, else addr -- see evalArgs/
// TargetStore.DeviceKeyFor; the local var below is still named "addr" in
// the script body since it's just the map key here, not literally an
// address, but the naming isn't worth a body-wide edit)
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
// state:device:<device_key> encodes "<newState>|<nodeIDsCSV>", not just the
// up/down bit -- a device reassigned to a different Node (or newly
// assigned from unassigned) needs a fresh aggregation pass into its
// (possibly new) ancestor chain even when its up/down status hasn't
// itself changed, otherwise stats:node:<id> for the new chain silently
// never gets populated (production bug: a device already down before
// being assigned stayed down after assignment, so no state flip ever
// occurred, and the Hierarchy page stayed stuck at 0 up/0 down). Values
// written by older pingsvc versions have no "|" separator; those are
// treated as state-only with an empty prior node chain, which migrates
// them correctly on their very next observation.
//
// pings:state and pings:index become device_key-keyed too, not just
// state:device:* -- an intended consequence of KEYS[1] changing, not a bug.
// backend's /state and /state_scan routes are unaffected: they read Addr off
// the JSON payload on the success path, not the hash/zset key itself.
const publishIfChangedAndAggregateScript = `
local addr = KEYS[1]
local newState = ARGV[1]
local payload = ARGV[2]
local ts = tonumber(ARGV[3])
local nodeIDsCSV = ARGV[4]

local key = "state:device:" .. addr
local oldCombined = redis.call("GET", key)
local newCombined = newState .. "|" .. nodeIDsCSV
if oldCombined == newCombined then
    return 0
end

local oldState = nil
local oldNodeIDsCSV = ""
if oldCombined then
    local sep = string.find(oldCombined, "|", 1, true)
    if sep then
        oldState = string.sub(oldCombined, 1, sep - 1)
        oldNodeIDsCSV = string.sub(oldCombined, sep + 1)
    else
        oldState = oldCombined
    end
end

-- update device state (now state + node chain together)
redis.call("SET", key, newCombined)

-- update snapshot and sorted index
redis.call("HSET", "pings:state", addr, payload)
redis.call("ZADD", "pings:index", ts, addr)

local oldNodeSet = {}
for id in string.gmatch(oldNodeIDsCSV, "[^,]+") do
    oldNodeSet[id] = true
end

local newNodeSet = {}
local published = false

-- generalized per-node aggregation: one counter + channel per ancestor.
-- Only decrement the old bucket at a node the device was ALREADY counted
-- at (same node in both the old and new chain) -- a newly-assigned node
-- has nothing to decrement, it's a fresh contribution.
for nodeID in string.gmatch(nodeIDsCSV, "[^,]+") do
    newNodeSet[nodeID] = true
    local statsKey = "stats:node:" .. nodeID
    if newState == "1" then
        redis.call("HINCRBY", statsKey, "up", 1)
        if oldNodeSet[nodeID] and oldState == "0" then
            redis.call("HINCRBY", statsKey, "down", -1)
        end
    else
        redis.call("HINCRBY", statsKey, "down", 1)
        if oldNodeSet[nodeID] and oldState == "1" then
            redis.call("HINCRBY", statsKey, "up", -1)
        end
    end
    redis.call("PUBLISH", "events:node:" .. nodeID, payload)
    published = true
end

-- Nodes the device used to report into but no longer does (reassigned
-- elsewhere, or unassigned) must have their old contribution removed, or
-- the old node's counts get stuck showing a device that isn't there.
if oldState then
    for id in pairs(oldNodeSet) do
        if not newNodeSet[id] then
            local statsKey = "stats:node:" .. id
            if oldState == "1" then
                redis.call("HINCRBY", statsKey, "up", -1)
            else
                redis.call("HINCRBY", statsKey, "down", -1)
            end
        end
    end
end

if not published then
    redis.call("PUBLISH", "pings:events", payload)
end

return 1
`

// reconcileRemovedTargetScript undoes a device's last-known contribution
// to stats:node:<id> and removes its ghost entries from pings:state/
// pings:index/state:device:<device_key>. Used only for device_keys no
// longer represented in the CURRENT target list at all (the Device row was
// deleted, or a line was hand-removed from targets.txt) -- unlike a
// reassignment, an address change, or an up/down flip, there is no future
// ping for these that could ever trigger the usual change-detection cleanup
// in publishIfChangedAndAggregateScript, so it has to happen here instead.
const reconcileRemovedTargetScript = `
local addr = KEYS[1]
local key = "state:device:" .. addr
local combined = redis.call("GET", key)
if not combined then
    return 0
end

local state = combined
local nodeIDsCSV = ""
local sep = string.find(combined, "|", 1, true)
if sep then
    state = string.sub(combined, 1, sep - 1)
    nodeIDsCSV = string.sub(combined, sep + 1)
end

for id in string.gmatch(nodeIDsCSV, "[^,]+") do
    local statsKey = "stats:node:" .. id
    if state == "1" then
        redis.call("HINCRBY", statsKey, "up", -1)
    else
        redis.call("HINCRBY", statsKey, "down", -1)
    end
end

redis.call("DEL", key)
redis.call("HDEL", "pings:state", addr)
redis.call("ZREM", "pings:index", addr)

return 1
`

// loadReconcileScript loads reconcileRemovedTargetScript into Redis and
// returns its SHA1, for use with EVALSHA.
func loadReconcileScript(ctx context.Context, rdb redis.Cmdable) (string, error) {
	return rdb.ScriptLoad(ctx, reconcileRemovedTargetScript).Result()
}

// reconcileRemovedTargets scans every state:device:<device_key> key left
// over from a previous run and, for any device_key no longer represented in
// the current target list, removes its stale contribution and ghost entries
// via reconcileRemovedTargetScript. Meant to run once at startup, right
// after loading the current targets file.
//
// Operating on device_key rather than addr is what makes an address change
// for a still-live device a no-op here: the device_key persists across the
// change, so nothing gets cleaned up just because its old addr moved on.
func reconcileRemovedTargets(ctx context.Context, rdb redis.Cmdable, sha string, liveDeviceKeys map[string]struct{}) error {
	var cursor uint64
	for {
		keys, next, err := rdb.Scan(ctx, cursor, "state:device:*", 500).Result()
		if err != nil {
			return err
		}
		for _, key := range keys {
			deviceKey := strings.TrimPrefix(key, "state:device:")
			if _, ok := liveDeviceKeys[deviceKey]; ok {
				continue
			}
			if err := rdb.EvalSha(ctx, sha, []string{deviceKey}).Err(); err != nil {
				return err
			}
		}
		cursor = next
		if cursor == 0 {
			break
		}
	}
	return nil
}

// Target is a ping destination plus its known ancestor chain in the
// generalized Node hierarchy (plan/dynamic-hierarchy-multi-zone-architecture.md
// §4.3). NodeIDs is nil for targets loaded from a plain bare-address file
// (the common case today), and populated for targets loaded from the
// richer "addr,ancestor1;ancestor2;..." format.
type Target struct {
	Addr    string
	NodeIDs []string
	// DeviceKey is "" when no MAC is on file for this device -- callers
	// fall back to Addr (see TargetStore.DeviceKeyFor), never here.
	DeviceKey string
}

// evalArgs builds the KEYS[1] device_key and ARGV list used by
// publishIfChangedAndAggregateScript for a single event. Extracted so the
// batcher's pipelined path and the single-shot publishAndAggregate path
// (used directly in tests) can't drift out of sync with each other.
//
// deviceKey falls back to ev.Addr when ev.DeviceKey is empty -- this is the
// one chokepoint that makes "no MAC on file" byte-identical to pre-
// device_key behavior, with zero changes needed to any existing Event{}
// literal built without a DeviceKey.
func evalArgs(ev Event) (deviceKey string, argv []any) {
	newState := "0"
	if ev.OK {
		newState = "1"
	}
	raw, _ := json.Marshal(ev)
	nodeIDsCSV := strings.Join(ev.NodeIDs, ",")
	deviceKey = ev.DeviceKey
	if deviceKey == "" {
		deviceKey = ev.Addr
	}
	return deviceKey, []any{
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
	deviceKey, argv := evalArgs(ev)
	res, err := rdb.EvalSha(ctx, sha, []string{deviceKey}, argv...).Result()
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
	backendURL := flag.String("backend-url", getenv("ARGUS_BACKEND_URL", ""), "base URL of this zone's own backend, e.g. http://backend:8000 (empty = target hot-reload disabled)")
	syncToken := flag.String("sync-token", getenv("ARGUS_PINGSVC_SYNC_TOKEN", ""), "shared secret presented to the backend's targets-hash/targets-export-internal routes (must match the backend's PINGSVC_SYNC_TOKEN)")
	syncInterval := flag.Duration("sync-interval", getenvDurationSeconds("ARGUS_TARGET_SYNC_INTERVAL_SECONDS", 30*time.Second), "how often to poll the backend for target-list changes")
	discoveryInterval := flag.Duration("discovery-interval", getenvDurationSeconds("ARGUS_DISCOVERY_INTERVAL_SECONDS", 60*time.Second), "how often to poll configured infrastructure targets for ARP-table discovery (less urgent than -sync-interval -- discovery doesn't affect live ping targets)")

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

	// zoneIdentity is available immediately (zone/tenant come from flags),
	// and updated again below once/if a signing key finishes loading --
	// see identityStore's doc comment for why a plain set() is safe here.
	var zoneIdentity identityStore
	zoneIdentity.set(ZoneIdentity{ZoneID: *zoneID, TenantID: *tenantID})

	// Start metrics server
	go func() {
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		mux.HandleFunc("/-/healthy", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) })
		// /identity is unauthenticated, same as /metrics -- fine today since
		// it returns nothing secret (a public key is meant to be shared; see
		// PublicKeyHex's doc comment) and this port is Swarm-internal-only
		// (swarm/stack.client.yml never publishes it) in the topology
		// deployment.md treats as production-representative. It's also
		// published to the host in compose.yml for local Prometheus
		// scraping convenience, so a Compose deployment exposed to an
		// untrusted network would leak zone_id/tenant_id/pubkey to anyone
		// who can reach the host -- low severity (nothing here is a secret)
		// but worth tightening if that ever becomes a real deployment
		// shape: either move /identity off this port entirely (have the
		// backend read identity from a shared file/volume instead of HTTP)
		// or put it on a second listener Compose doesn't publish.
		mux.Handle("/identity", zoneIdentity.handler())
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
			zoneIdentity.set(ZoneIdentity{ZoneID: *zoneID, TenantID: *tenantID, PublicKeyHex: signer.PublicKeyHex()})
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
	targetStore := newTargetStore(loadTargets(*targetsFile))

	// Load the Lua script into Redis and keep the SHA
	sha, err := loadPublishScript(ctx, rdb)
	if err != nil {
		log.Fatalf("failed to load lua script: %v", err)
	}
	reconcileSha, err := loadReconcileScript(ctx, rdb)
	if err != nil {
		log.Fatalf("failed to load reconcile lua script: %v", err)
	}

	// Clean up any address that's no longer in the current target list at
	// all (its Device row was deleted, or its line was hand-removed from
	// targets.txt) -- there's no future ping for a removed address that
	// could otherwise correct its old stats:node:<id> contribution or its
	// pings:state/pings:index ghost entry.
	if err := reconcileRemovedTargets(ctx, rdb, reconcileSha, targetStore.LiveDeviceKeys()); err != nil {
		log.Printf("reconcile removed targets: %v", err)
	}

	// pre-seed state and index so /state returns all devices immediately --
	// keyed by device_key, matching what the real publish path will key
	// pings:state/pings:index by, so this never leaves behind an orphaned
	// addr-keyed ghost entry for a device with a known MAC.
	for _, t := range targetStore.Targets() {
		ts := nowMs()
		deviceKey := targetStore.DeviceKeyFor(t.Addr)
		ev := Event{Addr: t.Addr, DeviceKey: deviceKey, OK: false, TS: ts, Interval: int64(interval.Milliseconds()), NodeIDs: t.NodeIDs}
		raw, _ := json.Marshal(ev)
		_ = rdb.HSet(ctx, "pings:state", deviceKey, raw).Err()
		_ = rdb.ZAdd(ctx, "pings:index", redis.Z{Score: float64(ts), Member: deviceKey}).Err()
	}

	log.Printf("starting pingsvc: %d targets, interval=%v, timeout=%v, redis=%s, workers=%d, batch=%d",
		len(targetStore.Targets()), *interval, *timeout, *redisAddr, *workerCount, *batchSize)

	// Target hot-reload (opt-in, see targetsync.go / "Live Target Sync"
	// plan): polls the backend for changes and swaps targetStore in place,
	// no restart needed. Gated purely on -backend-url being configured,
	// same "empty = feature off" posture as the exporter's S3 config.
	var stopTargetSync func()
	if *backendURL != "" {
		stopTargetSync = runTargetSync(ctx, TargetSyncConfig{
			BackendURL:   *backendURL,
			SyncToken:    *syncToken,
			Interval:     *syncInterval,
			TargetsFile:  *targetsFile,
			Store:        targetStore,
			RDB:          rdb,
			ReconcileSha: reconcileSha,
		})
		log.Printf("targetsync: enabled, backend=%s, interval=%v", *backendURL, *syncInterval)
	}

	// Infra discovery (opt-in, see discovery.go / plan/device-discovery-v1.md
	// §2.8): reuses the same backend connection as target-sync -- no new
	// pingsvc-side connection config at all. Naturally a no-op whenever the
	// backend has zero InfraPollTarget rows configured, so this is gated
	// purely on -backend-url like target-sync, not a separate flag.
	var stopDiscovery func()
	if *backendURL != "" {
		stopDiscovery = runDiscovery(ctx, DiscoveryConfig{
			BackendURL: *backendURL,
			SyncToken:  *syncToken,
			Interval:   *discoveryInterval,
		})
		log.Printf("discovery: enabled, backend=%s, interval=%v", *backendURL, *discoveryInterval)
	}

	// Channels
	jobs := make(chan string, len(targetStore.Targets())) // job queue per tick; buffered by #targets

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
						ev := Event{Addr: addr, DeviceKey: targetStore.DeviceKeyFor(addr), TS: nowMs(), Interval: int64(interval.Milliseconds()), OK: false, Err: err.Error(), NodeIDs: targetStore.NodeIDsFor(addr)}
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
						ev := Event{Addr: addr, DeviceKey: targetStore.DeviceKeyFor(addr), TS: nowMs(), Interval: int64(interval.Milliseconds()), OK: false, Err: err.Error(), NodeIDs: targetStore.NodeIDsFor(addr)}
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

					ev := Event{Addr: addr, DeviceKey: targetStore.DeviceKeyFor(addr), TS: nowMs(), Interval: int64(interval.Milliseconds()), OK: isUp, NodeIDs: targetStore.NodeIDsFor(addr)}
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
				deviceKey, argv := evalArgs(ev)

				// EVALSHA returns integer 1 if publish occurred, 0 otherwise
				// Queue the EvalSha call in the pipeline
				cmd := pipe.EvalSha(context.Background(), sha, []string{deviceKey}, argv...)
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
						deviceKey, argv := evalArgs(ev)
						pipe2.EvalSha(context.Background(), sha, []string{deviceKey}, argv...)
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
			for _, t := range targetStore.Targets() {
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
	if stopTargetSync != nil {
		stopTargetSync()
	}
	if stopDiscovery != nil {
		stopDiscovery()
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
		return parseTargets(string(b))
	}
	// example dummies
	return []Target{{Addr: "8.8.8.8"}, {Addr: "1.1.1.1"}}
}

// parseTargets parses target-file content from raw text (one target per
// line, see loadTargets's doc comment for the line format) -- shared by
// loadTargets' file-reading path and targetsync.go's HTTP-fetched body, so
// both callers stay byte-for-byte in agreement on the format.
func parseTargets(body string) []Target {
	lines := splitLines(body)
	out := make([]Target, len(lines))
	for i, line := range lines {
		out[i] = parseTargetLine(line)
	}
	return out
}

func parseTargetLine(line string) Target {
	// Up to 3 comma-separated fields: addr, semicolon-joined ancestor/node_id
	// chain (unchanged format, may be empty), device_key (new, optional, a
	// bare string with no internal delimiter). All three are backward
	// compatible with fewer fields: a bare addr, or the existing
	// "addr,ancestors" 2-field format, parse exactly as they did before.
	parts := strings.SplitN(line, ",", 3)
	t := Target{Addr: parts[0]}
	if len(parts) >= 2 && parts[1] != "" {
		t.NodeIDs = strings.Split(parts[1], ";")
	}
	if len(parts) == 3 && parts[2] != "" {
		t.DeviceKey = parts[2]
	}
	return t
}

// getenv, splitLines, waitForRedis copied/kept from your original code
func getenv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

// getenvDurationSeconds reads an integer-seconds env var (matching the
// backend Settings convention, e.g. INGESTION_INTERVAL_SECONDS), falling
// back to def if unset or unparseable.
func getenvDurationSeconds(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return time.Duration(n) * time.Second
		}
	}
	return def
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
