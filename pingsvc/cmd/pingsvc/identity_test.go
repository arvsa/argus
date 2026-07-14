package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIdentityStore_HandlerReturnsCurrentValue(t *testing.T) {
	var store identityStore
	store.set(ZoneIdentity{ZoneID: "zone-1", TenantID: "acme-corp", PublicKeyHex: "abcd"})

	req := httptest.NewRequest(http.MethodGet, "/identity", nil)
	rec := httptest.NewRecorder()
	store.handler()(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var got ZoneIdentity
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	want := ZoneIdentity{ZoneID: "zone-1", TenantID: "acme-corp", PublicKeyHex: "abcd"}
	if got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}

func TestIdentityStore_HandlerReflectsLatestSet(t *testing.T) {
	var store identityStore
	store.set(ZoneIdentity{ZoneID: "zone-1", TenantID: "acme-corp"})
	// Simulates the exporter's signing key finishing loading after the
	// metrics server has already started serving requests.
	store.set(ZoneIdentity{ZoneID: "zone-1", TenantID: "acme-corp", PublicKeyHex: "abcd"})

	req := httptest.NewRequest(http.MethodGet, "/identity", nil)
	rec := httptest.NewRecorder()
	store.handler()(rec, req)

	var got ZoneIdentity
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if got.PublicKeyHex != "abcd" {
		t.Fatalf("public_key_hex = %q, want %q (should reflect the latest set() call)", got.PublicKeyHex, "abcd")
	}
}

func TestIdentityStore_HandlerBeforeAnySetReturns503(t *testing.T) {
	var store identityStore

	req := httptest.NewRequest(http.MethodGet, "/identity", nil)
	rec := httptest.NewRecorder()
	store.handler()(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 before identity is known", rec.Code)
	}
}

func TestSigner_PublicKeyHexMatchesKeyPair(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("ed25519.GenerateKey() error = %v", err)
	}
	s := &Signer{priv: priv}

	got := s.PublicKeyHex()
	want := hex.EncodeToString(pub)
	if got != want {
		t.Fatalf("PublicKeyHex() = %q, want %q", got, want)
	}
}
