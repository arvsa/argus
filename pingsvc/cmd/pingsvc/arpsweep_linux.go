//go:build linux

package main

import (
	"bufio"
	"os"
	"strconv"
	"strings"
)

func init() {
	readARPTable = readARPTableFromProc
}

// readARPTableFromProc parses /proc/net/arp -- the Linux kernel's own
// resolved ARP cache, exactly what "ip neigh" surfaces. Only entries
// flagged ATF_COM (0x2, fully resolved) with a real (non-zero) hardware
// address are returned; incomplete/stale entries are skipped.
func readARPTableFromProc() ([]NeighborEntry, error) {
	f, err := os.Open("/proc/net/arp")
	if err != nil {
		return nil, err
	}
	defer f.Close()

	var out []NeighborEntry
	scanner := bufio.NewScanner(f)
	scanner.Scan() // header line ("IP address  HW type  Flags  HW address  Mask  Device")
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 4 {
			continue
		}
		addr, flagsHex, mac := fields[0], fields[2], fields[3]

		flags, err := strconv.ParseInt(strings.TrimPrefix(flagsHex, "0x"), 16, 64)
		if err != nil || flags&0x2 == 0 {
			continue
		}
		if mac == "00:00:00:00:00:00" {
			continue
		}
		out = append(out, NeighborEntry{Addr: addr, MAC: strings.ToUpper(mac)})
	}
	return out, scanner.Err()
}
