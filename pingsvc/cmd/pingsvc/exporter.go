package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// ExporterConfig configures runExporter. See
// plan/dynamic-hierarchy-multi-zone-architecture.md §4.3.
type ExporterConfig struct {
	ZoneID   string
	Interval time.Duration
	SpoolDir string
}

// Snapshot is the periodic aggregated payload an argus-client exports.
// It carries rollups already computed by the Lua script (stats:node:*)
// plus a snapshot of pings:state, not raw ping events — the ping pipeline
// already does the per-event work, so the exporter's job is purely to read
// the current aggregate, not to duplicate it.
type Snapshot struct {
	ZoneID  string                 `json:"zone_id"`
	TS      int64                  `json:"ts"`
	Nodes   map[string]NodeCounts  `json:"nodes"`
	Devices map[string]DeviceState `json:"devices"`
}

type NodeCounts struct {
	Up   int64 `json:"up"`
	Down int64 `json:"down"`
}

type DeviceState struct {
	OK bool  `json:"ok"`
	TS int64 `json:"ts"`
}

// buildSnapshot reads stats:node:* and pings:state from Redis and assembles
// a Snapshot. Pure data-gathering (no disk I/O), so it's testable against
// miniredis on its own.
func buildSnapshot(ctx context.Context, rdb redis.Cmdable, zoneID string) (Snapshot, error) {
	snap := Snapshot{
		ZoneID:  zoneID,
		TS:      nowMs(),
		Nodes:   map[string]NodeCounts{},
		Devices: map[string]DeviceState{},
	}

	nodeKeys, err := rdb.Keys(ctx, "stats:node:*").Result()
	if err != nil {
		return Snapshot{}, fmt.Errorf("scan stats:node:*: %w", err)
	}
	for _, key := range nodeKeys {
		nodeID := strings.TrimPrefix(key, "stats:node:")
		vals, err := rdb.HGetAll(ctx, key).Result()
		if err != nil {
			return Snapshot{}, fmt.Errorf("hgetall %s: %w", key, err)
		}
		var counts NodeCounts
		if v, ok := vals["up"]; ok {
			counts.Up, _ = strconv.ParseInt(v, 10, 64)
		}
		if v, ok := vals["down"]; ok {
			counts.Down, _ = strconv.ParseInt(v, 10, 64)
		}
		snap.Nodes[nodeID] = counts
	}

	states, err := rdb.HGetAll(ctx, "pings:state").Result()
	if err != nil {
		return Snapshot{}, fmt.Errorf("hgetall pings:state: %w", err)
	}
	for addr, raw := range states {
		var ev Event
		if err := json.Unmarshal([]byte(raw), &ev); err != nil {
			// Malformed snapshot entries shouldn't take down the whole
			// export cycle -- skip and keep going.
			continue
		}
		snap.Devices[addr] = DeviceState{OK: ev.OK, TS: ev.TS}
	}

	return snap, nil
}

// writeSnapshotToSpool gzip-encodes a snapshot as JSON and writes it to
// spoolDir/<ts>.json.gz. This is the local disk sink Phase 1 proves works;
// a later phase adds the actual object-storage push and reuses this same
// spool as its retry buffer on push failure (plan §4.3). No eviction yet --
// that only matters once the spool is a retry buffer with a real upstream
// to fail against.
func writeSnapshotToSpool(spoolDir string, snap Snapshot) (string, error) {
	if err := os.MkdirAll(spoolDir, 0o755); err != nil {
		return "", fmt.Errorf("mkdir spool dir: %w", err)
	}
	raw, err := json.Marshal(snap)
	if err != nil {
		return "", fmt.Errorf("marshal snapshot: %w", err)
	}

	path := filepath.Join(spoolDir, fmt.Sprintf("%d.json.gz", snap.TS))
	f, err := os.Create(path)
	if err != nil {
		return "", fmt.Errorf("create spool file: %w", err)
	}
	defer f.Close()

	gz := gzip.NewWriter(f)
	if _, err := gz.Write(raw); err != nil {
		return "", fmt.Errorf("write gzip: %w", err)
	}
	if err := gz.Close(); err != nil {
		return "", fmt.Errorf("close gzip: %w", err)
	}
	return path, nil
}

// runExporter starts a goroutine that periodically builds a Snapshot from
// Redis and writes it to the local disk spool, independent of the ping
// pipeline's own goroutines/channels so a slow export cycle can never
// backpressure ping workers. Returns a stop func that cancels the
// goroutine and waits for it to exit before returning.
func runExporter(ctx context.Context, rdb redis.Cmdable, cfg ExporterConfig) func() {
	exporterCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})

	go func() {
		defer close(done)
		ticker := time.NewTicker(cfg.Interval)
		defer ticker.Stop()
		for {
			select {
			case <-exporterCtx.Done():
				return
			case <-ticker.C:
				runExportCycle(exporterCtx, rdb, cfg)
			}
		}
	}()

	return func() {
		cancel()
		<-done
	}
}

func runExportCycle(ctx context.Context, rdb redis.Cmdable, cfg ExporterConfig) {
	snap, err := buildSnapshot(ctx, rdb, cfg.ZoneID)
	if err != nil {
		metrExporterErrors.Inc()
		log.Printf("exporter: failed to build snapshot: %v", err)
		return
	}
	path, err := writeSnapshotToSpool(cfg.SpoolDir, snap)
	if err != nil {
		metrExporterErrors.Inc()
		log.Printf("exporter: failed to write snapshot to spool: %v", err)
		return
	}
	metrExporterSnapshotsWritten.Inc()
	log.Printf("exporter: wrote snapshot to %s (%d nodes, %d devices)", path, len(snap.Nodes), len(snap.Devices))
}
