//go:build !linux

package main

import "errors"

// Reading the OS neighbor table is only implemented for Linux (pingsvc's
// actual production platform, per its container image) -- on any other
// GOOS (e.g. macOS during local development), sweepSubnet returns this
// error instead of silently doing nothing.
func init() {
	readARPTable = func() ([]NeighborEntry, error) {
		return nil, errors.New("reading the OS neighbor table is only implemented on linux")
	}
}
