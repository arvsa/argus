package main

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

// withFakeARPTable overrides the package-level readARPTable for the
// duration of one test -- sweepSubnet's ping-then-read logic is tested
// entirely in-process this way, independent of platform (readARPTable's
// real implementation is Linux-only, see arpsweep_linux.go) and without
// needing real ICMP privileges.
func withFakeARPTable(t *testing.T, fn func() ([]NeighborEntry, error)) {
	t.Helper()
	prev := readARPTable
	readARPTable = fn
	t.Cleanup(func() { readARPTable = prev })
}

func noopPingConfig() ArpSweepConfig {
	return ArpSweepConfig{pingFn: func(addr string) {}}
}

func TestSweepSubnet_ReturnsBindingsWithinSubnet(t *testing.T) {
	withFakeARPTable(t, func() ([]NeighborEntry, error) {
		return []NeighborEntry{
			{Addr: "10.0.0.5", MAC: "AA:BB:CC:DD:EE:05"},
			{Addr: "10.0.0.9", MAC: "AA:BB:CC:DD:EE:09"},
			{Addr: "192.168.1.1", MAC: "AA:BB:CC:DD:EE:FF"}, // outside the swept subnet
		}, nil
	})

	got, err := sweepSubnet(context.Background(), "10.0.0.0/24", noopPingConfig())
	if err != nil {
		t.Fatalf("sweepSubnet() error = %v", err)
	}

	want := []ArpBinding{
		{Addr: "10.0.0.5", MAC: "AA:BB:CC:DD:EE:05"},
		{Addr: "10.0.0.9", MAC: "AA:BB:CC:DD:EE:09"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sweepSubnet() = %+v, want %+v", got, want)
	}
}

func TestSweepSubnet_PingsEveryHostAddressInSubnet(t *testing.T) {
	withFakeARPTable(t, func() ([]NeighborEntry, error) { return nil, nil })

	var pinged []string
	cfg := ArpSweepConfig{pingFn: func(addr string) { pinged = append(pinged, addr) }}

	if _, err := sweepSubnet(context.Background(), "203.0.113.0/30", cfg); err != nil {
		t.Fatalf("sweepSubnet() error = %v", err)
	}

	// /30 has 4 addresses total (.0 network, .1-.2 hosts, .3 broadcast) --
	// only the 2 usable host addresses should be pinged.
	want := []string{"203.0.113.1", "203.0.113.2"}
	if !reflect.DeepEqual(pinged, want) {
		t.Fatalf("pinged = %v, want %v", pinged, want)
	}
}

func TestSweepSubnet_InvalidCIDRReturnsError(t *testing.T) {
	if _, err := sweepSubnet(context.Background(), "not-a-cidr", noopPingConfig()); err == nil {
		t.Fatal("sweepSubnet() error = nil, want an error for an invalid CIDR")
	}
}

func TestSweepSubnet_ARPTableReadFailureReturnsError(t *testing.T) {
	withFakeARPTable(t, func() ([]NeighborEntry, error) {
		return nil, errors.New("not supported on this platform")
	})

	if _, err := sweepSubnet(context.Background(), "10.0.0.0/24", noopPingConfig()); err == nil {
		t.Fatal("sweepSubnet() error = nil, want the readARPTable error propagated")
	}
}

func TestSweepSubnet_ContextCancelledStopsEarly(t *testing.T) {
	withFakeARPTable(t, func() ([]NeighborEntry, error) { return nil, nil })

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := sweepSubnet(ctx, "10.0.0.0/24", noopPingConfig()); err == nil {
		t.Fatal("sweepSubnet() error = nil, want context.Canceled")
	}
}
