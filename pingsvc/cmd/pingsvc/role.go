package main

import "fmt"

// Role selects which parts of the pingsvc binary run in this process.
// argus-client deployments run with role=both: the ICMP ping pipeline and
// the metrics exporter colocated in one process. argus-server deployments
// never run pingsvc at all. See
// plan/dynamic-hierarchy-multi-zone-architecture.md §4.3.
type Role string

const (
	RolePingsvc  Role = "pingsvc"
	RoleExporter Role = "exporter"
	RoleBoth     Role = "both"
)

// ParseRole validates a -role flag value. The empty string is invalid --
// callers should pass the flag's default ("pingsvc") explicitly rather than
// relying on ParseRole to supply one, so an accidentally-cleared default is
// caught the same way an unknown value is.
func ParseRole(s string) (Role, error) {
	switch Role(s) {
	case RolePingsvc, RoleExporter, RoleBoth:
		return Role(s), nil
	default:
		return "", fmt.Errorf(
			"invalid -role %q: must be one of %q, %q, %q",
			s, RolePingsvc, RoleExporter, RoleBoth,
		)
	}
}

// RunsPingPipeline reports whether this role starts the ICMP worker pool,
// ticker, and Redis batcher.
func (r Role) RunsPingPipeline() bool {
	return r == RolePingsvc || r == RoleBoth
}

// RunsExporter reports whether this role starts the metrics exporter.
func (r Role) RunsExporter() bool {
	return r == RoleExporter || r == RoleBoth
}
