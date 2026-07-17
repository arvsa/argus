package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// fakeBackend serves canned /devices/targets-hash and
// /devices/targets-export-internal responses, and records how many times
// each was hit -- lets tests assert the export endpoint is only called
// when the hash actually changed, without a real FastAPI backend.
type fakeBackend struct {
	srv *httptest.Server

	hash       atomic.Value // string
	body       atomic.Value // string
	wantToken  string
	hashHits   atomic.Int64
	exportHits atomic.Int64
	failHash   atomic.Bool
	failExport atomic.Bool
}

func newFakeBackend(t *testing.T, wantToken string) *fakeBackend {
	t.Helper()
	fb := &fakeBackend{wantToken: wantToken}
	fb.hash.Store("")
	fb.body.Store("")

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/devices/targets-hash", func(w http.ResponseWriter, r *http.Request) {
		fb.hashHits.Add(1)
		if r.Header.Get("X-Pingsvc-Token") != fb.wantToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if fb.failHash.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"hash": %q}`, fb.hash.Load().(string))
	})
	mux.HandleFunc("/api/v1/devices/targets-export-internal", func(w http.ResponseWriter, r *http.Request) {
		fb.exportHits.Add(1)
		if r.Header.Get("X-Pingsvc-Token") != fb.wantToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		if fb.failExport.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprint(w, fb.body.Load().(string))
	})

	fb.srv = httptest.NewServer(mux)
	t.Cleanup(fb.srv.Close)
	return fb
}

func (fb *fakeBackend) setState(hash, body string) {
	fb.hash.Store(hash)
	fb.body.Store(body)
}

// ── TargetStore ─────────────────────────────────────────────────────────

func TestTargetStore_TargetsAndNodeIDsForReflectInitialState(t *testing.T) {
	store := newTargetStore([]Target{
		{Addr: "10.0.0.1", NodeIDs: []string{"room-1"}},
		{Addr: "10.0.0.2"},
	})

	if got := len(store.Targets()); got != 2 {
		t.Fatalf("Targets() len = %d, want 2", got)
	}
	if got := store.NodeIDsFor("10.0.0.1"); len(got) != 1 || got[0] != "room-1" {
		t.Errorf("NodeIDsFor(10.0.0.1) = %v, want [room-1]", got)
	}
	if got := store.NodeIDsFor("10.0.0.2"); got != nil {
		t.Errorf("NodeIDsFor(10.0.0.2) = %v, want nil", got)
	}
}

func TestTargetStore_SetReplacesTargetsAtomically(t *testing.T) {
	store := newTargetStore([]Target{{Addr: "10.0.0.1", NodeIDs: []string{"room-1"}}})

	store.set([]Target{{Addr: "10.0.0.9", NodeIDs: []string{"room-9"}}})

	if got := store.Targets(); len(got) != 1 || got[0].Addr != "10.0.0.9" {
		t.Errorf("Targets() after set = %v, want [{10.0.0.9 [room-9]}]", got)
	}
	if got := store.NodeIDsFor("10.0.0.1"); got != nil {
		t.Errorf("NodeIDsFor(10.0.0.1) after set = %v, want nil (replaced, not merged)", got)
	}
	if got := store.NodeIDsFor("10.0.0.9"); len(got) != 1 || got[0] != "room-9" {
		t.Errorf("NodeIDsFor(10.0.0.9) after set = %v, want [room-9]", got)
	}
}

func TestTargetStore_DeviceKeyFor_FallsBackToAddrWhenNoDeviceKeyOnFile(t *testing.T) {
	store := newTargetStore([]Target{{Addr: "10.0.0.1"}})

	if got := store.DeviceKeyFor("10.0.0.1"); got != "10.0.0.1" {
		t.Errorf("DeviceKeyFor(10.0.0.1) = %q, want %q (fallback to addr)", got, "10.0.0.1")
	}
}

func TestTargetStore_DeviceKeyFor_ReturnsConfiguredDeviceKey(t *testing.T) {
	store := newTargetStore([]Target{{Addr: "10.0.0.1", DeviceKey: "AA:BB:CC:DD:EE:FF"}})

	if got := store.DeviceKeyFor("10.0.0.1"); got != "AA:BB:CC:DD:EE:FF" {
		t.Errorf("DeviceKeyFor(10.0.0.1) = %q, want %q", got, "AA:BB:CC:DD:EE:FF")
	}
}

func TestTargetStore_DeviceKeyFor_UnknownAddrFallsBackToItself(t *testing.T) {
	store := newTargetStore([]Target{{Addr: "10.0.0.1", DeviceKey: "AA:BB:CC:DD:EE:FF"}})

	if got := store.DeviceKeyFor("10.0.0.9"); got != "10.0.0.9" {
		t.Errorf("DeviceKeyFor(10.0.0.9) = %q, want %q (unknown addr falls back to itself)", got, "10.0.0.9")
	}
}

func TestTargetStore_LiveDeviceKeys_DefaultsToAddrAndDedupes(t *testing.T) {
	store := newTargetStore([]Target{
		{Addr: "10.0.0.1", DeviceKey: "AA:BB:CC:DD:EE:FF"},
		{Addr: "10.0.0.2"},
		{Addr: "10.0.0.3", DeviceKey: "AA:BB:CC:DD:EE:FF"}, // same key as 10.0.0.1
	})

	got := store.LiveDeviceKeys()
	want := map[string]struct{}{
		"AA:BB:CC:DD:EE:FF": {},
		"10.0.0.2":          {},
	}
	if len(got) != len(want) {
		t.Fatalf("LiveDeviceKeys() = %v, want %v", got, want)
	}
	for k := range want {
		if _, ok := got[k]; !ok {
			t.Errorf("LiveDeviceKeys() missing %q", k)
		}
	}
}

// ── syncTargetsCycle ────────────────────────────────────────────────────

func TestSyncTargetsCycle_FetchesAndAppliesOnHashChange(t *testing.T) {
	fb := newFakeBackend(t, "secret")
	fb.setState("hash-1", "10.0.9.1\n10.0.9.2,root;child\n")
	store := newTargetStore(nil)

	cfg := TargetSyncConfig{BackendURL: fb.srv.URL, SyncToken: "secret", Store: store}
	newHash := syncTargetsCycle(context.Background(), cfg, "")

	if newHash != "hash-1" {
		t.Errorf("syncTargetsCycle() returned hash = %q, want %q", newHash, "hash-1")
	}
	targets := store.Targets()
	if len(targets) != 2 {
		t.Fatalf("Targets() len = %d, want 2 (got %+v)", len(targets), targets)
	}
	if got := store.NodeIDsFor("10.0.9.2"); len(got) != 2 || got[0] != "root" || got[1] != "child" {
		t.Errorf("NodeIDsFor(10.0.9.2) = %v, want [root child]", got)
	}
	if fb.exportHits.Load() != 1 {
		t.Errorf("export endpoint hit %d times, want 1", fb.exportHits.Load())
	}
}

func TestSyncTargetsCycle_NoOpWhenHashUnchanged(t *testing.T) {
	fb := newFakeBackend(t, "secret")
	fb.setState("same-hash", "10.0.9.3\n")
	store := newTargetStore(nil)
	cfg := TargetSyncConfig{BackendURL: fb.srv.URL, SyncToken: "secret", Store: store}

	first := syncTargetsCycle(context.Background(), cfg, "")
	second := syncTargetsCycle(context.Background(), cfg, first)

	if second != "same-hash" {
		t.Errorf("second cycle hash = %q, want %q", second, "same-hash")
	}
	if fb.exportHits.Load() != 1 {
		t.Errorf("export endpoint hit %d times across two same-hash cycles, want 1 (second should be a no-op)", fb.exportHits.Load())
	}
}

func TestSyncTargetsCycle_HashFetchErrorReturnsLastHashUnchanged(t *testing.T) {
	fb := newFakeBackend(t, "secret")
	fb.failHash.Store(true)
	store := newTargetStore([]Target{{Addr: "10.0.0.1"}})
	cfg := TargetSyncConfig{BackendURL: fb.srv.URL, SyncToken: "secret", Store: store}

	got := syncTargetsCycle(context.Background(), cfg, "previous-hash")

	if got != "previous-hash" {
		t.Errorf("syncTargetsCycle() with failing hash endpoint returned %q, want unchanged %q", got, "previous-hash")
	}
	if len(store.Targets()) != 1 {
		t.Errorf("Targets() changed despite hash fetch failure: %+v", store.Targets())
	}
}

func TestSyncTargetsCycle_ExportFetchErrorReturnsLastHashUnchanged(t *testing.T) {
	fb := newFakeBackend(t, "secret")
	fb.setState("new-hash", "10.0.0.9\n")
	fb.failExport.Store(true)
	store := newTargetStore([]Target{{Addr: "10.0.0.1"}})
	cfg := TargetSyncConfig{BackendURL: fb.srv.URL, SyncToken: "secret", Store: store}

	got := syncTargetsCycle(context.Background(), cfg, "previous-hash")

	if got != "previous-hash" {
		t.Errorf("syncTargetsCycle() with failing export endpoint returned %q, want unchanged %q", got, "previous-hash")
	}
	if len(store.Targets()) != 1 || store.Targets()[0].Addr != "10.0.0.1" {
		t.Errorf("Targets() changed despite export fetch failure: %+v", store.Targets())
	}
}

func TestSyncTargetsCycle_PersistsFetchedBodyToTargetsFile(t *testing.T) {
	fb := newFakeBackend(t, "secret")
	body := "10.0.9.5,root\n"
	fb.setState("hash-5", body)
	store := newTargetStore(nil)
	dir := t.TempDir()
	targetsFile := filepath.Join(dir, "targets.txt")

	cfg := TargetSyncConfig{
		BackendURL: fb.srv.URL, SyncToken: "secret", Store: store, TargetsFile: targetsFile,
	}
	syncTargetsCycle(context.Background(), cfg, "")

	got, err := os.ReadFile(targetsFile)
	if err != nil {
		t.Fatalf("ReadFile(%s) error = %v", targetsFile, err)
	}
	if string(got) != body {
		t.Errorf("targets file content = %q, want %q", got, body)
	}
}

func TestSyncTargetsCycle_ReconcilesRemovedTargets(t *testing.T) {
	_, rdb, sha := newTestRedis(t)
	ctx := context.Background()
	reconcileSha, err := loadReconcileScript(ctx, rdb)
	if err != nil {
		t.Fatalf("loadReconcileScript() error = %v", err)
	}

	removedAddr := "10.0.9.9"
	ev := Event{Addr: removedAddr, OK: false, TS: 1000, NodeIDs: []string{"node-901"}}
	if _, err := publishAndAggregate(ctx, rdb, sha, ev); err != nil {
		t.Fatalf("seed publish error = %v", err)
	}
	assertHashField(t, ctx, rdb, "stats:node:node-901", "down", "1")

	fb := newFakeBackend(t, "secret")
	// removedAddr is no longer in the fetched target list at all.
	fb.setState("hash-9", "10.0.9.8\n")
	store := newTargetStore([]Target{{Addr: removedAddr, NodeIDs: []string{"node-901"}}})

	cfg := TargetSyncConfig{
		BackendURL: fb.srv.URL, SyncToken: "secret", Store: store,
		RDB: rdb, ReconcileSha: reconcileSha,
	}
	syncTargetsCycle(ctx, cfg, "")

	assertHashField(t, ctx, rdb, "stats:node:node-901", "down", "0")
	if _, err := rdb.Get(ctx, "state:device:"+removedAddr).Result(); err != redis.Nil {
		t.Errorf("state:device:%s error = %v, want redis.Nil (should be reconciled away)", removedAddr, err)
	}
}

// ── runTargetSync ───────────────────────────────────────────────────────

func TestRunTargetSync_AppliesReloadOnTick(t *testing.T) {
	fb := newFakeBackend(t, "secret")
	fb.setState("hash-loop", "10.0.9.20\n")
	store := newTargetStore(nil)

	stop := runTargetSync(context.Background(), TargetSyncConfig{
		BackendURL: fb.srv.URL, SyncToken: "secret", Interval: 20 * time.Millisecond, Store: store,
	})

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if len(store.Targets()) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	stop()

	targets := store.Targets()
	if len(targets) != 1 || targets[0].Addr != "10.0.9.20" {
		t.Fatalf("Targets() after runTargetSync tick = %+v, want [{10.0.9.20 []}]", targets)
	}
}

func TestRunTargetSync_StopReturnsPromptlyWithNoTicksFired(t *testing.T) {
	fb := newFakeBackend(t, "secret")
	store := newTargetStore(nil)

	stop := runTargetSync(context.Background(), TargetSyncConfig{
		BackendURL: fb.srv.URL, SyncToken: "secret", Interval: time.Hour, Store: store,
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

	if fb.hashHits.Load() != 0 {
		t.Errorf("hash endpoint hit %d times, want 0 (interval never fired)", fb.hashHits.Load())
	}
}
