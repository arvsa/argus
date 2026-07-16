package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
)

// fakeDiscoveryBackend serves canned /api/v1/discovery/infra-targets-internal
// and /api/v1/devices/discovered responses, and records every pushed
// batch -- lets tests assert the full pull-poll-enrich-push cycle without
// a real FastAPI backend, mirroring fakeBackend in targetsync_test.go.
type fakeDiscoveryBackend struct {
	srv *httptest.Server

	mu            sync.Mutex
	infraTargets  []InfraTargetInternal
	pushedBatches [][]DiscoveredDeviceReport
	infraStatus   int
	pushStatus    int
}

func newFakeDiscoveryBackend(t *testing.T, wantToken string) *fakeDiscoveryBackend {
	t.Helper()
	fb := &fakeDiscoveryBackend{}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/discovery/infra-targets-internal", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Pingsvc-Token") != wantToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		fb.mu.Lock()
		defer fb.mu.Unlock()
		if fb.infraStatus != 0 {
			w.WriteHeader(fb.infraStatus)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(fb.infraTargets)
	})
	mux.HandleFunc("/api/v1/devices/discovered", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Pingsvc-Token") != wantToken {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		fb.mu.Lock()
		defer fb.mu.Unlock()
		if fb.pushStatus != 0 {
			w.WriteHeader(fb.pushStatus)
			return
		}
		var body struct {
			Reports []DiscoveredDeviceReport `json:"reports"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		fb.pushedBatches = append(fb.pushedBatches, body.Reports)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data": [], "count": 0}`)
	})

	fb.srv = httptest.NewServer(mux)
	t.Cleanup(fb.srv.Close)
	return fb
}

func (fb *fakeDiscoveryBackend) setInfraTargets(targets []InfraTargetInternal) {
	fb.mu.Lock()
	defer fb.mu.Unlock()
	fb.infraTargets = targets
}

func (fb *fakeDiscoveryBackend) lastPush() []DiscoveredDeviceReport {
	fb.mu.Lock()
	defer fb.mu.Unlock()
	if len(fb.pushedBatches) == 0 {
		return nil
	}
	return fb.pushedBatches[len(fb.pushedBatches)-1]
}

func (fb *fakeDiscoveryBackend) pushCount() int {
	fb.mu.Lock()
	defer fb.mu.Unlock()
	return len(fb.pushedBatches)
}

func macPDU(ipv4 string, mac []byte) gosnmp.SnmpPDU {
	return gosnmp.SnmpPDU{
		Name:  oidIpNetToPhysicalPhysAddress + ".1.1.4." + ipv4,
		Type:  gosnmp.OctetString,
		Value: mac,
	}
}

func noEnrichmentClient(addr string) snmpGetter {
	return &fakeSNMPGetter{getErr: errors.New("no enrichment configured for this test")}
}

func TestRunDiscoveryCycle_PollsAndPushesExtractedBindings(t *testing.T) {
	fb := newFakeDiscoveryBackend(t, "secret")
	fb.setInfraTargets([]InfraTargetInternal{{Addr: "192.0.2.1", Community: "public", Kind: "router"}})

	mac := []byte{0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x01}
	cfg := DiscoveryConfig{
		BackendURL: fb.srv.URL,
		SyncToken:  "secret",
		newInfraClient: func(addr string) snmpWalker {
			return &fakeSNMPWalker{pdus: []gosnmp.SnmpPDU{macPDU("10.0.0.1", mac)}}
		},
		newEnrichClient: noEnrichmentClient,
	}

	runDiscoveryCycle(context.Background(), cfg)

	if fb.pushCount() != 1 {
		t.Fatalf("push count = %d, want 1", fb.pushCount())
	}
	got := fb.lastPush()
	want := []DiscoveredDeviceReport{{Addr: "10.0.0.1", MAC: "AA:BB:CC:DD:EE:01", DiscoveredVia: "arp"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("pushed reports = %+v, want %+v", got, want)
	}
}

func TestRunDiscoveryCycle_EnrichesHostnameWhenAvailable(t *testing.T) {
	fb := newFakeDiscoveryBackend(t, "secret")
	fb.setInfraTargets([]InfraTargetInternal{{Addr: "192.0.2.1", Community: "public", Kind: "router"}})

	mac := []byte{0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x05}
	cfg := DiscoveryConfig{
		BackendURL: fb.srv.URL,
		SyncToken:  "secret",
		newInfraClient: func(addr string) snmpWalker {
			return &fakeSNMPWalker{pdus: []gosnmp.SnmpPDU{macPDU("10.0.0.5", mac)}}
		},
		newEnrichClient: func(addr string) snmpGetter {
			return &fakeSNMPGetter{variables: []gosnmp.SnmpPDU{
				{Name: "." + oidSysName, Type: gosnmp.OctetString, Value: []byte("switch-5")},
			}}
		},
	}

	runDiscoveryCycle(context.Background(), cfg)

	want := []DiscoveredDeviceReport{
		{Addr: "10.0.0.5", MAC: "AA:BB:CC:DD:EE:05", Hostname: "switch-5", DiscoveredVia: "arp"},
	}
	if got := fb.lastPush(); !reflect.DeepEqual(got, want) {
		t.Fatalf("pushed reports = %+v, want %+v", got, want)
	}
}

func TestRunDiscoveryCycle_UnresponsiveInfraTargetLogsAndContinues(t *testing.T) {
	fb := newFakeDiscoveryBackend(t, "secret")
	fb.setInfraTargets([]InfraTargetInternal{
		{Addr: "192.0.2.1", Community: "public", Kind: "router"}, // fails
		{Addr: "192.0.2.2", Community: "public", Kind: "router"}, // succeeds
	})

	mac := []byte{0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x02}
	cfg := DiscoveryConfig{
		BackendURL: fb.srv.URL,
		SyncToken:  "secret",
		newInfraClient: func(addr string) snmpWalker {
			if addr == "192.0.2.1" {
				return &fakeSNMPWalker{connectErr: errors.New("connection refused")}
			}
			return &fakeSNMPWalker{pdus: []gosnmp.SnmpPDU{macPDU("10.0.0.2", mac)}}
		},
		newEnrichClient: noEnrichmentClient,
	}

	runDiscoveryCycle(context.Background(), cfg)

	got := fb.lastPush()
	want := []DiscoveredDeviceReport{{Addr: "10.0.0.2", MAC: "AA:BB:CC:DD:EE:02", DiscoveredVia: "arp"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("pushed reports = %+v, want %+v (192.0.2.1's failure must not block 192.0.2.2's binding)", got, want)
	}
}

func TestRunDiscoveryCycle_InfraTargetsFetchErrorDoesNothing(t *testing.T) {
	fb := newFakeDiscoveryBackend(t, "secret")
	fb.infraStatus = http.StatusInternalServerError

	cfg := DiscoveryConfig{BackendURL: fb.srv.URL, SyncToken: "secret"}
	runDiscoveryCycle(context.Background(), cfg)

	if fb.pushCount() != 0 {
		t.Fatalf("push count = %d, want 0 (fetch failed, cycle should no-op)", fb.pushCount())
	}
}

func TestRunDiscoveryCycle_NoInfraTargetsIsNoOp(t *testing.T) {
	fb := newFakeDiscoveryBackend(t, "secret")
	fb.setInfraTargets(nil)

	cfg := DiscoveryConfig{BackendURL: fb.srv.URL, SyncToken: "secret"}
	runDiscoveryCycle(context.Background(), cfg)

	if fb.pushCount() != 0 {
		t.Fatalf("push count = %d, want 0", fb.pushCount())
	}
}

func TestRunDiscoveryCycle_PushFailureDoesNotPanic(t *testing.T) {
	fb := newFakeDiscoveryBackend(t, "secret")
	fb.setInfraTargets([]InfraTargetInternal{{Addr: "192.0.2.1", Community: "public", Kind: "router"}})
	fb.pushStatus = http.StatusInternalServerError

	mac := []byte{0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x03}
	cfg := DiscoveryConfig{
		BackendURL: fb.srv.URL,
		SyncToken:  "secret",
		newInfraClient: func(addr string) snmpWalker {
			return &fakeSNMPWalker{pdus: []gosnmp.SnmpPDU{macPDU("10.0.0.3", mac)}}
		},
		newEnrichClient: noEnrichmentClient,
	}

	runDiscoveryCycle(context.Background(), cfg) // must not panic
}

func TestRunDiscovery_RunsCycleOnTick(t *testing.T) {
	fb := newFakeDiscoveryBackend(t, "secret")
	fb.setInfraTargets([]InfraTargetInternal{{Addr: "192.0.2.1", Community: "public", Kind: "router"}})
	mac := []byte{0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x04}
	cfg := DiscoveryConfig{
		BackendURL: fb.srv.URL,
		SyncToken:  "secret",
		Interval:   10 * time.Millisecond,
		newInfraClient: func(addr string) snmpWalker {
			return &fakeSNMPWalker{pdus: []gosnmp.SnmpPDU{macPDU("10.0.0.4", mac)}}
		},
		newEnrichClient: noEnrichmentClient,
	}

	stop := runDiscovery(context.Background(), cfg)
	defer stop()

	deadline := time.After(2 * time.Second)
	for fb.pushCount() == 0 {
		select {
		case <-deadline:
			t.Fatal("runDiscovery did not push within deadline")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestRunDiscovery_StopReturnsPromptlyWithNoTicksFired(t *testing.T) {
	cfg := DiscoveryConfig{BackendURL: "http://192.0.2.255:1", SyncToken: "secret", Interval: time.Hour}
	stop := runDiscovery(context.Background(), cfg)

	done := make(chan struct{})
	go func() {
		stop()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(1 * time.Second):
		t.Fatal("stop() did not return promptly")
	}
}
