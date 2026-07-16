package main

import (
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeObjectStore is an in-memory ObjectStore double for tests that don't
// need a real S3-compatible endpoint (see objectstore_test.go for that).
type fakeObjectStore struct {
	mu            sync.Mutex
	puts          map[string][]byte
	failNext      bool   // if true, the next Put call fails and resets this flag
	failKeySuffix string // if non-empty, any Put whose key has this suffix fails
}

func newFakeObjectStore() *fakeObjectStore {
	return &fakeObjectStore{puts: map[string][]byte{}}
}

func (f *fakeObjectStore) Put(_ context.Context, key string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failNext {
		f.failNext = false
		return errors.New("fakeObjectStore: simulated put failure")
	}
	if f.failKeySuffix != "" && strings.HasSuffix(key, f.failKeySuffix) {
		return errors.New("fakeObjectStore: simulated put failure for key suffix " + f.failKeySuffix)
	}
	f.puts[key] = data
	return nil
}

func (f *fakeObjectStore) keys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.puts))
	for k := range f.puts {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

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

func TestBuildSnapshot_StampsSchemaVersion(t *testing.T) {
	_, rdb, _ := newTestRedis(t)
	ctx := context.Background()

	snap, err := buildSnapshot(ctx, rdb, "zone-1")
	if err != nil {
		t.Fatalf("buildSnapshot() error = %v", err)
	}
	if snap.SchemaVersion != 1 {
		t.Errorf("SchemaVersion = %d, want 1", snap.SchemaVersion)
	}

	// The wire contract (plan §8): the field must appear in the JSON the
	// server's ingestion parser sees, named exactly schema_version.
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal error = %v", err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatalf("unmarshal error = %v", err)
	}
	if got, ok := wire["schema_version"].(float64); !ok || got != 1 {
		t.Errorf(`wire "schema_version" = %v, want 1`, wire["schema_version"])
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

func TestBuildSnapshot_KeyedByAddrEvenWhenDeviceKeyDiffers(t *testing.T) {
	// Snapshot.Devices is the exported contract ("state per pinged
	// address") -- it must stay keyed by Addr regardless of what Redis
	// internally uses for state:device:*/pings:state (device_key once a MAC
	// is known), or a downstream argus-server consumer's keying silently
	// changes out from under it.
	_, rdb, sha := newTestRedis(t)
	ctx := context.Background()

	ev := Event{Addr: "10.0.4.9", DeviceKey: "AA:BB:CC:DD:EE:FF", OK: true, TS: 6000}
	if _, err := publishAndAggregate(ctx, rdb, sha, ev); err != nil {
		t.Fatalf("seed publish error = %v", err)
	}

	snap, err := buildSnapshot(ctx, rdb, "zone-1")
	if err != nil {
		t.Fatalf("buildSnapshot() error = %v", err)
	}
	got, ok := snap.Devices["10.0.4.9"]
	if !ok {
		t.Fatalf("Devices[%q] missing, want present (keyed by addr, not device_key)", "10.0.4.9")
	}
	if !got.OK || got.TS != 6000 {
		t.Errorf("Devices[%q] = %+v, want {OK:true TS:6000}", "10.0.4.9", got)
	}
	if _, ok := snap.Devices["AA:BB:CC:DD:EE:FF"]; ok {
		t.Errorf("Devices[%q] present, want absent (must not be keyed by device_key)", "AA:BB:CC:DD:EE:FF")
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

// ── flushSpool ───────────────────────────────────────────────────────────

func writeSpoolFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatalf("failed to write spool fixture %s: %v", name, err)
	}
}

func TestFlushSpool_EmptySpoolDirIsNoOp(t *testing.T) {
	dir := t.TempDir()
	store := newFakeObjectStore()

	pushed, err := flushSpool(context.Background(), store, nil, dir, "tenant-1", "zone-1")
	if err != nil {
		t.Fatalf("flushSpool() error = %v", err)
	}
	if pushed != 0 {
		t.Errorf("pushed = %d, want 0", pushed)
	}
}

func TestFlushSpool_PushesFilesOldestFirstAndRemovesOnSuccess(t *testing.T) {
	dir := t.TempDir()
	store := newFakeObjectStore()

	writeSpoolFile(t, dir, "2000.json.gz", "second")
	writeSpoolFile(t, dir, "1000.json.gz", "first")

	pushed, err := flushSpool(context.Background(), store, nil, dir, "tenant-1", "zone-1")
	if err != nil {
		t.Fatalf("flushSpool() error = %v", err)
	}
	if pushed != 2 {
		t.Fatalf("pushed = %d, want 2", pushed)
	}

	keys := store.keys()
	if len(keys) != 2 {
		t.Fatalf("store has %d objects, want 2", len(keys))
	}
	// Both files landed under the same date-derived prefix; just confirm
	// both filenames made it through and the spool dir is now empty.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Errorf("spool dir has %d entries after successful flush, want 0", len(entries))
	}
}

func TestFlushSpool_StopsOnFirstFailureLeavingRestForNextCycle(t *testing.T) {
	dir := t.TempDir()
	store := newFakeObjectStore()

	writeSpoolFile(t, dir, "1000.json.gz", "first")
	writeSpoolFile(t, dir, "2000.json.gz", "second")
	store.failNext = true // the oldest (first) push fails

	pushed, err := flushSpool(context.Background(), store, nil, dir, "tenant-1", "zone-1")
	if err == nil {
		t.Fatal("flushSpool() error = nil, want an error when a push fails")
	}
	if pushed != 0 {
		t.Errorf("pushed = %d, want 0 (first file failed)", pushed)
	}

	// Both files must still be on disk -- nothing was removed since nothing
	// (confirmed) succeeded, and the second was never attempted this cycle.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 2 {
		t.Errorf("spool dir has %d entries, want 2 (both retained for next cycle)", len(entries))
	}
}

func TestFlushSpool_SkipsUnparseableFilenamesWithoutBlockingOthers(t *testing.T) {
	dir := t.TempDir()
	store := newFakeObjectStore()

	writeSpoolFile(t, dir, "not-a-timestamp.json.gz", "junk")
	writeSpoolFile(t, dir, "1000.json.gz", "valid")

	pushed, err := flushSpool(context.Background(), store, nil, dir, "tenant-1", "zone-1")
	if err != nil {
		t.Fatalf("flushSpool() error = %v", err)
	}
	if pushed != 1 {
		t.Errorf("pushed = %d, want 1 (only the valid file)", pushed)
	}
	if len(store.keys()) != 1 {
		t.Errorf("store has %d objects, want 1", len(store.keys()))
	}
}

// ── runExporter with an ObjectStore configured ────────────────────────────

func TestRunExporter_WithStore_PushesAndRemovesSpoolFile(t *testing.T) {
	_, rdb, sha := newTestRedis(t)
	ctx := context.Background()
	dir := t.TempDir()
	store := newFakeObjectStore()

	ev := Event{Addr: "10.0.4.7", OK: true, TS: 1000, NodeIDs: []string{"room-5"}}
	if _, err := publishAndAggregate(ctx, rdb, sha, ev); err != nil {
		t.Fatalf("seed publish error = %v", err)
	}

	stop := runExporter(ctx, rdb, ExporterConfig{
		ZoneID: "zone-1", TenantID: "tenant-1", Interval: 20 * time.Millisecond,
		SpoolDir: dir, Store: store,
	})

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && len(store.keys()) == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	stop()

	if len(store.keys()) == 0 {
		t.Fatal("no objects pushed to store within deadline")
	}
	// The spool file must have been removed after a successful push --
	// runExporter's disk sink is a staging area, not the final destination,
	// once an ObjectStore is configured.
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Errorf("spool dir has %d entries after successful push, want 0", len(entries))
	}
}

// ── flushSpool with a Signer configured ───────────────────────────────────

func testSigner(t *testing.T) *Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("ed25519.GenerateKey() error = %v", err)
	}
	return &Signer{priv: priv}
}

func TestFlushSpool_WithSigner_PushesVerifiableManifestAlongsideSnapshot(t *testing.T) {
	dir := t.TempDir()
	store := newFakeObjectStore()
	signer := testSigner(t)

	writeSpoolFile(t, dir, "1000.json.gz", `{"zone_id":"zone-1"}`)

	pushed, err := flushSpool(context.Background(), store, signer, dir, "tenant-1", "zone-1")
	if err != nil {
		t.Fatalf("flushSpool() error = %v", err)
	}
	if pushed != 1 {
		t.Fatalf("pushed = %d, want 1", pushed)
	}

	keys := store.keys()
	var snapshotKey, manifestKey string
	for _, k := range keys {
		if strings.HasSuffix(k, ".manifest.json") {
			manifestKey = k
		} else {
			snapshotKey = k
		}
	}
	if snapshotKey == "" || manifestKey == "" {
		t.Fatalf("store.keys() = %v, want one snapshot key and one .manifest.json key", keys)
	}
	if manifestKey != snapshotKey+".manifest.json" {
		t.Errorf("manifestKey = %q, want %q", manifestKey, snapshotKey+".manifest.json")
	}

	var manifest Manifest
	if err := json.Unmarshal(store.puts[manifestKey], &manifest); err != nil {
		t.Fatalf("unmarshal manifest error = %v", err)
	}
	ok, err := verifyManifest(manifest, store.puts[snapshotKey])
	if err != nil {
		t.Fatalf("verifyManifest() error = %v", err)
	}
	if !ok {
		t.Error("verifyManifest() = false, want true for a manifest pushed by flushSpool")
	}
}

func TestFlushSpool_WithoutSigner_PushesNoManifest(t *testing.T) {
	dir := t.TempDir()
	store := newFakeObjectStore()

	writeSpoolFile(t, dir, "1000.json.gz", "content")

	if _, err := flushSpool(context.Background(), store, nil, dir, "tenant-1", "zone-1"); err != nil {
		t.Fatalf("flushSpool() error = %v", err)
	}

	for _, k := range store.keys() {
		if strings.HasSuffix(k, ".manifest.json") {
			t.Errorf("found manifest key %q with no signer configured, want none", k)
		}
	}
}

func TestFlushSpool_WithSigner_ManifestPushFailureLeavesFileForRetry(t *testing.T) {
	dir := t.TempDir()
	store := newFakeObjectStore()
	store.failKeySuffix = ".manifest.json"
	signer := testSigner(t)

	writeSpoolFile(t, dir, "1000.json.gz", "content")

	pushed, err := flushSpool(context.Background(), store, signer, dir, "tenant-1", "zone-1")
	if err == nil {
		t.Fatal("flushSpool() error = nil, want an error when the manifest push fails")
	}
	if pushed != 0 {
		t.Errorf("pushed = %d, want 0 (manifest push failed, file not counted as pushed)", pushed)
	}

	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("spool dir has %d entries, want 1 (retained for next cycle since the manifest never landed)", len(entries))
	}
}

func TestRunExporter_WithSignerAndStore_PushesSignedManifest(t *testing.T) {
	_, rdb, sha := newTestRedis(t)
	ctx := context.Background()
	dir := t.TempDir()
	store := newFakeObjectStore()
	signer := testSigner(t)

	ev := Event{Addr: "10.0.4.8", OK: true, TS: 1000, NodeIDs: []string{"room-11"}}
	if _, err := publishAndAggregate(ctx, rdb, sha, ev); err != nil {
		t.Fatalf("seed publish error = %v", err)
	}

	stop := runExporter(ctx, rdb, ExporterConfig{
		ZoneID: "zone-1", TenantID: "tenant-1", Interval: 20 * time.Millisecond,
		SpoolDir: dir, Store: store, Signer: signer,
	})

	deadline := time.Now().Add(2 * time.Second)
	var hasManifest bool
	for time.Now().Before(deadline) {
		for _, k := range store.keys() {
			if strings.HasSuffix(k, ".manifest.json") {
				hasManifest = true
			}
		}
		if hasManifest {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	stop()

	if !hasManifest {
		t.Fatal("no manifest pushed to store within deadline")
	}
}
