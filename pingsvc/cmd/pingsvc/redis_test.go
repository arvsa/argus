package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// newTestRedis spins up an in-memory miniredis instance and a go-redis
// client pointed at it, loading the production publishIfChangedAndAggregateScript
// so tests exercise the exact same Lua the pingsvc binary ships.
func newTestRedis(t *testing.T) (*miniredis.Miniredis, *redis.Client, string) {
	t.Helper()
	s := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: s.Addr()})
	t.Cleanup(func() { rdb.Close() })

	ctx := context.Background()
	sha, err := loadPublishScript(ctx, rdb)
	if err != nil {
		t.Fatalf("loadPublishScript() error = %v", err)
	}
	return s, rdb, sha
}

func TestPublishAndAggregate_FirstSeenStatePublishes(t *testing.T) {
	_, rdb, sha := newTestRedis(t)
	ctx := context.Background()

	ev := Event{Addr: "10.0.0.1", OK: true, TS: 1000}

	published, err := publishAndAggregate(ctx, rdb, sha, ev)
	if err != nil {
		t.Fatalf("publishAndAggregate() error = %v", err)
	}
	if !published {
		t.Fatalf("publishAndAggregate() published = false, want true (first observation of a device is always a state change from nil)")
	}

	raw, err := rdb.HGet(ctx, "pings:state", ev.Addr).Result()
	if err != nil {
		t.Fatalf("pings:state HGET error = %v", err)
	}
	var got Event
	if err := json.Unmarshal([]byte(raw), &got); err != nil {
		t.Fatalf("failed to unmarshal stored snapshot: %v", err)
	}
	if got.Addr != ev.Addr || got.OK != ev.OK {
		t.Errorf("stored snapshot = %+v, want addr/ok matching %+v", got, ev)
	}

	score, err := rdb.ZScore(ctx, "pings:index", ev.Addr).Result()
	if err != nil {
		t.Fatalf("pings:index ZSCORE error = %v", err)
	}
	if score != float64(ev.TS) {
		t.Errorf("pings:index score = %v, want %v", score, ev.TS)
	}
}

func TestPublishAndAggregate_UnchangedStateDoesNotRepublish(t *testing.T) {
	_, rdb, sha := newTestRedis(t)
	ctx := context.Background()

	ev := Event{Addr: "10.0.0.2", OK: true, TS: 1000}

	if _, err := publishAndAggregate(ctx, rdb, sha, ev); err != nil {
		t.Fatalf("first publishAndAggregate() error = %v", err)
	}

	// Same state ("up") again, later timestamp — script should treat this as
	// a no-op (mirrors pingsvc's own in-process stateCache short-circuit, but
	// at the Redis layer the Lua script enforces it independently too).
	ev2 := Event{Addr: "10.0.0.2", OK: true, TS: 2000}
	published, err := publishAndAggregate(ctx, rdb, sha, ev2)
	if err != nil {
		t.Fatalf("second publishAndAggregate() error = %v", err)
	}
	if published {
		t.Fatalf("publishAndAggregate() published = true on unchanged state, want false")
	}

	// pings:index must NOT have been updated to ts=2000 since the script
	// returned early before the ZADD call.
	score, err := rdb.ZScore(ctx, "pings:index", ev.Addr).Result()
	if err != nil {
		t.Fatalf("pings:index ZSCORE error = %v", err)
	}
	if score != float64(ev.TS) {
		t.Errorf("pings:index score = %v, want unchanged %v (no-op should skip ZADD)", score, ev.TS)
	}
}

func TestPublishAndAggregate_StateFlipPublishesAgain(t *testing.T) {
	_, rdb, sha := newTestRedis(t)
	ctx := context.Background()

	addr := "10.0.0.3"
	up := Event{Addr: addr, OK: true, TS: 1000}
	down := Event{Addr: addr, OK: false, TS: 2000}

	if _, err := publishAndAggregate(ctx, rdb, sha, up); err != nil {
		t.Fatalf("up publish error = %v", err)
	}
	published, err := publishAndAggregate(ctx, rdb, sha, down)
	if err != nil {
		t.Fatalf("down publish error = %v", err)
	}
	if !published {
		t.Fatalf("publishAndAggregate() published = false on up->down flip, want true")
	}
}

func TestPublishAndAggregate_NodeIDsChangeRepublishesEvenWithoutStateFlip(t *testing.T) {
	// A device that was already down (or up) before being assigned to a
	// Node, then reassigned via a targets.txt regenerate + pingsvc restart,
	// has no up/down transition to report -- but stats:node:<id> for its
	// newly-assigned ancestor chain must still get populated on the very
	// next observation, or the Hierarchy page is stuck showing 0 up/0 down
	// forever despite the device genuinely being down (the exact bug
	// reported in production: state:device:<addr> only encoded up/down,
	// so an unchanged state silently skipped the aggregation loop even
	// though NodeIDs had changed).
	_, rdb, sha := newTestRedis(t)
	ctx := context.Background()

	addr := "10.0.4.1"
	bare := Event{Addr: addr, OK: false, TS: 1000}
	if _, err := publishAndAggregate(ctx, rdb, sha, bare); err != nil {
		t.Fatalf("first (bare) publish error = %v", err)
	}

	assigned := Event{Addr: addr, OK: false, TS: 2000, NodeIDs: []string{"node-201"}}
	published, err := publishAndAggregate(ctx, rdb, sha, assigned)
	if err != nil {
		t.Fatalf("second (assigned) publish error = %v", err)
	}
	if !published {
		t.Fatalf("publishAndAggregate() published = false when NodeIDs changed with no state flip, want true")
	}
	assertHashField(t, ctx, rdb, "stats:node:node-201", "down", "1")
}

func TestPublishAndAggregate_NodeCountersTrackUpDown(t *testing.T) {
	_, rdb, sha := newTestRedis(t)
	ctx := context.Background()

	nodeKey := "stats:node:node-101"

	a := Event{Addr: "10.0.3.1", OK: true, TS: 1000, NodeIDs: []string{"node-101"}}
	if _, err := publishAndAggregate(ctx, rdb, sha, a); err != nil {
		t.Fatalf("publish error = %v", err)
	}
	assertHashField(t, ctx, rdb, nodeKey, "up", "1")
	assertHashFieldMissing(t, ctx, rdb, nodeKey, "down")

	aDown := Event{Addr: "10.0.3.1", OK: false, TS: 2000, NodeIDs: []string{"node-101"}}
	if _, err := publishAndAggregate(ctx, rdb, sha, aDown); err != nil {
		t.Fatalf("down publish error = %v", err)
	}
	assertHashField(t, ctx, rdb, nodeKey, "up", "0")
	assertHashField(t, ctx, rdb, nodeKey, "down", "1")
}

func TestPublishAndAggregate_NodeIDsUpdatesEveryAncestorInChain(t *testing.T) {
	_, rdb, sha := newTestRedis(t)
	ctx := context.Background()

	// Ancestor chain: campus -> building -> room, all counters must move
	// together for a single device state change (plan §4.2: fan-out
	// proportional to depth, not a fixed level count).
	ancestors := []string{"campus-1", "building-2", "room-3"}
	ev := Event{Addr: "10.0.3.2", OK: true, TS: 1000, NodeIDs: ancestors}
	if _, err := publishAndAggregate(ctx, rdb, sha, ev); err != nil {
		t.Fatalf("publish error = %v", err)
	}

	for _, id := range ancestors {
		assertHashField(t, ctx, rdb, "stats:node:"+id, "up", "1")
	}
}

func TestPublishAndAggregate_EmptyNodeIDsDoesNotWriteAnyNodeCounters(t *testing.T) {
	_, rdb, sha := newTestRedis(t)
	ctx := context.Background()

	ev := Event{Addr: "10.0.3.4", OK: true, TS: 1000}
	if _, err := publishAndAggregate(ctx, rdb, sha, ev); err != nil {
		t.Fatalf("publish error = %v", err)
	}

	keys, err := rdb.Keys(ctx, "stats:node:*").Result()
	if err != nil {
		t.Fatalf("KEYS stats:node:* error = %v", err)
	}
	if len(keys) != 0 {
		t.Errorf("stats:node:* keys = %v, want none for an event with no NodeIDs", keys)
	}
}

// NOTE: publishIfChangedAndAggregateScript also PUBLISHes to pings:events /
// events:node:<id> depending on which IDs are set on the event. That
// channel-routing behavior is intentionally NOT covered here: miniredis's
// Lua interpreter executes `redis.call("PUBLISH", ...)` and returns success,
// but does not relay the message to its own pubsub dispatcher, so a
// go-redis Subscribe()'d client never observes it (verified directly: a
// Lua-issued PUBLISH against miniredis is silently dropped while a
// client-issued rdb.Publish() to the same channel is delivered normally).
// This is a miniredis test-double limitation, not a pingsvc bug — exercising
// the real channel routing requires an integration test against a real Redis
// (see docker compose's `redis` service / compose.yml).

func assertHashField(
	t *testing.T, ctx context.Context, rdb *redis.Client, key, field, want string,
) {
	t.Helper()
	got, err := rdb.HGet(ctx, key, field).Result()
	if err != nil {
		t.Fatalf("HGET %s %s error = %v", key, field, err)
	}
	if got != want {
		t.Errorf("HGET %s %s = %q, want %q", key, field, got, want)
	}
}

func assertHashFieldMissing(
	t *testing.T, ctx context.Context, rdb *redis.Client, key, field string,
) {
	t.Helper()
	_, err := rdb.HGet(ctx, key, field).Result()
	if err != redis.Nil {
		t.Errorf("HGET %s %s = (err=%v), want redis.Nil (field should not exist)", key, field, err)
	}
}
