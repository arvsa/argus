package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"path/filepath"
)

// Manifest accompanies a pushed snapshot object so a later phase
// (argus-server ingestion) can verify the payload wasn't tampered with or
// replayed. Object storage IAM proves *who* wrote an object, not that its
// content is untampered or hasn't been resent out of order -- that's what
// this signature is for (plan/dynamic-hierarchy-multi-zone-architecture.md
// §4.4).
type Manifest struct {
	PayloadHash string `json:"payload_hash"` // sha256 hex of the signed bytes
	TS          int64  `json:"ts"`           // doubles as the sequence number -- see signManifest
	PublicKey   string `json:"public_key"`   // hex-encoded ed25519 public key
	Signature   string `json:"signature"`    // hex-encoded ed25519 signature over "payloadHash:ts"
}

// Signer wraps an ed25519 keypair used to sign exported snapshots.
type Signer struct {
	priv ed25519.PrivateKey
}

// PublicKeyHex returns the hex-encoded public half of the signer's
// keypair -- what an operator registers with argus-server so it can
// verify this zone's pushed snapshots (see verifyManifest).
func (s *Signer) PublicKeyHex() string {
	return hex.EncodeToString(s.priv.Public().(ed25519.PublicKey))
}

// signManifest builds a signed Manifest for data. ts is taken from the
// caller (the snapshot's own embedded timestamp) rather than wall-clock at
// signing time, so the sequence a verifier checks against matches the
// payload's actual content. This relies on snapshot timestamps being
// monotonically non-decreasing per zone -- true under normal clock
// behavior since they come from nowMs() -- rather than a separately
// persisted counter; revisit if that assumption ever proves insufficient.
func signManifest(priv ed25519.PrivateKey, ts int64, data []byte) Manifest {
	hash := sha256.Sum256(data)
	hashHex := hex.EncodeToString(hash[:])
	signed := fmt.Sprintf("%s:%d", hashHex, ts)
	sig := ed25519.Sign(priv, []byte(signed))

	return Manifest{
		PayloadHash: hashHex,
		TS:          ts,
		PublicKey:   hex.EncodeToString(priv.Public().(ed25519.PublicKey)),
		Signature:   hex.EncodeToString(sig),
	}
}

// verifyManifest checks a Manifest's signature against data, using the
// public key embedded in the manifest itself. A real deployment verifies
// against a public key registered out-of-band, not one carried in the
// manifest -- that registration/lookup is argus-server ingestion's job (a
// later phase); this function only proves the signing scheme itself is
// implemented correctly (paired round-trip test with signManifest), plus
// gives that later phase the verification half to call directly rather
// than re-deriving the wire format from scratch.
func verifyManifest(m Manifest, data []byte) (bool, error) {
	pub, err := hex.DecodeString(m.PublicKey)
	if err != nil {
		return false, fmt.Errorf("decode public key: %w", err)
	}
	if len(pub) != ed25519.PublicKeySize {
		return false, fmt.Errorf("public key is %d bytes, want %d", len(pub), ed25519.PublicKeySize)
	}
	sig, err := hex.DecodeString(m.Signature)
	if err != nil {
		return false, fmt.Errorf("decode signature: %w", err)
	}

	hash := sha256.Sum256(data)
	hashHex := hex.EncodeToString(hash[:])
	if subtle.ConstantTimeCompare([]byte(hashHex), []byte(m.PayloadHash)) != 1 {
		return false, nil
	}
	signed := fmt.Sprintf("%s:%d", hashHex, m.TS)
	return ed25519.Verify(ed25519.PublicKey(pub), []byte(signed), sig), nil
}

// loadOrGenerateSigningKey loads an ed25519 private key from path if it
// exists, or generates a fresh keypair and persists it to path if not.
// Once generated, the same key is reused on every subsequent call against
// that path -- a changing key on every restart would defeat the point of
// argus-server registering it once. Provisioning/rotating a real
// deployment's signing key is an ops concern (matching how S3 credentials
// are provisioned out-of-band), not something this function does beyond
// the one-time bootstrap.
func loadOrGenerateSigningKey(path string) (*Signer, error) {
	raw, err := os.ReadFile(path)
	if err == nil {
		if len(raw) != ed25519.PrivateKeySize {
			return nil, fmt.Errorf("signing key at %s is %d bytes, want %d", path, len(raw), ed25519.PrivateKeySize)
		}
		return &Signer{priv: ed25519.PrivateKey(raw)}, nil
	}
	if !os.IsNotExist(err) {
		return nil, fmt.Errorf("read signing key %s: %w", path, err)
	}

	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate signing key: %w", err)
	}
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("mkdir signing key dir: %w", err)
		}
	}
	if err := os.WriteFile(path, priv, 0o600); err != nil {
		return nil, fmt.Errorf("write new signing key %s: %w", path, err)
	}
	log.Printf("exporter: generated new signing key at %s", path)
	return &Signer{priv: priv}, nil
}
