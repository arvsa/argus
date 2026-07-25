package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestNowMs(t *testing.T) {
	before := time.Now().UnixNano() / int64(time.Millisecond)
	got := nowMs()
	after := time.Now().UnixNano() / int64(time.Millisecond)

	if got < before || got > after {
		t.Fatalf("nowMs() = %d, want value between %d and %d", got, before, after)
	}
}

func TestGetenv(t *testing.T) {
	const key = "PINGSVC_TEST_GETENV_KEY"

	t.Run("returns default when unset", func(t *testing.T) {
		os.Unsetenv(key)
		if got := getenv(key, "fallback"); got != "fallback" {
			t.Errorf("getenv(%q, %q) = %q, want %q", key, "fallback", got, "fallback")
		}
	})

	t.Run("returns env value when set", func(t *testing.T) {
		os.Setenv(key, "actual-value")
		defer os.Unsetenv(key)
		if got := getenv(key, "fallback"); got != "actual-value" {
			t.Errorf("getenv(%q, %q) = %q, want %q", key, "fallback", got, "actual-value")
		}
	})

	t.Run("returns default when set to empty string", func(t *testing.T) {
		os.Setenv(key, "")
		defer os.Unsetenv(key)
		if got := getenv(key, "fallback"); got != "fallback" {
			t.Errorf("getenv(%q, %q) with empty env = %q, want %q", key, "fallback", got, "fallback")
		}
	})
}

func TestSplitLines(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  []string
	}{
		{"empty string", "", []string{}},
		{"single line no newline", "8.8.8.8", []string{"8.8.8.8"}},
		{"unix newlines", "8.8.8.8\n1.1.1.1\n", []string{"8.8.8.8", "1.1.1.1"}},
		{"windows newlines", "8.8.8.8\r\n1.1.1.1\r\n", []string{"8.8.8.8", "1.1.1.1"}},
		{"blank lines skipped", "8.8.8.8\n\n\n1.1.1.1", []string{"8.8.8.8", "1.1.1.1"}},
		{"trailing line without newline kept", "8.8.8.8\n1.1.1.1", []string{"8.8.8.8", "1.1.1.1"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := splitLines(tt.input)
			if len(got) != len(tt.want) {
				t.Fatalf("splitLines(%q) = %v, want %v", tt.input, got, tt.want)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("splitLines(%q)[%d] = %q, want %q", tt.input, i, got[i], tt.want[i])
				}
			}
		})
	}
}

func assertTargetsEqual(t *testing.T, got, want []Target) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	for i := range got {
		if got[i].Addr != want[i].Addr {
			t.Errorf("targets[%d].Addr = %q, want %q", i, got[i].Addr, want[i].Addr)
		}
		if got[i].DeviceKey != want[i].DeviceKey {
			t.Errorf("targets[%d].DeviceKey = %q, want %q", i, got[i].DeviceKey, want[i].DeviceKey)
		}
		if len(got[i].NodeIDs) != len(want[i].NodeIDs) {
			t.Fatalf("targets[%d].NodeIDs = %v, want %v", i, got[i].NodeIDs, want[i].NodeIDs)
		}
		for j := range got[i].NodeIDs {
			if got[i].NodeIDs[j] != want[i].NodeIDs[j] {
				t.Errorf("targets[%d].NodeIDs[%d] = %q, want %q", i, j, got[i].NodeIDs[j], want[i].NodeIDs[j])
			}
		}
	}
}

func TestLoadTargets_NoFile(t *testing.T) {
	got := loadTargets("")
	want := []Target{{Addr: "8.8.8.8"}, {Addr: "1.1.1.1"}}
	assertTargetsEqual(t, got, want)
}

func TestLoadTargets_FromFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "targets.txt")
	content := "10.0.0.1\n10.0.0.2\n\n10.0.0.3\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("failed to write fixture file: %v", err)
	}

	got := loadTargets(path)
	want := []Target{{Addr: "10.0.0.1"}, {Addr: "10.0.0.2"}, {Addr: "10.0.0.3"}}
	assertTargetsEqual(t, got, want)
}

func TestLoadTargets_MissingFileFallsBackToEmpty(t *testing.T) {
	// os.ReadFile error is swallowed by loadTargets (b, _ := os.ReadFile(...)),
	// so a missing file path produces splitLines("") == [] rather than the
	// built-in defaults. This pins down that (debatable) current behavior.
	got := loadTargets(filepath.Join(t.TempDir(), "does-not-exist.txt"))
	if len(got) != 0 {
		t.Fatalf("loadTargets(missing file) = %v, want empty slice", got)
	}
}

func TestLoadTargets_WithNodeIDs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "targets.txt")
	// A line with a comma carries "addr,ancestor1;ancestor2;...". A bare-IP
	// line (no comma) stays backward compatible with existing target files
	// (plan/dynamic-hierarchy-multi-zone-architecture.md §4.3).
	content := "10.0.0.1,campus-1;building-2;room-3\n10.0.0.2\n10.0.0.3,node-9\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("failed to write fixture file: %v", err)
	}

	got := loadTargets(path)
	want := []Target{
		{Addr: "10.0.0.1", NodeIDs: []string{"campus-1", "building-2", "room-3"}},
		{Addr: "10.0.0.2"},
		{Addr: "10.0.0.3", NodeIDs: []string{"node-9"}},
	}
	assertTargetsEqual(t, got, want)
}

func TestLoadTargets_TrailingCommaWithNoAncestorsYieldsNoNodeIDs(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "targets.txt")
	if err := os.WriteFile(path, []byte("10.0.0.1,\n"), 0o644); err != nil {
		t.Fatalf("failed to write fixture file: %v", err)
	}

	got := loadTargets(path)
	want := []Target{{Addr: "10.0.0.1"}}
	assertTargetsEqual(t, got, want)
}

func TestLoadTargets_WithDeviceKey(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "targets.txt")
	// Third comma-separated field is the new device_key (typically a MAC),
	// added after the existing semicolon-joined ancestor/node_id chain.
	content := "10.0.0.1,node-9,AA:BB:CC:DD:EE:FF\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("failed to write fixture file: %v", err)
	}

	got := loadTargets(path)
	want := []Target{
		{Addr: "10.0.0.1", NodeIDs: []string{"node-9"}, DeviceKey: "AA:BB:CC:DD:EE:FF"},
	}
	assertTargetsEqual(t, got, want)
}

func TestLoadTargets_UnassignedWithDeviceKeyUsesEmptyMiddleField(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "targets.txt")
	// An unassigned device (no ancestors/node_id) with a known device_key
	// must use an empty middle field ("addr,,mac") -- "addr,mac" would be
	// indistinguishable from the existing 2-field "assigned, no mac" format
	// and get misparsed as a bogus single-entry NodeIDs chain.
	content := "10.0.0.1,,AA:BB:CC:DD:EE:FF\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("failed to write fixture file: %v", err)
	}

	got := loadTargets(path)
	want := []Target{{Addr: "10.0.0.1", DeviceKey: "AA:BB:CC:DD:EE:FF"}}
	assertTargetsEqual(t, got, want)
}

func TestLoadTargets_NoDeviceKeyLeavesFieldEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "targets.txt")
	content := "10.0.0.1\n10.0.0.2,node-9\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("failed to write fixture file: %v", err)
	}

	got := loadTargets(path)
	want := []Target{
		{Addr: "10.0.0.1"},
		{Addr: "10.0.0.2", NodeIDs: []string{"node-9"}},
	}
	assertTargetsEqual(t, got, want)
	for i := range got {
		if got[i].DeviceKey != "" {
			t.Errorf("targets[%d].DeviceKey = %q, want empty (no fallback at parse time)", i, got[i].DeviceKey)
		}
	}
}
