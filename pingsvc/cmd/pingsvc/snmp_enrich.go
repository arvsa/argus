package main

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/gosnmp/gosnmp"
)

// SNMP MIB-II scalar OIDs (RFC 1213) -- standard, vendor-neutral, present
// on essentially any device with SNMP enabled at all.
const (
	oidSysName  = "1.3.6.1.2.1.1.5.0"
	oidSysDescr = "1.3.6.1.2.1.1.1.0"
)

// snmpGetter is the minimal subset of gosnmp's client interface
// enrichHostnames needs. Letting production code depend on this instead of
// *gosnmp.GoSNMP directly means tests can inject a fully in-process fake
// SNMP responder (see snmp_enrich_test.go) -- no real network I/O, no
// Docker/mock-SNMP-agent needed to exercise the logic in `go test ./...`.
type snmpGetter interface {
	Connect() error
	Get(oids []string) (*gosnmp.SnmpPacket, error)
	Close() error
}

// EnrichedDevice is one endpoint's SNMP-derived hostname.
type EnrichedDevice struct {
	Addr     string
	Hostname string
}

// EnrichConfig configures enrichHostnames. Community/Timeout/Retries are
// per-request SNMP client settings; newClient is test-only (nil in
// production, where a real *gosnmp.GoSNMP is built per target).
type EnrichConfig struct {
	Community string
	// Short timeout, low retry count, per plan/device-discovery-v1.md §4's
	// "SNMP enrichment's realistic yield is low for most endpoints" note --
	// polling thousands of unreachable/filtered targets at the library's
	// multi-second defaults would dominate a discovery cycle.
	Timeout time.Duration
	Retries int

	newClient func(addr string) snmpGetter
}

func (cfg EnrichConfig) clientFor(addr string) snmpGetter {
	if cfg.newClient != nil {
		return cfg.newClient(addr)
	}
	return &gosnmp.GoSNMP{
		Target:    addr,
		Port:      161,
		Community: cfg.Community,
		Version:   gosnmp.Version2c,
		Timeout:   cfg.Timeout,
		Retries:   cfg.Retries,
	}
}

// maxEnrichConcurrency bounds concurrent unicast SNMP GETs -- this is
// per-endpoint enrichment, not a table walk, so a small dedicated pool
// (closer in shape to the ICMP worker pool, but at much lower target-count/
// frequency) rather than reusing the ping pipeline's own.
const maxEnrichConcurrency = 10

// enrichHostnames does a unicast SNMP GET (sysName, falling back to
// sysDescr) against each addr, concurrently and independently -- a target
// that doesn't respond (timeout, connection refused, no SNMP agent at all)
// is simply omitted from the result. One unresponsive target must never
// block or fail the whole batch, since a real deployment will have many
// endpoints with SNMP disabled or filtered.
func enrichHostnames(ctx context.Context, addrs []string, cfg EnrichConfig) []EnrichedDevice {
	sem := make(chan struct{}, maxEnrichConcurrency)
	results := make(chan EnrichedDevice, len(addrs))
	var wg sync.WaitGroup

	for _, addr := range addrs {
		select {
		case <-ctx.Done():
		default:
		}

		wg.Add(1)
		go func(addr string) {
			defer wg.Done()

			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()

			if hostname, ok := enrichOne(addr, cfg); ok {
				results <- EnrichedDevice{Addr: addr, Hostname: hostname}
			}
		}(addr)
	}

	go func() {
		wg.Wait()
		close(results)
	}()

	out := make([]EnrichedDevice, 0, len(addrs))
	for r := range results {
		out = append(out, r)
	}
	return out
}

// enrichOne queries a single address. ok is false whenever no usable
// hostname was obtained -- connection failure, GET error/timeout, or a
// response with both sysName and sysDescr empty.
func enrichOne(addr string, cfg EnrichConfig) (hostname string, ok bool) {
	client := cfg.clientFor(addr)
	if err := client.Connect(); err != nil {
		return "", false
	}
	defer client.Close()

	result, err := client.Get([]string{oidSysName, oidSysDescr})
	if err != nil || result == nil {
		return "", false
	}

	var sysName, sysDescr string
	for _, v := range result.Variables {
		oid := strings.TrimPrefix(v.Name, ".")
		switch oid {
		case oidSysName:
			sysName = pduString(v.Value)
		case oidSysDescr:
			sysDescr = pduString(v.Value)
		}
	}

	// sysName is the more hostname-like field when populated, but it's
	// optional per MIB-II and often left blank in practice -- sysDescr
	// (free-text device description) is a reasonable second choice over
	// no name at all.
	if sysName != "" {
		return sysName, true
	}
	if sysDescr != "" {
		return sysDescr, true
	}
	return "", false
}

func pduString(v any) string {
	switch val := v.(type) {
	case []byte:
		return string(val)
	case string:
		return val
	default:
		return ""
	}
}
