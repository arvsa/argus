package main

import "testing"

func TestParseRole(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    Role
		wantErr bool
	}{
		{"pingsvc", "pingsvc", RolePingsvc, false},
		{"exporter", "exporter", RoleExporter, false},
		{"both", "both", RoleBoth, false},
		{"empty string is invalid", "", "", true},
		{"unknown value is invalid", "server", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseRole(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("ParseRole(%q) error = nil, want an error", tt.input)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseRole(%q) unexpected error = %v", tt.input, err)
			}
			if got != tt.want {
				t.Errorf("ParseRole(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestRole_RunsPingPipeline(t *testing.T) {
	tests := []struct {
		role Role
		want bool
	}{
		{RolePingsvc, true},
		{RoleBoth, true},
		{RoleExporter, false},
	}
	for _, tt := range tests {
		t.Run(string(tt.role), func(t *testing.T) {
			if got := tt.role.RunsPingPipeline(); got != tt.want {
				t.Errorf("Role(%q).RunsPingPipeline() = %v, want %v", tt.role, got, tt.want)
			}
		})
	}
}

func TestRole_RunsExporter(t *testing.T) {
	tests := []struct {
		role Role
		want bool
	}{
		{RolePingsvc, false},
		{RoleBoth, true},
		{RoleExporter, true},
	}
	for _, tt := range tests {
		t.Run(string(tt.role), func(t *testing.T) {
			if got := tt.role.RunsExporter(); got != tt.want {
				t.Errorf("Role(%q).RunsExporter() = %v, want %v", tt.role, got, tt.want)
			}
		})
	}
}
