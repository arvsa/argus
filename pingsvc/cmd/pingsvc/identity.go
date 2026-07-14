package main

import (
	"encoding/json"
	"net/http"
	"sync/atomic"
)

// ZoneIdentity is this zone's connection info for registering with a
// central argus-server: the identifiers embedded in every snapshot this
// zone pushes, plus the public half of the key used to sign them. Exposed
// over HTTP so an operator's dashboard can show it directly instead of
// requiring a shell into the container to read signing.key.
type ZoneIdentity struct {
	ZoneID       string `json:"zone_id"`
	TenantID     string `json:"tenant_id"`
	PublicKeyHex string `json:"public_key_hex,omitempty"`
}

// identityStore holds the current ZoneIdentity for the /identity handler.
// A plain atomic.Pointer rather than a mutex-guarded field: the value is
// set once at startup (zone/tenant immediately, then again with the
// pubkey once the signing key finishes loading -- which happens after the
// metrics server, serving this handler, has already started) and only
// ever read afterward from concurrent request goroutines.
type identityStore struct {
	v atomic.Pointer[ZoneIdentity]
}

func (s *identityStore) set(id ZoneIdentity) {
	s.v.Store(&id)
}

func (s *identityStore) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		id := s.v.Load()
		if id == nil {
			http.Error(w, "identity not ready", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(id)
	}
}
