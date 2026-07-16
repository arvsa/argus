package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sync/atomic"
	"time"

	"github.com/redis/go-redis/v9"
)

// targetState bundles the two pieces of state that must change together
// atomically on a hot reload: the target list itself and the addr->ancestor
// lookup workers use per-event (mirrors the targets/targetsByAddr pair
// main() used to build once at startup, see loadTargets).
type targetState struct {
	targets       []Target
	targetsByAddr map[string][]string
}

func newTargetState(targets []Target) *targetState {
	byAddr := make(map[string][]string, len(targets))
	for _, t := range targets {
		byAddr[t.Addr] = t.NodeIDs
	}
	return &targetState{targets: targets, targetsByAddr: byAddr}
}

// TargetStore holds the currently-active targetState behind an atomic
// pointer so worker goroutines and the tick loop in main() can read it
// concurrently while runTargetSync swaps in a freshly-fetched version --
// no mutex, no restart. Same pattern as identityStore (identity.go) for an
// analogous "set occasionally, read from many goroutines" problem; safe
// specifically because a swap always replaces the whole value rather than
// mutating either field in place.
type TargetStore struct {
	v atomic.Pointer[targetState]
}

func newTargetStore(initial []Target) *TargetStore {
	s := &TargetStore{}
	s.v.Store(newTargetState(initial))
	return s
}

// Targets returns the currently-active target list, for the tick loop to
// enqueue jobs from.
func (s *TargetStore) Targets() []Target {
	return s.v.Load().targets
}

// NodeIDsFor returns addr's current ancestor chain, for workers to attach
// to each Event.
func (s *TargetStore) NodeIDsFor(addr string) []string {
	return s.v.Load().targetsByAddr[addr]
}

func (s *TargetStore) set(targets []Target) {
	s.v.Store(newTargetState(targets))
}

// TargetSyncConfig configures runTargetSync. See the "Live Target Sync"
// plan: pingsvc polls the backend's /devices/targets-hash, and only fetches
// /devices/targets-export-internal (the real data) when the hash has
// changed since the last cycle.
type TargetSyncConfig struct {
	// BackendURL is this zone's own backend base URL, e.g.
	// "http://backend:8000" -- empty disables target sync entirely (opt-in,
	// same posture as the exporter's S3 config).
	BackendURL string
	SyncToken  string
	Interval   time.Duration
	// TargetsFile, if non-empty, is overwritten with the freshly-fetched
	// body on every successful reload, so a later real process restart
	// picks up the same state a hot reload already applied in memory.
	TargetsFile string
	Store       *TargetStore
	// RDB/ReconcileSha are optional; when both are set, a reload also runs
	// reconcileRemovedTargets against the new target list, exactly like
	// main()'s own startup path -- a device removed from the assignment
	// stops contributing stale up/down counts within one sync interval
	// instead of only at the next restart.
	RDB          redis.Cmdable
	ReconcileSha string
	// HTTPClient defaults to a 5s-timeout client if nil.
	HTTPClient *http.Client
}

// runTargetSync starts a goroutine that periodically polls the backend for
// target-list changes and hot-swaps cfg.Store, independent of the ping
// pipeline's own goroutines (same isolation rationale as runExporter).
// Returns a stop func that cancels the goroutine and waits for it to exit.
func runTargetSync(ctx context.Context, cfg TargetSyncConfig) func() {
	syncCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})

	go func() {
		defer close(done)
		ticker := time.NewTicker(cfg.Interval)
		defer ticker.Stop()
		var lastHash string
		for {
			select {
			case <-syncCtx.Done():
				return
			case <-ticker.C:
				lastHash = syncTargetsCycle(syncCtx, cfg, lastHash)
			}
		}
	}()

	return func() {
		cancel()
		<-done
	}
}

// syncTargetsCycle checks the backend's current targets hash against
// lastHash. A fetch error of either request is logged and treated as a
// no-op for this cycle (lastHash unchanged) -- transient backend/network
// trouble self-heals on the next tick rather than crashing the goroutine.
// Returns the hash that should be compared against next cycle.
func syncTargetsCycle(ctx context.Context, cfg TargetSyncConfig, lastHash string) string {
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 5 * time.Second}
	}

	hash, err := fetchTargetsHash(ctx, cfg)
	if err != nil {
		log.Printf("targetsync: failed to fetch targets hash: %v", err)
		return lastHash
	}
	if hash == lastHash {
		return lastHash
	}

	body, err := fetchTargetsExport(ctx, cfg)
	if err != nil {
		log.Printf("targetsync: failed to fetch targets export: %v", err)
		return lastHash
	}

	targets := parseTargets(body)
	cfg.Store.set(targets)

	if cfg.TargetsFile != "" {
		if err := os.WriteFile(cfg.TargetsFile, []byte(body), 0o644); err != nil {
			log.Printf("targetsync: failed to persist targets file %s: %v", cfg.TargetsFile, err)
		}
	}

	if cfg.RDB != nil && cfg.ReconcileSha != "" {
		newByAddr := cfg.Store.v.Load().targetsByAddr
		if err := reconcileRemovedTargets(ctx, cfg.RDB, cfg.ReconcileSha, newByAddr); err != nil {
			log.Printf("targetsync: reconcile removed targets: %v", err)
		}
	}

	log.Printf("targetsync: reloaded %d target(s), hash=%s", len(targets), hash)
	return hash
}

func fetchTargetsHash(ctx context.Context, cfg TargetSyncConfig) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.BackendURL+"/api/v1/devices/targets-hash", nil)
	if err != nil {
		return "", fmt.Errorf("build targets-hash request: %w", err)
	}
	req.Header.Set("X-Pingsvc-Token", cfg.SyncToken)

	resp, err := cfg.HTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("GET targets-hash: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET targets-hash: unexpected status %d", resp.StatusCode)
	}

	var decoded struct {
		Hash string `json:"hash"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&decoded); err != nil {
		return "", fmt.Errorf("decode targets-hash response: %w", err)
	}
	return decoded.Hash, nil
}

func fetchTargetsExport(ctx context.Context, cfg TargetSyncConfig) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.BackendURL+"/api/v1/devices/targets-export-internal", nil)
	if err != nil {
		return "", fmt.Errorf("build targets-export-internal request: %w", err)
	}
	req.Header.Set("X-Pingsvc-Token", cfg.SyncToken)

	resp, err := cfg.HTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("GET targets-export-internal: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("GET targets-export-internal: unexpected status %d", resp.StatusCode)
	}

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read targets-export-internal body: %w", err)
	}
	return string(raw), nil
}
