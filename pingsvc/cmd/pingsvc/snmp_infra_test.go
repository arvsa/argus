package main

import (
	"errors"
	"reflect"
	"sort"
	"testing"

	"github.com/gosnmp/gosnmp"
)

// fakeSNMPWalker is an in-process fake SNMP responder for pollArpTable,
// same rationale as fakeSNMPGetter in snmp_enrich_test.go -- no real
// network/Docker needed to exercise the OID-parsing logic in
// `go test ./...`.
type fakeSNMPWalker struct {
	connectErr error
	walkErr    error
	pdus       []gosnmp.SnmpPDU
}

func (f *fakeSNMPWalker) Connect() error { return f.connectErr }
func (f *fakeSNMPWalker) Close() error   { return nil }
func (f *fakeSNMPWalker) WalkAll(rootOid string) ([]gosnmp.SnmpPDU, error) {
	if f.walkErr != nil {
		return nil, f.walkErr
	}
	return f.pdus, nil
}

func TestPollArpTable_ExtractsMacIPPairsFromFixtureResponse(t *testing.T) {
	mac1 := []byte{0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x01}
	mac2 := []byte{0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x02}
	cfg := InfraPollConfig{
		newClient: func(addr string) snmpWalker {
			return &fakeSNMPWalker{pdus: []gosnmp.SnmpPDU{
				{Name: oidIpNetToPhysicalPhysAddress + ".1.1.4.10.0.0.1", Type: gosnmp.OctetString, Value: mac1},
				{Name: oidIpNetToPhysicalPhysAddress + ".1.1.4.10.0.0.2", Type: gosnmp.OctetString, Value: mac2},
			}}
		},
	}

	got, err := pollArpTable("192.0.2.1", cfg)
	if err != nil {
		t.Fatalf("pollArpTable() error = %v", err)
	}

	want := []ArpBinding{
		{Addr: "10.0.0.1", MAC: "AA:BB:CC:DD:EE:01"},
		{Addr: "10.0.0.2", MAC: "AA:BB:CC:DD:EE:02"},
	}
	sort.Slice(got, func(i, j int) bool { return got[i].Addr < got[j].Addr })
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("pollArpTable() = %+v, want %+v", got, want)
	}
}

func TestPollArpTable_SkipsIPv6EntriesNotYetImplemented(t *testing.T) {
	cfg := InfraPollConfig{
		newClient: func(addr string) snmpWalker {
			return &fakeSNMPWalker{pdus: []gosnmp.SnmpPDU{
				// addrType=2 (ipv6), addrLen=16 -- deliberately not parsed in v1.
				{Name: oidIpNetToPhysicalPhysAddress + ".1.2.16.32.1.13.184.0.0.0.0.0.0.0.0.0.0.0.1", Type: gosnmp.OctetString, Value: []byte{1, 2, 3, 4, 5, 6}},
				{Name: oidIpNetToPhysicalPhysAddress + ".1.1.4.10.0.0.5", Type: gosnmp.OctetString, Value: []byte{0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0x05}},
			}}
		},
	}

	got, err := pollArpTable("192.0.2.1", cfg)
	if err != nil {
		t.Fatalf("pollArpTable() error = %v", err)
	}
	want := []ArpBinding{{Addr: "10.0.0.5", MAC: "AA:BB:CC:DD:EE:05"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("pollArpTable() = %+v, want %+v (ipv6 entry skipped)", got, want)
	}
}

func TestPollArpTable_ConnectFailureReturnsError(t *testing.T) {
	cfg := InfraPollConfig{
		newClient: func(addr string) snmpWalker {
			return &fakeSNMPWalker{connectErr: errors.New("connection refused")}
		},
	}
	if _, err := pollArpTable("192.0.2.1", cfg); err == nil {
		t.Fatal("pollArpTable() error = nil, want an error on connect failure")
	}
}

func TestPollArpTable_WalkFailureReturnsError(t *testing.T) {
	cfg := InfraPollConfig{
		newClient: func(addr string) snmpWalker {
			return &fakeSNMPWalker{walkErr: errors.New("timeout")}
		},
	}
	if _, err := pollArpTable("192.0.2.1", cfg); err == nil {
		t.Fatal("pollArpTable() error = nil, want an error on walk failure")
	}
}

func TestParseIpNetToPhysicalOID_ExtractsIPv4Address(t *testing.T) {
	oid := oidIpNetToPhysicalPhysAddress + ".7.1.4.192.168.1.10"
	ip, ok := parseIpNetToPhysicalOID(oid)
	if !ok || ip != "192.168.1.10" {
		t.Fatalf("parseIpNetToPhysicalOID(%q) = (%q, %v), want (192.168.1.10, true)", oid, ip, ok)
	}
}

func TestParseIpNetToPhysicalOID_RejectsNonIPv4(t *testing.T) {
	oid := oidIpNetToPhysicalPhysAddress + ".7.2.16.32.1.13.184.0.0.0.0.0.0.0.0.0.0.0.1"
	if _, ok := parseIpNetToPhysicalOID(oid); ok {
		t.Fatalf("parseIpNetToPhysicalOID(%q) ok = true, want false (ipv6 not implemented)", oid)
	}
}

func TestParseIpNetToPhysicalOID_RejectsUnrelatedOID(t *testing.T) {
	if _, ok := parseIpNetToPhysicalOID("1.3.6.1.2.1.1.5.0"); ok {
		t.Fatal("parseIpNetToPhysicalOID() ok = true for an unrelated OID, want false")
	}
}
