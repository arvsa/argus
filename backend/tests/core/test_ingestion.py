import gzip
import hashlib
import json

import boto3
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from moto import mock_aws
from sqlmodel import Session

from app import crud
from app.core.ingestion import (
    StorageKeyParseError,
    ingest_object,
    parse_storage_key,
    run_ingestion_cycle,
    verify_manifest,
)
from app.models import ZoneSigningKeyCreate
from tests.utils.utils import random_lower_string

BUCKET = "argus-metrics-test"


@pytest.fixture
def s3_client():
    with mock_aws():
        client = boto3.client("s3", region_name="us-east-1")
        client.create_bucket(Bucket=BUCKET)
        yield client


def _put_snapshot(s3_client, key: str, payload: dict) -> bytes:
    raw = gzip.compress(json.dumps(payload).encode())
    s3_client.put_object(Bucket=BUCKET, Key=key, Body=raw)
    return raw


def _sign(priv: Ed25519PrivateKey, data: bytes, ts: int) -> dict:
    payload_hash = hashlib.sha256(data).hexdigest()
    signed = f"{payload_hash}:{ts}".encode()
    signature = priv.sign(signed)
    pub_bytes = priv.public_key().public_bytes_raw()
    return {
        "payload_hash": payload_hash,
        "ts": ts,
        "public_key": pub_bytes.hex(),
        "signature": signature.hex(),
    }


# ── parse_storage_key ─────────────────────────────────────────────────────

def test_parse_storage_key_valid() -> None:
    tenant_id, zone_id = parse_storage_key("acme-corp/zone-1/2026/01/01/00/1000.json.gz")
    assert tenant_id == "acme-corp"
    assert zone_id == "zone-1"


def test_parse_storage_key_malformed_raises() -> None:
    with pytest.raises(StorageKeyParseError):
        parse_storage_key("not-a-valid-key.json.gz")


# ── verify_manifest ────────────────────────────────────────────────────────

def test_verify_manifest_valid_signature_returns_true() -> None:
    priv = Ed25519PrivateKey.generate()
    data = b'{"zone_id":"zone-1"}'
    manifest = _sign(priv, data, 1000)

    assert verify_manifest(manifest, data, manifest["public_key"]) is True


def test_verify_manifest_wrong_registered_key_returns_false() -> None:
    priv = Ed25519PrivateKey.generate()
    other_priv = Ed25519PrivateKey.generate()
    data = b'{"zone_id":"zone-1"}'
    manifest = _sign(priv, data, 1000)

    # Verifying against a DIFFERENT registered key than the one that signed
    # must fail -- this is the whole security point: the manifest's own
    # embedded public_key field is never trusted, only a key the server
    # already has on file.
    other_pub_hex = other_priv.public_key().public_bytes_raw().hex()
    assert verify_manifest(manifest, data, other_pub_hex) is False


def test_verify_manifest_tampered_payload_returns_false() -> None:
    priv = Ed25519PrivateKey.generate()
    manifest = _sign(priv, b"original", 1000)
    assert verify_manifest(manifest, b"tampered", manifest["public_key"]) is False


# ── ingest_object ──────────────────────────────────────────────────────────

def test_ingest_object_creates_snapshot_and_zone_summary(db: Session, s3_client) -> None:
    tenant_id = random_lower_string()
    key = f"{tenant_id}/zone-1/2026/01/01/00/1000.json.gz"
    payload = {
        "zone_id": "zone-1",
        "ts": 1000,
        "nodes": {"room-1": {"up": 1, "down": 0}},
        "devices": {"10.0.0.1": {"ok": True, "ts": 1000}, "10.0.0.2": {"ok": False, "ts": 1000}},
    }
    _put_snapshot(s3_client, key, payload)

    ingested = ingest_object(session=db, s3_client=s3_client, bucket=BUCKET, key=key)
    assert ingested is True
    assert crud.client_snapshot_already_ingested(session=db, storage_key=key) is True

    from sqlmodel import select

    from app.models import ClientSnapshot, ZoneSummary

    snap = db.exec(select(ClientSnapshot).where(ClientSnapshot.storage_key == key)).first()
    assert snap is not None
    assert snap.tenant_id == tenant_id
    assert snap.zone_id == "zone-1"
    assert snap.nodes_json == {"room-1": {"up": 1, "down": 0}}

    summary = db.exec(
        select(ZoneSummary).where(
            ZoneSummary.tenant_id == tenant_id, ZoneSummary.zone_id == "zone-1"
        )
    ).first()
    assert summary is not None
    assert summary.up_count == 1
    assert summary.down_count == 1


def test_ingest_object_computes_correct_up_down_counts(db: Session, s3_client) -> None:
    tenant_id = random_lower_string()
    key = f"{tenant_id}/zone-1/2026/01/01/00/2000.json.gz"
    payload = {
        "zone_id": "zone-1",
        "ts": 2000,
        "nodes": {"room-1": {"up": 2, "down": 1}, "building-1": {"up": 2, "down": 1}},
        "devices": {
            "10.0.0.1": {"ok": True, "ts": 2000},
            "10.0.0.2": {"ok": True, "ts": 2000},
            "10.0.0.3": {"ok": False, "ts": 2000},
        },
    }
    _put_snapshot(s3_client, key, payload)

    ingest_object(session=db, s3_client=s3_client, bucket=BUCKET, key=key)

    from sqlmodel import select

    from app.models import ZoneSummary

    summary = db.exec(
        select(ZoneSummary).where(
            ZoneSummary.tenant_id == tenant_id, ZoneSummary.zone_id == "zone-1"
        )
    ).first()
    assert summary is not None
    # Counts must come from `devices` (one entry per device), not summed
    # across `nodes` (which double-counts a device at every ancestor level).
    assert summary.up_count == 2
    assert summary.down_count == 1


def test_ingest_object_is_idempotent(db: Session, s3_client) -> None:
    tenant_id = random_lower_string()
    key = f"{tenant_id}/zone-1/2026/01/01/00/3000.json.gz"
    payload = {"zone_id": "zone-1", "ts": 3000, "nodes": {}, "devices": {}}
    _put_snapshot(s3_client, key, payload)

    first = ingest_object(session=db, s3_client=s3_client, bucket=BUCKET, key=key)
    second = ingest_object(session=db, s3_client=s3_client, bucket=BUCKET, key=key)
    assert first is True
    assert second is False


def test_ingest_object_no_registered_key_leaves_verification_unknown(db: Session, s3_client) -> None:
    tenant_id = random_lower_string()
    key = f"{tenant_id}/zone-1/2026/01/01/00/4000.json.gz"
    payload = {"zone_id": "zone-1", "ts": 4000, "nodes": {}, "devices": {}}
    _put_snapshot(s3_client, key, payload)

    ingest_object(session=db, s3_client=s3_client, bucket=BUCKET, key=key)

    from sqlmodel import select

    from app.models import ClientSnapshot

    snap = db.exec(select(ClientSnapshot).where(ClientSnapshot.storage_key == key)).first()
    assert snap is not None
    assert snap.signature_verified is None


def test_ingest_object_with_registered_key_and_valid_manifest_marks_verified_true(
    db: Session, s3_client
) -> None:
    tenant_id = random_lower_string()
    priv = Ed25519PrivateKey.generate()
    pub_hex = priv.public_key().public_bytes_raw().hex()
    crud.create_zone_signing_key(
        session=db,
        key_create=ZoneSigningKeyCreate(tenant_id=tenant_id, zone_id="zone-1", public_key_hex=pub_hex),
    )

    key = f"{tenant_id}/zone-1/2026/01/01/00/5000.json.gz"
    payload = {"zone_id": "zone-1", "ts": 5000, "nodes": {}, "devices": {}}
    raw = _put_snapshot(s3_client, key, payload)
    manifest = _sign(priv, raw, 5000)
    s3_client.put_object(Bucket=BUCKET, Key=key + ".manifest.json", Body=json.dumps(manifest))

    ingest_object(session=db, s3_client=s3_client, bucket=BUCKET, key=key)

    from sqlmodel import select

    from app.models import ClientSnapshot

    snap = db.exec(select(ClientSnapshot).where(ClientSnapshot.storage_key == key)).first()
    assert snap is not None
    assert snap.signature_verified is True


def test_ingest_object_with_registered_key_and_missing_manifest_marks_verified_false(
    db: Session, s3_client
) -> None:
    tenant_id = random_lower_string()
    priv = Ed25519PrivateKey.generate()
    pub_hex = priv.public_key().public_bytes_raw().hex()
    crud.create_zone_signing_key(
        session=db,
        key_create=ZoneSigningKeyCreate(tenant_id=tenant_id, zone_id="zone-1", public_key_hex=pub_hex),
    )

    key = f"{tenant_id}/zone-1/2026/01/01/00/6000.json.gz"
    payload = {"zone_id": "zone-1", "ts": 6000, "nodes": {}, "devices": {}}
    _put_snapshot(s3_client, key, payload)
    # No manifest object pushed.

    ingest_object(session=db, s3_client=s3_client, bucket=BUCKET, key=key)

    from sqlmodel import select

    from app.models import ClientSnapshot

    snap = db.exec(select(ClientSnapshot).where(ClientSnapshot.storage_key == key)).first()
    assert snap is not None
    assert snap.signature_verified is False


# ── run_ingestion_cycle ────────────────────────────────────────────────────

def test_run_ingestion_cycle_ingests_only_json_gz_skips_manifests(db: Session, s3_client) -> None:
    tenant_id = random_lower_string()
    key = f"{tenant_id}/zone-1/2026/01/01/00/7000.json.gz"
    payload = {"zone_id": "zone-1", "ts": 7000, "nodes": {}, "devices": {}}
    _put_snapshot(s3_client, key, payload)
    s3_client.put_object(Bucket=BUCKET, Key=key + ".manifest.json", Body=b"{}")

    count = run_ingestion_cycle(session=db, s3_client=s3_client, bucket=BUCKET)
    assert count == 1


def test_run_ingestion_cycle_skips_already_ingested_objects(db: Session, s3_client) -> None:
    tenant_id = random_lower_string()
    key = f"{tenant_id}/zone-1/2026/01/01/00/8000.json.gz"
    payload = {"zone_id": "zone-1", "ts": 8000, "nodes": {}, "devices": {}}
    _put_snapshot(s3_client, key, payload)

    first = run_ingestion_cycle(session=db, s3_client=s3_client, bucket=BUCKET)
    second = run_ingestion_cycle(session=db, s3_client=s3_client, bucket=BUCKET)
    assert first == 1
    assert second == 0
