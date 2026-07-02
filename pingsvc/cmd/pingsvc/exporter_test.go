package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// ── buildSnapshot ────────────────────────────────────────────────────────

func TestBuildSnapshot_EmptyRedisProducesEmptySnapshot(t *testing.T) {
	_, rdb, _ := newTestRedis(t)
	ctx := context.Background()

	snap, err := buildSnapshot(ctx, rdb, "zone-1")
	if err != nil {
		t.Fatalf("buildSnapshot() error = %v", err)
	}
	if snap.ZoneID != "zone-1" {
		t.Errorf("ZoneID = %q, want %q", snap.ZoneID, "zone-1")
	}
	if len(snap.Nodes) != 0 {
		t.Errorf("Nodes = %v, want empty", snap.Nodes)
	}
	if len(snap.Devices) != 0 {
		t.Errorf("Devices = %v, want empty", snap.Devices)
	}
}

func TestBuildSnapshot_IncludesNodeCounters(t *testing.T) {
	_, rdb, sha := newTestRedis(t)
	ctx := context.Background()

	a := Event{Addr: "10.0.4.1", OK: true, TS: 1000, NodeIDs: []string{"room-1"}}
	if _, err := publishAndAggregate(ctx, rdb, sha, a); err != nil {
		t.Fatalf("seed publish error = %v", err)
	}
	b := Event{Addr: "10.0.4.2", OK: false, TS: 1000, NodeIDs: []string{"room-1"}}
	if _, err := publishAndAggregate(ctx, rdb, sha, b); err != nil {
		t.Fatalf("seed publish error = %v", err)
	}

	snap, err := buildSnapshot(ctx, rdb, "zone-1")
	if err != nil {
		t.Fatalf("buildSnapshot() error = %v", err)
	}
	got, ok := snap.Nodes["room-1"]
	if !ok {
		t.Fatalf("Nodes[%q] missing, want present", "room-1")
	}
	if got.Up != 1 || got.Down != 1 {
		t.Errorf("Nodes[%q] = %+v, want {Up:1 Down:1}", "room-1", got)
	}
}

func TestBuildSnapshot_IncludesDeviceStates(t *testing.T) {
	_, rdb, sha := newTestRedis(t)
	ctx := context.Background()

	ev := Event{Addr: "10.0.4.3", OK: true, TS: 5000}
	if _, err := publishAndAggregate(ctx, rdb, sha, ev); err != nil {
		t.Fatalf("seed publish error = %v", err)
	}

	snap, err := buildSnapshot(ctx, rdb, "zone-1")
	if err != nil {
		t.Fatalf("buildSnapshot() error = %v", err)
	}
	got, ok := snap.Devices["10.0.4.3"]
	if !ok {
		t.Fatalf("Devices[%q] missing, want present", "10.0.4.3")
	}
	if !got.OK || got.TS != 5000 {
		t.Errorf("Devices[%q] = %+v, want {OK:true TS:5000}", "10.0.4.3", got)
	}
}

func TestBuildSnapshot_SkipsMalformedStateEntries(t *testing.T) {
	_, rdb, sha := newTestRedis(t)
	ctx := context.Background()

	ev := Event{Addr: "10.0.4.4", OK: true, TS: 1000}
	if _, err := publishAndAggregate(ctx, rdb, sha, ev); err != nil {
		t.Fatalf("seed publish error = %v", err)
	}
	if err := rdb.HSet(ctx, "pings:state", "10.0.4.5", "not-json").Err(); err != nil {
		t.Fatalf("seed malformed entry error = %v", err)
	}

	snap, err := buildSnapshot(ctx, rdb, "zone-1")
	if err != nil {
		t.Fatalf("buildSnapshot() error = %v", err)
	}
	if _, ok := snap.Devices["10.0.4.5"]; ok {
		t.Errorf("Devices[%q] present, want skipped (malformed JSON)", "10.0.4.5")
	}
	if _, ok := snap.Devices["10.0.4.4"]; !ok {
		t.Errorf("Devices[%q] missing, want present", "10.0.4.4")
	}
}

// ── writeSnapshotToSpool ─────────────────────────────────────────────────

func readGzipJSON(t *testing.T, path string) Snapshot {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s error = %v", path, err)
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatalf("gzip.NewReader(%s) error = %v", path, err)
	}
	defer gz.Close()

	raw, err := io.ReadAll(gz)
	if err != nil {
		t.Fatalf("read gzip content error = %v", err)
	}
	var snap Snapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		t.Fatalf("unmarshal snapshot error = %v", err)
	}
	return snap
}

func TestWriteSnapshotToSpool_CreatesGzipJSONFile(t *testing.T) {
	dir := t.TempDir()
	snap := Snapshot{
		ZoneID: "zone-1",
		TS:     1234,
		Nodes:  map[string]NodeCounts{"room-1": {Up: 2, Down: 1}},
		Devices: map[string]DeviceState{
			"10.0.0.1": {OK: true, TS: 1000},
		},
	}

	path, err := writeSnapshotToSpool(dir, snap)
	if err != nil {
		t.Fatalf("writeSnapshotToSpool() error = %v", err)
	}

	got := readGzipJSON(t, path)
	if got.ZoneID != snap.ZoneID {
		t.Errorf("round-tripped ZoneID = %q, want %q", got.ZoneID, snap.ZoneID)
	}
	if got.Nodes["room-1"] != snap.Nodes["room-1"] {
		t.Errorf("round-tripped Nodes[room-1] = %+v, want %+v", got.Nodes["room-1"], snap.Nodes["room-1"])
	}
	if got.Devices["10.0.0.1"] != snap.Devices["10.0.0.1"] {
		t.Errorf("round-tripped Devices[10.0.0.1] = %+v, want %+v", got.Devices["10.0.0.1"], snap.Devices["10.0.0.1"])
	}
}

func TestWriteSnapshotToSpool_CreatesSpoolDirIfMissing(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "spool")
	snap := Snapshot{ZoneID: "zone-1", TS: 1234, Nodes: map[string]NodeCounts{}, Devices: map[string]DeviceState{}}

	path, err := writeSnapshotToSpool(dir, snap)
	if err != nil {
		t.Fatalf("writeSnapshotToSpool() error = %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("spool file %s does not exist: %v", path, err)
	}
}

// ── runExporter ──────────────────────────────────────────────────────────

func TestRunExporter_WritesSnapshotOnTick(t *testing.T) {
	_, rdb, sha := newTestRedis(t)
	ctx := context.Background()
	dir := t.TempDir()

	ev := Event{Addr: "10.0.4.6", OK: true, TS: 1000, NodeIDs: []string{"room-9"}}
	if _, err := publishAndAggregate(ctx, rdb, sha, ev); err != nil {
		t.Fatalf("seed publish error = %v", err)
	}

	stop := runExporter(ctx, rdb, ExporterConfig{
		ZoneID: "zone-1", Interval: 20 * time.Millisecond, SpoolDir: dir,
	})

	deadline := time.Now().Add(2 * time.Second)
	var entries []os.DirEntry
	for time.Now().Before(deadline) {
		entries, _ = os.ReadDir(dir)
		if len(entries) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	stop()

	if len(entries) == 0 {
		t.Fatalf("no snapshot files written to %s within deadline", dir)
	}
	snap := readGzipJSON(t, filepath.Join(dir, entries[0].Name()))
	if snap.ZoneID != "zone-1" {
		t.Errorf("written snapshot ZoneID = %q, want %q", snap.ZoneID, "zone-1")
	}
	if snap.Nodes["room-9"].Up != 1 {
		t.Errorf("written snapshot Nodes[room-9] = %+v, want Up:1", snap.Nodes["room-9"])
	}
}

func TestRunExporter_StopReturnsPromptlyWithNoTicksFired(t *testing.T) {
	_, rdb, _ := newTestRedis(t)
	ctx := context.Background()
	dir := t.TempDir()

	stop := runExporter(ctx, rdb, ExporterConfig{
		ZoneID: "zone-1", Interval: time.Hour, SpoolDir: dir,
	})

	done := make(chan struct{})
	go func() {
		stop()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stop() did not return within 2s")
	}

	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Errorf("spool dir has %d entries, want 0 (interval never fired)", len(entries))
	}
}
