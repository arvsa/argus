package main

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/gosnmp/gosnmp"
)

// IP-MIB ipNetToPhysicalTable (RFC 4293) -- standard, vendor-neutral,
// address-family agnostic ARP/NDP table (plan/device-discovery-v1.md
// §2.1). Walking ipNetToPhysicalPhysAddress alone is enough: each result's
// OID suffix encodes the index (ifIndex, addrType, addrLen, address), and
// its value is the MAC.
const oidIpNetToPhysicalPhysAddress = "1.3.6.1.2.1.4.35.1.3"

// ArpBinding is one (IP, MAC) pair extracted from an infrastructure
// device's ARP/NDP table.
type ArpBinding struct {
	Addr string
	MAC  string
}

// snmpWalker is the minimal subset of gosnmp's client interface
// pollArpTable needs -- same test-without-network rationale as snmpGetter
// in snmp_enrich.go: production uses a real *gosnmp.GoSNMP, tests inject
// an in-process fake.
type snmpWalker interface {
	Connect() error
	WalkAll(rootOid string) ([]gosnmp.SnmpPDU, error)
	Close() error
}

// InfraPollConfig configures pollArpTable for one InfraPollTarget.
type InfraPollConfig struct {
	Community string
	Timeout   time.Duration
	Retries   int

	newClient func(addr string) snmpWalker
}

func (cfg InfraPollConfig) clientFor(addr string) snmpWalker {
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

// pollArpTable walks a single infrastructure device's ARP table. A
// connect or walk failure returns an error rather than partial results --
// the caller (discovery.go) logs and continues to the next target, so one
// unreachable/misconfigured device never blocks the whole cycle.
//
// CAM-table (dot1dTpFdbTable, BRIDGE-MIB) polling for switch-kind targets
// is not implemented in this pass -- the plan marks it optional/low-cost,
// not required for the core v1 mechanism (plan §2.1); every target is
// polled the same way here regardless of its configured kind.
func pollArpTable(addr string, cfg InfraPollConfig) ([]ArpBinding, error) {
	client := cfg.clientFor(addr)
	if err := client.Connect(); err != nil {
		return nil, fmt.Errorf("connect to %s: %w", addr, err)
	}
	defer client.Close()

	pdus, err := client.WalkAll(oidIpNetToPhysicalPhysAddress)
	if err != nil {
		return nil, fmt.Errorf("walk ipNetToPhysicalTable on %s: %w", addr, err)
	}

	var bindings []ArpBinding
	for _, pdu := range pdus {
		ip, ok := parseIpNetToPhysicalOID(pdu.Name)
		if !ok {
			continue
		}
		mac, ok := pduMACString(pdu.Value)
		if !ok {
			continue
		}
		bindings = append(bindings, ArpBinding{Addr: ip, MAC: mac})
	}
	return bindings, nil
}

// parseIpNetToPhysicalOID extracts the IPv4 address encoded in an
// ipNetToPhysicalPhysAddress walk result's OID suffix:
// <column-oid>.<ifIndex>.<addrType>.<addrLen>.<address bytes...>
// (RFC 4293's InetAddressType/InetAddress index convention).
//
// Only addrType=1 (ipv4, addrLen=4) is handled -- addrType=2 (ipv6,
// addrLen=16) entries are recognized and skipped rather than mis-parsed.
// IPv6 support is a named gap (plan §4), not implemented in this pass.
func parseIpNetToPhysicalOID(oid string) (string, bool) {
	oid = strings.TrimPrefix(oid, ".")
	prefix := oidIpNetToPhysicalPhysAddress + "."
	if !strings.HasPrefix(oid, prefix) {
		return "", false
	}
	suffix := strings.TrimPrefix(oid, prefix)

	parts := strings.Split(suffix, ".")
	if len(parts) < 3 {
		return "", false
	}
	addrType := parts[1]
	addrLen, err := strconv.Atoi(parts[2])
	if err != nil {
		return "", false
	}
	if addrType != "1" || addrLen != 4 {
		return "", false
	}
	if len(parts) != 3+addrLen {
		return "", false
	}
	return strings.Join(parts[3:], "."), true
}

// pduMACString renders a raw 6-byte OctetString PDU value as a colon-
// separated MAC address string.
func pduMACString(v any) (string, bool) {
	b, ok := v.([]byte)
	if !ok || len(b) != 6 {
		return "", false
	}
	return fmt.Sprintf("%02X:%02X:%02X:%02X:%02X:%02X", b[0], b[1], b[2], b[3], b[4], b[5]), true
}
