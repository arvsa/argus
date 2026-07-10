import gzip
import hashlib
import json
import logging
from datetime import datetime, timedelta, timezone

import boto3
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from moto import mock_aws
from sqlmodel import Session

from app import crud
from app.core.ingestion import (
    StorageKeyParseError,
    check_and_log_stale_zones,
    ingest_object,
    is_zone_stale,
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


# ── schema_version (plan §8: wire contract) ────────────────────────────────

def test_ingest_object_records_schema_version(db: Session, s3_client) -> None:
    tenant_id = random_lower_string()
    key = f"{tenant_id}/zone-1/2026/01/01/00/9000.json.gz"
    payload = {"zone_id": "zone-1", "ts": 9000, "schema_version": 1, "nodes": {}, "devices": {}}
    _put_snapshot(s3_client, key, payload)

    assert ingest_object(session=db, s3_client=s3_client, bucket=BUCKET, key=key) is True

    from sqlmodel import select

    from app.models import ClientSnapshot

    snap = db.exec(select(ClientSnapshot).where(ClientSnapshot.storage_key == key)).first()
    assert snap is not None
    assert snap.schema_version == 1


def test_ingest_object_accepts_versionless_legacy_payload(db: Session, s3_client) -> None:
    tenant_id = random_lower_string()
    key = f"{tenant_id}/zone-1/2026/01/01/00/9100.json.gz"
    payload = {"zone_id": "zone-1", "ts": 9100, "nodes": {}, "devices": {}}
    _put_snapshot(s3_client, key, payload)

    assert ingest_object(session=db, s3_client=s3_client, bucket=BUCKET, key=key) is True

    from sqlmodel import select

    from app.models import ClientSnapshot

    snap = db.exec(select(ClientSnapshot).where(ClientSnapshot.storage_key == key)).first()
    assert snap is not None
    assert snap.schema_version is None


def test_ingest_object_skips_unknown_future_schema_version(
    db: Session, s3_client, caplog: pytest.LogCaptureFixture
) -> None:
    tenant_id = random_lower_string()
    key = f"{tenant_id}/zone-1/2026/01/01/00/9200.json.gz"
    payload = {"zone_id": "zone-1", "ts": 9200, "schema_version": 99, "nodes": {}, "devices": {}}
    _put_snapshot(s3_client, key, payload)

    with caplog.at_level(logging.WARNING):
        assert ingest_object(session=db, s3_client=s3_client, bucket=BUCKET, key=key) is False
    assert crud.client_snapshot_already_ingested(session=db, storage_key=key) is False
    assert any("schema_version" in r.message for r in caplog.records)


def test_ingest_object_parses_exact_exporter_wire_format(db: Session, s3_client) -> None:
    """Contract test (plan §8): this payload mirrors pingsvc's Snapshot
    struct field-for-field (exporter.go json tags). If the exporter's shape
    changes without a schema_version bump, this is the test that breaks."""
    tenant_id = random_lower_string()
    key = f"{tenant_id}/zone-hq/2026/01/01/00/1700000300000.json.gz"
    payload = {
        "zone_id": "zone-hq",
        "ts": 1700000300000,
        "schema_version": 1,
        "nodes": {"campus-1": {"up": 2, "down": 1}},
        "devices": {"8.8.8.8": {"ok": True, "ts": 1700000299000}},
    }
    _put_snapshot(s3_client, key, payload)

    assert ingest_object(session=db, s3_client=s3_client, bucket=BUCKET, key=key) is True

    from sqlmodel import select

    from app.models import ClientSnapshot, ZoneSummary

    snap = db.exec(select(ClientSnapshot).where(ClientSnapshot.storage_key == key)).first()
    assert snap is not None
    assert snap.snapshot_ts == 1700000300000
    assert snap.schema_version == 1
    assert snap.nodes_json == {"campus-1": {"up": 2, "down": 1}}
    assert snap.devices_json == {"8.8.8.8": {"ok": True, "ts": 1700000299000}}

    summary = db.exec(
        select(ZoneSummary).where(
            ZoneSummary.tenant_id == tenant_id, ZoneSummary.zone_id == "zone-hq"
        )
    ).first()
    assert summary is not None
    assert summary.up_count == 1
    assert summary.down_count == 0


# ── replay guard (plan §4.4, monotonic-ts variant) ─────────────────────────

def test_ingest_object_rejects_non_monotonic_ts_from_summary(
    db: Session, s3_client, caplog: pytest.LogCaptureFixture
) -> None:
    tenant_id = random_lower_string()
    fresh_key = f"{tenant_id}/zone-1/2026/01/01/01/5000.json.gz"
    _put_snapshot(
        s3_client,
        fresh_key,
        {"zone_id": "zone-1", "ts": 5000, "nodes": {},
         "devices": {"10.0.0.1": {"ok": True, "ts": 5000}}},
    )
    assert ingest_object(session=db, s3_client=s3_client, bucket=BUCKET, key=fresh_key) is True

    # A validly-stored old payload re-uploaded under a NEW key -- exact-key
    # idempotency doesn't catch this; the monotonic-ts guard must.
    replay_key = f"{tenant_id}/zone-1/2026/01/01/02/4000.json.gz"
    _put_snapshot(
        s3_client,
        replay_key,
        {"zone_id": "zone-1", "ts": 4000, "nodes": {},
         "devices": {"10.0.0.1": {"ok": False, "ts": 4000}, "10.0.0.2": {"ok": False, "ts": 4000}}},
    )
    with caplog.at_level(logging.WARNING):
        ingest_object(session=db, s3_client=s3_client, bucket=BUCKET, key=replay_key)

    from sqlmodel import select

    from app.models import ClientSnapshot, ZoneSummary

    # The stale snapshot row is stored for audit, but the zone summary must
    # still reflect the newest payload, not the replayed old one.
    summary = db.exec(
        select(ZoneSummary).where(
            ZoneSummary.tenant_id == tenant_id, ZoneSummary.zone_id == "zone-1"
        )
    ).first()
    assert summary is not None
    assert summary.last_snapshot_ts == 5000
    assert summary.up_count == 1
    assert summary.down_count == 0

    snap = db.exec(
        select(ClientSnapshot).where(ClientSnapshot.storage_key == replay_key)
    ).first()
    assert snap is not None  # audit trail survives
    assert any("replay" in r.message.lower() for r in caplog.records)


def test_ingest_object_rejects_equal_ts(db: Session, s3_client) -> None:
    tenant_id = random_lower_string()
    first_key = f"{tenant_id}/zone-1/2026/01/01/03/7000.json.gz"
    _put_snapshot(
        s3_client,
        first_key,
        {"zone_id": "zone-1", "ts": 7000, "nodes": {},
         "devices": {"10.0.0.1": {"ok": True, "ts": 7000}}},
    )
    ingest_object(session=db, s3_client=s3_client, bucket=BUCKET, key=first_key)

    dup_key = f"{tenant_id}/zone-1/2026/01/01/04/7000.json.gz"
    _put_snapshot(
        s3_client,
        dup_key,
        {"zone_id": "zone-1", "ts": 7000, "nodes": {},
         "devices": {"10.0.0.1": {"ok": False, "ts": 7000}}},
    )
    ingest_object(session=db, s3_client=s3_client, bucket=BUCKET, key=dup_key)

    from sqlmodel import select

    from app.models import ZoneSummary

    summary = db.exec(
        select(ZoneSummary).where(
            ZoneSummary.tenant_id == tenant_id, ZoneSummary.zone_id == "zone-1"
        )
    ).first()
    assert summary is not None
    assert summary.up_count == 1
    assert summary.down_count == 0


# ── staleness ──────────────────────────────────────────────────────────────

def test_is_zone_stale_true_when_past_threshold() -> None:
    last_pulled_at = datetime.now(timezone.utc) - timedelta(seconds=300)
    assert is_zone_stale(last_pulled_at, threshold_seconds=120) is True


def test_is_zone_stale_false_when_within_threshold() -> None:
    last_pulled_at = datetime.now(timezone.utc) - timedelta(seconds=10)
    assert is_zone_stale(last_pulled_at, threshold_seconds=120) is False


def test_check_and_log_stale_zones_logs_a_warning_per_stale_zone(
    db: Session, caplog: pytest.LogCaptureFixture
) -> None:
    tenant_id = random_lower_string()
    summary = crud.upsert_zone_summary(
        session=db, tenant_id=tenant_id, zone_id="zone-dark",
        up_count=1, down_count=0, last_snapshot_ts=1000,
    )
    summary.last_pulled_at = datetime.now(timezone.utc) - timedelta(seconds=500)
    db.add(summary)
    db.commit()

    with caplog.at_level(logging.WARNING):
        stale = check_and_log_stale_zones(session=db, threshold_seconds=120)

    stale_ids = {(z.tenant_id, z.zone_id) for z in stale}
    assert (tenant_id, "zone-dark") in stale_ids
    assert any("zone-dark" in record.message for record in caplog.records)


def test_check_and_log_stale_zones_excludes_fresh_zone(db: Session) -> None:
    tenant_id = random_lower_string()
    # Freshly upserted -- last_pulled_at is "now", must not count as stale
    # even with a fairly tight threshold.
    crud.upsert_zone_summary(
        session=db, tenant_id=tenant_id, zone_id="zone-fresh-2",
        up_count=1, down_count=0, last_snapshot_ts=1000,
    )
    stale = check_and_log_stale_zones(session=db, threshold_seconds=120)
    stale_ids = {(z.tenant_id, z.zone_id) for z in stale}
    assert (tenant_id, "zone-fresh-2") not in stale_ids
