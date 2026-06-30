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

func TestLoadTargets_NoFile(t *testing.T) {
	got := loadTargets("")
	want := []string{"8.8.8.8", "1.1.1.1"}

	if len(got) != len(want) {
		t.Fatalf("loadTargets(\"\") = %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("loadTargets(\"\")[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestLoadTargets_FromFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "targets.txt")
	content := "10.0.0.1\n10.0.0.2\n\n10.0.0.3\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("failed to write fixture file: %v", err)
	}

	got := loadTargets(path)
	want := []string{"10.0.0.1", "10.0.0.2", "10.0.0.3"}

	if len(got) != len(want) {
		t.Fatalf("loadTargets(%q) = %v, want %v", path, got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Errorf("loadTargets(%q)[%d] = %q, want %q", path, i, got[i], want[i])
		}
	}
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
