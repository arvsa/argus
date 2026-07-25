package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

// InfraTargetInternal mirrors the backend's InfraPollTargetInternal shape
// (GET /discovery/infra-targets-internal, plan/device-discovery-v1.md
// §2.6) -- the decrypted, pingsvc-usable per-target SNMP credential.
type InfraTargetInternal struct {
	Addr      string `json:"addr"`
	Community string `json:"community"`
	Kind      string `json:"kind"`
}

// DiscoveredDeviceReport mirrors the backend's DiscoveredDeviceReport
// shape -- one entry in POST /devices/discovered's batch (plan §2.7).
type DiscoveredDeviceReport struct {
	Addr          string `json:"addr"`
	MAC           string `json:"mac,omitempty"`
	Hostname      string `json:"hostname,omitempty"`
	DiscoveredVia string `json:"discovered_via"`
}

// DiscoveryConfig configures runDiscovery. See "pingsvc: discovery
// subsystem" (plan §2.8): each cycle pulls the current infra-target list,
// polls each via snmp_infra.go, runs snmp_enrich.go against whatever IPs
// are now known, and pushes accumulated results -- reusing the exact
// connection/auth pattern targetsync.go already established for the
// reverse direction (ARGUS_BACKEND_URL/ARGUS_PINGSVC_SYNC_TOKEN, no new
// pingsvc-side connection config).
type DiscoveryConfig struct {
	BackendURL string
	SyncToken  string
	Interval   time.Duration

	// SNMPTimeout/SNMPRetries apply to both infra-target polling and
	// endpoint enrichment -- short timeout, low retry count (plan §4:
	// polling many unreachable/filtered targets at the library's
	// multi-second defaults would dominate a cycle).
	SNMPTimeout time.Duration
	SNMPRetries int
	// EnrichCommunity is the community used for endpoint enrichment
	// (snmp_enrich.go) -- a separate, much lower-stakes operation than
	// infra-target polling, which has its own per-target credential from
	// InfraTargetInternal.
	EnrichCommunity string

	// HTTPClient defaults to a 5s-timeout client if nil.
	HTTPClient *http.Client

	newInfraClient  func(addr string) snmpWalker
	newEnrichClient func(addr string) snmpGetter
}

// runDiscovery starts a goroutine that periodically runs a discovery
// cycle, independent of the ping pipeline's own goroutines (same
// isolation rationale as the exporter/target-sync). Returns a stop func
// that cancels the goroutine and waits for it to exit.
func runDiscovery(ctx context.Context, cfg DiscoveryConfig) func() {
	discCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})

	go func() {
		defer close(done)
		ticker := time.NewTicker(cfg.Interval)
		defer ticker.Stop()
		for {
			select {
			case <-discCtx.Done():
				return
			case <-ticker.C:
				runDiscoveryCycle(discCtx, cfg)
			}
		}
	}()

	return func() {
		cancel()
		<-done
	}
}

// runDiscoveryCycle pulls the current infra-target list, polls each
// (logging and continuing past any single target's failure rather than
// blocking the cycle), enriches whatever addresses were found, and
// pushes the accumulated batch. A failure fetching targets or pushing
// results is logged and self-heals on the next tick, same posture as
// targetsync's syncTargetsCycle.
func runDiscoveryCycle(ctx context.Context, cfg DiscoveryConfig) {
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 5 * time.Second}
	}

	targets, err := fetchInfraTargets(ctx, cfg)
	if err != nil {
		log.Printf("discovery: failed to fetch infra targets: %v", err)
		return
	}
	if len(targets) == 0 {
		return
	}

	var bindings []ArpBinding
	for _, target := range targets {
		got, err := pollArpTable(target.Addr, InfraPollConfig{
			Community: target.Community,
			Timeout:   cfg.SNMPTimeout,
			Retries:   cfg.SNMPRetries,
			newClient: cfg.newInfraClient,
		})
		if err != nil {
			log.Printf("discovery: failed to poll infra target %s: %v", target.Addr, err)
			continue
		}
		bindings = append(bindings, got...)
	}
	if len(bindings) == 0 {
		return
	}

	addrs := make([]string, len(bindings))
	for i, b := range bindings {
		addrs[i] = b.Addr
	}
	enriched := enrichHostnames(ctx, addrs, EnrichConfig{
		Community: cfg.EnrichCommunity,
		Timeout:   cfg.SNMPTimeout,
		Retries:   cfg.SNMPRetries,
		newClient: cfg.newEnrichClient,
	})
	hostnameByAddr := make(map[string]string, len(enriched))
	for _, e := range enriched {
		hostnameByAddr[e.Addr] = e.Hostname
	}

	reports := make([]DiscoveredDeviceReport, len(bindings))
	for i, b := range bindings {
		reports[i] = DiscoveredDeviceReport{
			Addr:          b.Addr,
			MAC:           b.MAC,
			Hostname:      hostnameByAddr[b.Addr],
			DiscoveredVia: "arp",
		}
	}

	if err := pushDiscoveredDevices(ctx, cfg, reports); err != nil {
		log.Printf("discovery: failed to push discovered devices: %v", err)
	}
}

func fetchInfraTargets(ctx context.Context, cfg DiscoveryConfig) ([]InfraTargetInternal, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.BackendURL+"/api/v1/discovery/infra-targets-internal", nil)
	if err != nil {
		return nil, fmt.Errorf("build infra-targets-internal request: %w", err)
	}
	req.Header.Set("X-Pingsvc-Token", cfg.SyncToken)

	resp, err := cfg.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("GET infra-targets-internal: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET infra-targets-internal: unexpected status %d", resp.StatusCode)
	}

	var targets []InfraTargetInternal
	if err := json.NewDecoder(resp.Body).Decode(&targets); err != nil {
		return nil, fmt.Errorf("decode infra-targets-internal response: %w", err)
	}
	return targets, nil
}

func pushDiscoveredDevices(ctx context.Context, cfg DiscoveryConfig, reports []DiscoveredDeviceReport) error {
	body, err := json.Marshal(struct {
		Reports []DiscoveredDeviceReport `json:"reports"`
	}{Reports: reports})
	if err != nil {
		return fmt.Errorf("marshal discovered-devices batch: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cfg.BackendURL+"/api/v1/devices/discovered", bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build devices/discovered request: %w", err)
	}
	req.Header.Set("X-Pingsvc-Token", cfg.SyncToken)
	req.Header.Set("Content-Type", "application/json")

	resp, err := cfg.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("POST devices/discovered: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("POST devices/discovered: unexpected status %d: %s", resp.StatusCode, respBody)
	}
	return nil
}
