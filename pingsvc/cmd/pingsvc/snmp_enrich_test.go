package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/gosnmp/gosnmp"
)

// fakeSNMPGetter is an in-process fake SNMP responder -- enrichHostnames
// depends on the snmpGetter interface rather than *gosnmp.GoSNMP directly
// so these tests never touch the network (no Docker/mock-SNMP-agent
// needed to exercise the logic in `go test ./...`; the real mock-lan
// snmpsim environment, plan §2.9, is for later integration-level
// verification, not this package's unit tests).
type fakeSNMPGetter struct {
	connectErr error
	getErr     error
	variables  []gosnmp.SnmpPDU
}

func (f *fakeSNMPGetter) Connect() error { return f.connectErr }
func (f *fakeSNMPGetter) Close() error   { return nil }
func (f *fakeSNMPGetter) Get(oids []string) (*gosnmp.SnmpPacket, error) {
	if f.getErr != nil {
		return nil, f.getErr
	}
	return &gosnmp.SnmpPacket{Variables: f.variables}, nil
}

func octetStringPDU(oid, value string) gosnmp.SnmpPDU {
	return gosnmp.SnmpPDU{Name: "." + oid, Type: gosnmp.OctetString, Value: []byte(value)}
}

func TestEnrichHostnames_UsesSysNameWhenPresent(t *testing.T) {
	cfg := EnrichConfig{
		newClient: func(addr string) snmpGetter {
			return &fakeSNMPGetter{variables: []gosnmp.SnmpPDU{
				octetStringPDU(oidSysName, "switch-1"),
				octetStringPDU(oidSysDescr, "Cisco IOS Switch"),
			}}
		},
	}

	got := enrichHostnames(context.Background(), []string{"10.0.0.1"}, cfg)

	if len(got) != 1 || got[0] != (EnrichedDevice{Addr: "10.0.0.1", Hostname: "switch-1"}) {
		t.Fatalf("enrichHostnames() = %+v, want [{10.0.0.1 switch-1}]", got)
	}
}

func TestEnrichHostnames_FallsBackToSysDescrWhenSysNameEmpty(t *testing.T) {
	cfg := EnrichConfig{
		newClient: func(addr string) snmpGetter {
			return &fakeSNMPGetter{variables: []gosnmp.SnmpPDU{
				octetStringPDU(oidSysName, ""),
				octetStringPDU(oidSysDescr, "Generic Printer"),
			}}
		},
	}

	got := enrichHostnames(context.Background(), []string{"10.0.0.2"}, cfg)

	if len(got) != 1 || got[0] != (EnrichedDevice{Addr: "10.0.0.2", Hostname: "Generic Printer"}) {
		t.Fatalf("enrichHostnames() = %+v, want [{10.0.0.2 Generic Printer}]", got)
	}
}

func TestEnrichHostnames_NoUsableFieldsOmitsTarget(t *testing.T) {
	cfg := EnrichConfig{
		newClient: func(addr string) snmpGetter {
			return &fakeSNMPGetter{variables: []gosnmp.SnmpPDU{
				octetStringPDU(oidSysName, ""),
				octetStringPDU(oidSysDescr, ""),
			}}
		},
	}

	got := enrichHostnames(context.Background(), []string{"10.0.0.3"}, cfg)

	if len(got) != 0 {
		t.Fatalf("enrichHostnames() = %+v, want empty (no usable field)", got)
	}
}

func TestEnrichHostnames_UnresponsiveTargetOmittedWithoutBlockingBatch(t *testing.T) {
	// RED case from plan/device-discovery-v1.md §3 step 4: "given no
	// response, times out cleanly without blocking the cycle" -- one
	// unresponsive target must never hold up the others.
	cfg := EnrichConfig{
		newClient: func(addr string) snmpGetter {
			if addr == "10.0.0.9" {
				return &fakeSNMPGetter{getErr: errors.New("simulated timeout")}
			}
			return &fakeSNMPGetter{variables: []gosnmp.SnmpPDU{
				octetStringPDU(oidSysName, "known-host"),
			}}
		},
	}

	done := make(chan []EnrichedDevice, 1)
	go func() {
		done <- enrichHostnames(context.Background(), []string{"10.0.0.9", "10.0.0.10"}, cfg)
	}()

	select {
	case got := <-done:
		if len(got) != 1 || got[0] != (EnrichedDevice{Addr: "10.0.0.10", Hostname: "known-host"}) {
			t.Fatalf("enrichHostnames() = %+v, want only 10.0.0.10 enriched", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("enrichHostnames() blocked on an unresponsive target")
	}
}

func TestEnrichHostnames_ConnectFailureOmitsTarget(t *testing.T) {
	cfg := EnrichConfig{
		newClient: func(addr string) snmpGetter {
			return &fakeSNMPGetter{connectErr: errors.New("connection refused")}
		},
	}

	got := enrichHostnames(context.Background(), []string{"10.0.0.4"}, cfg)

	if len(got) != 0 {
		t.Fatalf("enrichHostnames() = %+v, want empty (connect failed)", got)
	}
}

func TestEnrichHostnames_EmptyAddrsReturnsEmpty(t *testing.T) {
	got := enrichHostnames(context.Background(), nil, EnrichConfig{})
	if len(got) != 0 {
		t.Fatalf("enrichHostnames(nil) = %+v, want empty", got)
	}
}
