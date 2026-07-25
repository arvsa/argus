package main

import (
	"context"
	"net"
	"sort"
	"time"

	probing "github.com/go-ping/ping"
)

// NeighborEntry is one row from the OS's own resolved neighbor
// (ARP/NDP) table.
type NeighborEntry struct {
	Addr string
	MAC  string
}

// readARPTable reads the OS's current neighbor table -- set per-platform
// at init (see arpsweep_linux.go / arpsweep_other.go). A package-level var
// rather than an interface param so tests can override it directly with a
// fixture, without needing real proc/network access on any platform.
var readARPTable func() ([]NeighborEntry, error)

// ArpSweepConfig configures sweepSubnet.
type ArpSweepConfig struct {
	PingTimeout time.Duration

	// pingFn is test-only: overrides the real fire-and-forget ping used to
	// provoke ARP resolution, so tests need neither real ICMP privileges
	// nor network access.
	pingFn func(addr string)
}

func (cfg ArpSweepConfig) ping(addr string) {
	if cfg.pingFn != nil {
		cfg.pingFn(addr)
		return
	}
	timeout := cfg.PingTimeout
	if timeout == 0 {
		timeout = 1 * time.Second
	}
	pinger, err := probing.NewPinger(addr)
	if err != nil {
		return
	}
	pinger.Count = 1
	pinger.Timeout = timeout
	_ = pinger.Run() // best-effort -- only provoking ARP resolution, result unused
}

// sweepSubnet pings every host address in cidr (the lighter-weight
// bootstrap needing no SNMP credentials, plan/device-discovery-v1.md
// §2.1), then reads back the OS's own resolved neighbor table, filtered
// to addresses within cidr. Unresponsive addresses simply don't appear in
// the OS table afterward -- no per-address error, only entries the OS
// actually resolved end up in the result.
func sweepSubnet(ctx context.Context, cidr string, cfg ArpSweepConfig) ([]ArpBinding, error) {
	_, ipNet, err := net.ParseCIDR(cidr)
	if err != nil {
		return nil, err
	}

	for _, addr := range hostAddrs(ipNet) {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		cfg.ping(addr)
	}

	neighbors, err := readARPTable()
	if err != nil {
		return nil, err
	}

	var bindings []ArpBinding
	for _, n := range neighbors {
		ip := net.ParseIP(n.Addr)
		if ip == nil || !ipNet.Contains(ip) {
			continue
		}
		bindings = append(bindings, ArpBinding{Addr: n.Addr, MAC: n.MAC})
	}
	sort.Slice(bindings, func(i, j int) bool { return bindings[i].Addr < bindings[j].Addr })
	return bindings, nil
}

// hostAddrs enumerates usable host addresses in ipNet, excluding the
// network/broadcast addresses for anything with more than 2 addresses.
// Only sized for realistic LAN subnets (a /24 or smaller) -- sweepSubnet
// is meant to target a configured local subnet, not an arbitrarily large
// range.
func hostAddrs(ipNet *net.IPNet) []string {
	var out []string
	for ip := cloneIP(ipNet.IP.Mask(ipNet.Mask)); ipNet.Contains(ip); incIP(ip) {
		out = append(out, ip.String())
	}
	if len(out) > 2 {
		out = out[1 : len(out)-1]
	}
	return out
}

func cloneIP(ip net.IP) net.IP {
	out := make(net.IP, len(ip))
	copy(out, ip)
	return out
}

func incIP(ip net.IP) {
	for i := len(ip) - 1; i >= 0; i-- {
		ip[i]++
		if ip[i] != 0 {
			break
		}
	}
}
