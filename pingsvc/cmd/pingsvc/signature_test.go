package main

import (
	"crypto/ed25519"
	"os"
	"path/filepath"
	"testing"
)

func TestSignManifest_RoundTripsWithVerifyManifest(t *testing.T) {
	_, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("ed25519.GenerateKey() error = %v", err)
	}
	data := []byte(`{"zone_id":"zone-1"}`)

	manifest := signManifest(priv, 1700000000000, data)

	ok, err := verifyManifest(manifest, data)
	if err != nil {
		t.Fatalf("verifyManifest() error = %v", err)
	}
	if !ok {
		t.Fatal("verifyManifest() = false, want true for an untampered round-trip")
	}
}

func TestVerifyManifest_TamperedPayloadFailsVerification(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(nil)
	original := []byte(`{"zone_id":"zone-1"}`)
	tampered := []byte(`{"zone_id":"zone-EVIL"}`)

	manifest := signManifest(priv, 1700000000000, original)

	ok, err := verifyManifest(manifest, tampered)
	if err != nil {
		t.Fatalf("verifyManifest() error = %v", err)
	}
	if ok {
		t.Fatal("verifyManifest() = true, want false for tampered payload")
	}
}

func TestVerifyManifest_TamperedSignatureFailsVerification(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(nil)
	data := []byte(`{"zone_id":"zone-1"}`)

	manifest := signManifest(priv, 1700000000000, data)
	// Flip the signature to simulate corruption/forgery.
	manifest.Signature = "00" + manifest.Signature[2:]

	ok, err := verifyManifest(manifest, data)
	if err != nil {
		t.Fatalf("verifyManifest() error = %v", err)
	}
	if ok {
		t.Fatal("verifyManifest() = true, want false for a tampered signature")
	}
}

func TestVerifyManifest_WrongPublicKeySizeReturnsError(t *testing.T) {
	manifest := Manifest{PayloadHash: "abc", TS: 1, PublicKey: "deadbeef", Signature: "00"}
	if _, err := verifyManifest(manifest, []byte("data")); err == nil {
		t.Fatal("verifyManifest() error = nil, want an error for a malformed public key")
	}
}

func TestLoadOrGenerateSigningKey_GeneratesAndPersistsOnFirstCall(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "signing.key")

	signer, err := loadOrGenerateSigningKey(path)
	if err != nil {
		t.Fatalf("loadOrGenerateSigningKey() error = %v", err)
	}
	if signer == nil {
		t.Fatal("loadOrGenerateSigningKey() returned nil signer")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("signing key file not created: %v", err)
	}
	if info.Size() != ed25519.PrivateKeySize {
		t.Errorf("signing key file size = %d, want %d", info.Size(), ed25519.PrivateKeySize)
	}

	// A second call against the same path must reuse the persisted key,
	// not silently generate a new one -- a changing key on every restart
	// would defeat the whole point of a server registering it once.
	again, err := loadOrGenerateSigningKey(path)
	if err != nil {
		t.Fatalf("second loadOrGenerateSigningKey() error = %v", err)
	}
	data := []byte("probe")
	m1 := signManifest(signer.priv, 1000, data)
	m2 := signManifest(again.priv, 1000, data)
	if m1.PublicKey != m2.PublicKey {
		t.Errorf("public key changed across calls: %q vs %q -- key was not persisted", m1.PublicKey, m2.PublicKey)
	}
}

func TestLoadOrGenerateSigningKey_RejectsWrongSizedExistingFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "signing.key")
	if err := os.WriteFile(path, []byte("not a real key"), 0o600); err != nil {
		t.Fatalf("failed to write fixture: %v", err)
	}

	if _, err := loadOrGenerateSigningKey(path); err == nil {
		t.Fatal("loadOrGenerateSigningKey() error = nil, want an error for a wrong-sized key file")
	}
}
