package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// ExporterConfig configures runExporter. See
// plan/dynamic-hierarchy-multi-zone-architecture.md §4.3-4.4.
type ExporterConfig struct {
	ZoneID   string
	TenantID string
	Interval time.Duration
	SpoolDir string
	// Store is optional. When nil, the exporter behaves exactly as it did
	// in Phase 1: the local spool is the terminal sink. When set, each
	// cycle also flushes the spool to object storage, removing files on
	// successful push and leaving them for retry on failure.
	Store ObjectStore
	// Signer is optional and only takes effect when Store is also set. When
	// set, a signed Manifest is pushed alongside every snapshot object.
	Signer *Signer
}

// snapshotSchemaVersion is the wire-contract version of Snapshot's JSON
// shape (plan §8) — independent of app semver, bumped only when the
// payload format changes incompatibly. The server tolerates the current
// and absent (pre-versioning) values and skips anything newer.
const snapshotSchemaVersion = 1

// Snapshot is the periodic aggregated payload an argus-client exports.
// It carries rollups already computed by the Lua script (stats:node:*)
// plus a snapshot of pings:state, not raw ping events — the ping pipeline
// already does the per-event work, so the exporter's job is purely to read
// the current aggregate, not to duplicate it.
type Snapshot struct {
	SchemaVersion int                    `json:"schema_version"`
	ZoneID        string                 `json:"zone_id"`
	TS            int64                  `json:"ts"`
	Nodes         map[string]NodeCounts  `json:"nodes"`
	Devices       map[string]DeviceState `json:"devices"`
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
		SchemaVersion: snapshotSchemaVersion,
		ZoneID:        zoneID,
		TS:            nowMs(),
		Nodes:         map[string]NodeCounts{},
		Devices:       map[string]DeviceState{},
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

	if cfg.Store == nil {
		return
	}
	pushed, err := flushSpool(ctx, cfg.Store, cfg.Signer, cfg.SpoolDir, cfg.TenantID, cfg.ZoneID)
	if err != nil {
		metrExporterPushErrors.Inc()
		log.Printf("exporter: push failed after %d file(s) this cycle: %v", pushed, err)
		return
	}
	if pushed > 0 {
		metrExporterSnapshotsPushed.Add(float64(pushed))
		log.Printf("exporter: pushed %d snapshot(s) to object storage", pushed)
	}
}

// parseSpoolTimestamp extracts the unix-ms timestamp embedded in a spool
// filename ("<ts>.json.gz"), shared by objectKeyForSpoolFile (for the
// date-based key prefix) and flushSpool (as the manifest's sequence number,
// see signManifest's doc comment).
func parseSpoolTimestamp(filename string) (int64, error) {
	tsPart := strings.TrimSuffix(filename, ".json.gz")
	tsMs, err := strconv.ParseInt(tsPart, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("parse timestamp from spool filename %q: %w", filename, err)
	}
	return tsMs, nil
}

// objectKeyForSpoolFile derives the object storage key for a spooled
// snapshot file: {tenant_id}/{zone_id}/YYYY/MM/DD/HH/<unix_ts>.json.gz (plan
// §4.4). The date parts come from the timestamp embedded in the filename
// itself, so no separate metadata needs to travel alongside the file.
func objectKeyForSpoolFile(tenantID, zoneID, filename string) (string, error) {
	tsMs, err := parseSpoolTimestamp(filename)
	if err != nil {
		return "", err
	}
	t := time.UnixMilli(tsMs).UTC()
	return fmt.Sprintf("%s/%s/%04d/%02d/%02d/%02d/%s",
		tenantID, zoneID, t.Year(), t.Month(), t.Day(), t.Hour(), filename), nil
}

// flushSpool pushes every file currently in spoolDir to store, oldest first
// (filenames sort lexicographically by embedded timestamp). It stops at the
// first failed push rather than retrying every remaining file against a
// possibly-down endpoint every cycle -- the next export cycle retries
// starting from the same oldest file. Successfully pushed files are removed
// from the spool; files with an unparseable name are skipped (not
// retryable) rather than blocking every file behind them forever.
//
// If signer is non-nil, a signed Manifest (plan §4.4) is pushed alongside
// each snapshot at "<key>.manifest.json". A manifest push failure counts as
// a failure of the whole file -- the snapshot alone doesn't achieve the
// anti-tamper guarantee signing is for, so the file stays in the spool and
// retries both objects next cycle (harmless: object keys are immutable, so
// re-pushing identical content is a safe no-op).
func flushSpool(ctx context.Context, store ObjectStore, signer *Signer, spoolDir, tenantID, zoneID string) (pushed int, err error) {
	entries, err := os.ReadDir(spoolDir)
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, fmt.Errorf("read spool dir: %w", err)
	}

	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		key, err := objectKeyForSpoolFile(tenantID, zoneID, name)
		if err != nil {
			log.Printf("exporter: skipping unparseable spool file %s: %v", name, err)
			continue
		}

		path := filepath.Join(spoolDir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			return pushed, fmt.Errorf("read spool file %s: %w", path, err)
		}
		if err := store.Put(ctx, key, data); err != nil {
			return pushed, fmt.Errorf("push %s: %w", name, err)
		}

		if signer != nil {
			tsMs, _ := parseSpoolTimestamp(name) // already validated by objectKeyForSpoolFile above
			manifest := signManifest(signer.priv, tsMs, data)
			manifestBytes, err := json.Marshal(manifest)
			if err != nil {
				return pushed, fmt.Errorf("marshal manifest for %s: %w", name, err)
			}
			if err := store.Put(ctx, key+".manifest.json", manifestBytes); err != nil {
				return pushed, fmt.Errorf("push manifest for %s: %w", name, err)
			}
		}

		if err := os.Remove(path); err != nil {
			log.Printf("exporter: pushed %s but failed to remove from spool: %v", name, err)
		}
		pushed++
	}
	return pushed, nil
}
