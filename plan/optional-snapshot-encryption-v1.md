# Optional Snapshot Payload Encryption

## 1. Problem

Ed25519 signing (shipped, [dynamic-hierarchy-multi-zone-architecture.md §4.4](dynamic-hierarchy-multi-zone-architecture.md))
proves authenticity/integrity of a snapshot but provides no confidentiality: any
party holding valid S3 read credentials for the bucket (`GetObject`/`ListBucket`)
can read every zone's plaintext JSON snapshot directly, bypassing the Argus
application entirely -- a "foreign" argus-server pointed at the same bucket URI
would see everything, exactly like a legitimate one.

Production is expected to lock this down primarily via IAM (scoped-writer
prefixes, scoped-reader credentials, per the architecture doc's §4.4 intent) --
that remains the *primary* control and is unchanged by this plan. This plan adds
a *defense-in-depth* layer: optional, per-zone payload encryption so that even a
party who somehow obtains valid bucket-read credentials (a leaked or
rotated-but-not-revoked key, a misconfigured bucket policy) still cannot read a
zone's data without also having that zone's separately-registered encryption
key.

Explicitly out of scope: replacing or weakening IAM. This is additive, optional,
and off by default.

## 2. Goal

- A zone operator can opt in to encrypting its exporter's snapshot payload
  before upload (client-side, `pingsvc`'s `-role=exporter/both`).
- argus-server transparently decrypts and renders data for any zone whose
  matching key it has registered -- identical UX to today for a zone not using
  encryption.
- If a zone's payload is encrypted but the server has no matching key
  registered, the server must NOT attempt to parse ciphertext as JSON (today's
  `ingest_object` unconditionally calls `json.loads(gzip.decompress(...))`,
  [ingestion.py:94](../backend/app/core/ingestion.py#L94)), and the dashboard
  must clearly tell the operator "this zone is pushing encrypted data, register
  its encryption key to view it" instead of showing the current generic
  empty/error states.
- Encryption is per-zone opt-in; a mixed fleet (some zones encrypted, most not)
  keeps working exactly as today for the non-encrypted zones.

## 3. Design

### 3.1 Cryptography

Symmetric authenticated encryption: AES-256-GCM. Chosen over an
asymmetric/envelope scheme because it directly matches the stated requirement
("the server should have the encryption key matching the client") and reuses
the exact operational pattern already built for the Ed25519 signing key: an
operator copies a value shown on the client's own dashboard/identity endpoint
and pastes it into the server's zone-detail page.

- Key: 256-bit, generated client-side at first run (mirrors
  `pingsvc/cmd/pingsvc/identity.go`'s existing signing-key
  generate-on-first-run behavior), persisted at a new, optional
  `ARGUS_ENCRYPTION_KEY_PATH` (unset = encryption off, matching "optional on
  the client side").
- Nonce: fresh random 96-bit nonce per push, stored alongside the ciphertext
  (never reused -- GCM nonce reuse under a static key is catastrophic).
- What's encrypted: the gzip'd JSON snapshot body only (the `.json.gz`
  object). The manifest (`payload_hash`, `ts`, `signature`) stays a separate,
  unencrypted sibling file exactly as today -- signing and encryption are
  independent, orthogonal features; a zone can use either, both, or neither.
  `payload_hash` is computed over whatever ciphertext bytes are actually
  uploaded, so signature verification keeps working unmodified regardless of
  whether the payload underneath is encrypted.

### 3.2 Marking a payload as encrypted

The server must be able to tell "is this ciphertext or plaintext" before
attempting to gunzip+parse it -- including for zones with no key registered
yet, since that's exactly the case it needs to detect and report. Add a
boolean to the manifest JSON: `"encrypted": true`. Ingestion fetches the
manifest unconditionally now (today it's only fetched when a signing key is
registered, [ingestion.py:108-118](../backend/app/core/ingestion.py#L108-L118))
purely to read this flag, independent of whether signature verification also
runs.

### 3.3 Backend: new `ZoneEncryptionKey` model

New table, structurally parallel to `ZoneSigningKey` (`tenant_id`, `zone_id`,
key material, `created_at`) -- but **write-only from the API's perspective**.
Unlike the signing key (a public value, safely echoed back by
`GET .../signing-key`, [zones.py:136-149](../backend/app/api/routes/zones.py#L136-L149)),
the encryption key is a secret: `GET .../encryption-key` must return only
`{"registered": true, "created_at": ...}`, never the key material.
`PUT .../encryption-key` (superuser-only, mirroring
`register_zone_signing_key`) sets/rotates it. `crud.delete_zone`
([crud.py:339-368](../backend/app/crud.py#L339-L368)) needs to purge this
table too, alongside the existing `ZoneSummary`/`ClientSnapshot`/
`ZoneSigningKey` purge.

Key material at rest in the server's own MySQL needs its own encryption (e.g.
`SECRET_KEY`-derived envelope encryption, or a KMS integration) -- storing a
plaintext shared secret in a DB column is a meaningfully different risk
profile than the signing key table and deserves its own review before
implementation; flagged here, not designed in this doc (§5).

### 3.4 Ingestion changes (`backend/app/core/ingestion.py`)

- `ingest_object` always fetches the manifest now (§3.2), reads `encrypted`.
- If `encrypted` and no `ZoneEncryptionKey` registered: **do not attempt to
  decompress/parse** the body. Store a lightweight marker instead of a full
  `ClientSnapshot` -- a new nullable field on `ZoneSummary` (e.g.
  `encrypted_pending_key: bool`) updated every cycle, rather than a
  `ClientSnapshot` row with empty/garbage `nodes_json`/`devices_json`, since
  there's nothing decodable to store yet. The ciphertext itself isn't lost
  (it stays in the bucket); whether to also mirror-store it for later
  reprocessing once a key arrives is an open question (§5).
- If `encrypted` and a key IS registered: decrypt with AES-256-GCM before the
  existing `gzip.decompress` + `json.loads` path; everything downstream
  (schema_version check, signature verification against the *decrypted*
  payload's hash, snapshot/summary upsert) is unchanged.
- If not `encrypted`: byte-for-byte identical to today.

### 3.5 API & UI

- `PUT`/`GET /zones/{tenant_id}/{zone_id}/encryption-key`, superuser-gated,
  alongside the existing signing-key routes in `zones.py`.
- `ZoneSummaryPublic` gains `encrypted_pending_key: bool` so
  `/zones/summary`'s list view
  ([zones.py:24-48](../backend/app/api/routes/zones.py#L24-L48)) can show a
  zone as "encrypted, awaiting key" without a per-zone drill-down.
- `ZoneDetailPage` (`frontend/src/pages/ZoneDetail.tsx`) gains an
  `EncryptionKeyPanel`, structurally parallel to `SigningKeyPanel`
  ([ZoneDetail.tsx:179-260](../frontend/src/pages/ZoneDetail.tsx#L179-L260))
  but: input masked like a password field (never re-displayed once saved, no
  "copy" affordance in this direction), and its own distinct empty-state copy
  layered onto this session's `is404`/`zoneKnown` empty-state work -- e.g.
  "This zone's snapshots are encrypted -- register its encryption key below to
  view device/node data" instead of (or alongside, if truly no snapshot has
  ever arrived) "No snapshots ingested yet".
- `pingsvc`'s `/identity` endpoint (`identity.go`) gains an optional
  `encryption_key_hex` field, **only behind its own explicit opt-in flag**
  (e.g. `-expose-encryption-key-over-http`) separate from just enabling
  encryption -- unlike the public signing key, exposing a symmetric secret
  over the same always-on, unauthenticated-by-default metrics-port endpoint is
  a materially bigger exposure, and an operator should have to consciously
  accept that tradeoff rather than get it by default. Safer default: read the
  generated key directly from the key file on disk and transcribe it, same as
  any other secret-provisioning step.

## 4. Phased Rollout (TDD, per CLAUDE.md)

Branch: `feature/optional-snapshot-encryption` (new, off latest `main`, once
picked up)

1. **RED** (backend): `ZoneEncryptionKey` model/migration, `crud` functions
   (`create_zone_encryption_key`, `get_zone_encryption_key`, purge in
   `delete_zone`), routes -- test `GET` never returns key material, `PUT`
   requires superuser.
2. **RED** (backend): `ingest_object` given a manifest with `encrypted: true`
   and no registered key must not call `json.loads` on ciphertext, and must
   set `encrypted_pending_key` on the zone's summary instead of creating a
   garbage `ClientSnapshot`.
3. **RED** (backend): `ingest_object` given `encrypted: true` plus a
   registered key must decrypt and proceed through the existing pipeline
   unchanged (schema check, signature verification, snapshot/summary upsert).
4. **RED** (pingsvc): exporter, given `-encryption-key-path` set, encrypts the
   gzip body with AES-256-GCM with a fresh nonce and sets
   `manifest.encrypted = true`; given it's unset, output is byte-identical to
   today.
5. **RED** (frontend): `EncryptionKeyPanel` renders registered/unregistered
   states, masks input, never displays previously-registered key material;
   `ZoneDetailPage` shows the "encrypted, register key" empty state distinctly
   from "no snapshot yet".
6. Implement each piece to GREEN, in the order above (backend model ->
   ingestion -> pingsvc -> frontend), running the full suite
   (`./scripts/test.sh`, frontend `vitest`) after each.
7. Stop, show diff, wait for review before commit (per Feature Branch
   Workflow) -- same as every other change in this repo.

## 5. Open Questions / Risks

- **Key distribution channel is a secret, not a public value** (unlike the
  signing key): copy-paste from the client dashboard to the server dashboard
  is the same *channel* used today, but the *sensitivity* is different --
  worth deciding whether that's acceptable long-term or whether this should
  eventually route through real secrets management instead of a browser text
  field.
- **Key rotation**: rotating an encryption key (unlike a signing key, where
  old signatures simply stop verifying but data stays readable) makes *all
  prior ciphertext unreadable* unless old keys are retained. Needs an explicit
  decision: keep a small history of retired keys per zone (try each on
  decrypt failure), or accept that rotation forfeits access to pre-rotation
  history.
- **At-rest storage of the key material server-side** (§3.3) needs its own
  security review before implementation -- not designed in this doc.
- **Reprocessing backlog**: if an operator registers a key *after* the server
  has already seen (and discarded, per §3.4) several encrypted-pending-key
  cycles, is that historical data permanently lost, or does the server need
  to retain the S3 object keys to reprocess once a key is registered?
  Leaning toward "retain the object key list, re-run ingestion against it
  once a key arrives" rather than duplicating ciphertext into MySQL, but this
  needs to be decided before implementation.
- **Interaction with staleness (`is_zone_stale`)**: an "encrypted, pending
  key" zone should probably still count as non-stale as long as it's pushing
  on schedule (the server just can't read the payload yet) --
  `last_pulled_at` semantics need to account for a cycle that touched the
  zone without fully parsing it.
- **Does this belong in `schema_version` instead of a separate `encrypted`
  manifest flag?** Kept separate in this plan since encryption and schema
  evolution are orthogonal concerns, but worth a second look once
  implementation starts.

## 6. Key File Touch Points

| Area | Files |
|---|---|
| Model/migration | `backend/app/models.py` (new `ZoneEncryptionKey*`), new Alembic revision |
| CRUD | `backend/app/crud.py` (parallel to `create_zone_signing_key`/`get_zone_signing_key`, plus `delete_zone` purge) |
| Routes | `backend/app/api/routes/zones.py` (new `PUT`/`GET .../encryption-key`) |
| Ingestion | `backend/app/core/ingestion.py` (`ingest_object`, always-fetch-manifest, decrypt-or-defer branch) |
| pingsvc | `pingsvc/cmd/pingsvc/exporter.go` (encrypt-before-upload), `identity.go` (opt-in key exposure) |
| Frontend | `frontend/src/pages/ZoneDetail.tsx` (new `EncryptionKeyPanel`), `frontend/src/api/zones.ts` (new client calls) |
| Tests | `backend/tests/api/routes/test_zones.py`, `backend/tests/crud/`, `pingsvc/cmd/pingsvc/exporter_test.go`, `frontend/src/pages/__tests__/ZoneDetail.test.tsx` |
