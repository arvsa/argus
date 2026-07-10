import pytest
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session

from app import crud
from app.models import ClientSnapshotCreate, ZoneSigningKeyCreate
from tests.utils.utils import random_lower_string


def _snapshot_create(tenant_id: str, zone_id: str, storage_key: str, ts: int = 1000) -> ClientSnapshotCreate:
    return ClientSnapshotCreate(
        tenant_id=tenant_id,
        zone_id=zone_id,
        snapshot_ts=ts,
        storage_key=storage_key,
        nodes_json={"room-1": {"up": 1, "down": 0}},
        devices_json={"10.0.0.1": {"ok": True, "ts": ts}},
    )


# ── ClientSnapshot ──────────────────────────────────────────────────────

def test_create_client_snapshot(db: Session) -> None:
    tenant_id = random_lower_string()
    key = f"{tenant_id}/zone-1/2026/01/01/00/1000.json.gz"
    snap = crud.create_client_snapshot(
        session=db, snapshot_create=_snapshot_create(tenant_id, "zone-1", key)
    )
    assert snap.tenant_id == tenant_id
    assert snap.zone_id == "zone-1"
    assert snap.nodes_json == {"room-1": {"up": 1, "down": 0}}
    assert snap.devices_json == {"10.0.0.1": {"ok": True, "ts": 1000}}
    assert snap.signature_verified is None


def test_create_client_snapshot_duplicate_storage_key_raises(db: Session) -> None:
    tenant_id = random_lower_string()
    key = f"{tenant_id}/zone-1/2026/01/01/00/1000.json.gz"
    crud.create_client_snapshot(
        session=db, snapshot_create=_snapshot_create(tenant_id, "zone-1", key)
    )
    with pytest.raises(IntegrityError):
        crud.create_client_snapshot(
            session=db, snapshot_create=_snapshot_create(tenant_id, "zone-1", key)
        )
    db.rollback()


def test_client_snapshot_already_ingested(db: Session) -> None:
    tenant_id = random_lower_string()
    key = f"{tenant_id}/zone-1/2026/01/01/00/1000.json.gz"
    assert crud.client_snapshot_already_ingested(session=db, storage_key=key) is False

    crud.create_client_snapshot(
        session=db, snapshot_create=_snapshot_create(tenant_id, "zone-1", key)
    )
    assert crud.client_snapshot_already_ingested(session=db, storage_key=key) is True


# ── retention pruning ─────────────────────────────────────────────────────

def test_prune_old_client_snapshots_deletes_expired_rows(db: Session) -> None:
    from datetime import datetime, timedelta, timezone

    tenant_id = random_lower_string()
    old = crud.create_client_snapshot(
        session=db,
        snapshot_create=_snapshot_create(
            tenant_id, "zone-1", f"{tenant_id}/zone-1/2026/01/01/00/1000.json.gz", ts=1000
        ),
    )
    fresh = crud.create_client_snapshot(
        session=db,
        snapshot_create=_snapshot_create(
            tenant_id, "zone-1", f"{tenant_id}/zone-1/2026/01/02/00/2000.json.gz", ts=2000
        ),
    )
    # Age the first row past the retention window.
    old.pulled_at = datetime.now(timezone.utc) - timedelta(days=10)
    db.add(old)
    db.commit()

    deleted = crud.prune_old_client_snapshots(session=db, retention_days=7)

    assert deleted >= 1
    assert (
        crud.client_snapshot_already_ingested(session=db, storage_key=old.storage_key)
        is False
    )
    assert (
        crud.client_snapshot_already_ingested(session=db, storage_key=fresh.storage_key)
        is True
    )


def test_prune_old_client_snapshots_always_keeps_newest_per_zone(db: Session) -> None:
    from datetime import datetime, timedelta, timezone

    tenant_id = random_lower_string()
    only = crud.create_client_snapshot(
        session=db,
        snapshot_create=_snapshot_create(
            tenant_id, "zone-dark", f"{tenant_id}/zone-dark/2026/01/01/00/1000.json.gz", ts=1000
        ),
    )
    # Even a months-old snapshot survives if it's the zone's newest -- a
    # dark zone's last known state must stay inspectable.
    only.pulled_at = datetime.now(timezone.utc) - timedelta(days=90)
    db.add(only)
    db.commit()

    crud.prune_old_client_snapshots(session=db, retention_days=7)

    assert (
        crud.client_snapshot_already_ingested(session=db, storage_key=only.storage_key)
        is True
    )


# ── ZoneSummary ──────────────────────────────────────────────────────────

def test_upsert_zone_summary_creates_new_row(db: Session) -> None:
    tenant_id = random_lower_string()
    summary = crud.upsert_zone_summary(
        session=db, tenant_id=tenant_id, zone_id="zone-1",
        up_count=3, down_count=1, last_snapshot_ts=1000,
    )
    assert summary.up_count == 3
    assert summary.down_count == 1
    assert summary.last_snapshot_ts == 1000
    assert summary.last_pulled_at is not None


def test_upsert_zone_summary_updates_existing_row_in_place(db: Session) -> None:
    tenant_id = random_lower_string()
    first = crud.upsert_zone_summary(
        session=db, tenant_id=tenant_id, zone_id="zone-1",
        up_count=1, down_count=0, last_snapshot_ts=1000,
    )
    second = crud.upsert_zone_summary(
        session=db, tenant_id=tenant_id, zone_id="zone-1",
        up_count=5, down_count=2, last_snapshot_ts=2000,
    )
    assert second.id == first.id
    assert second.up_count == 5
    assert second.down_count == 2
    assert second.last_snapshot_ts == 2000


def test_upsert_zone_summary_different_zones_get_different_rows(db: Session) -> None:
    tenant_id = random_lower_string()
    a = crud.upsert_zone_summary(
        session=db, tenant_id=tenant_id, zone_id="zone-a",
        up_count=1, down_count=0, last_snapshot_ts=1000,
    )
    b = crud.upsert_zone_summary(
        session=db, tenant_id=tenant_id, zone_id="zone-b",
        up_count=2, down_count=0, last_snapshot_ts=1000,
    )
    assert a.id != b.id


# ── ZoneSigningKey ───────────────────────────────────────────────────────

def test_create_zone_signing_key(db: Session) -> None:
    tenant_id = random_lower_string()
    key_hex = "ab" * 32
    key = crud.create_zone_signing_key(
        session=db,
        key_create=ZoneSigningKeyCreate(tenant_id=tenant_id, zone_id="zone-1", public_key_hex=key_hex),
    )
    assert key.public_key_hex == key_hex


def test_create_zone_signing_key_rejects_wrong_length(db: Session) -> None:
    tenant_id = random_lower_string()
    with pytest.raises(ValueError):
        crud.create_zone_signing_key(
            session=db,
            key_create=ZoneSigningKeyCreate(tenant_id=tenant_id, zone_id="zone-1", public_key_hex="not-hex"),
        )


def test_create_zone_signing_key_rotation_replaces_existing_key(db: Session) -> None:
    tenant_id = random_lower_string()
    first_key = "ab" * 32
    second_key = "cd" * 32

    crud.create_zone_signing_key(
        session=db,
        key_create=ZoneSigningKeyCreate(tenant_id=tenant_id, zone_id="zone-1", public_key_hex=first_key),
    )
    rotated = crud.create_zone_signing_key(
        session=db,
        key_create=ZoneSigningKeyCreate(tenant_id=tenant_id, zone_id="zone-1", public_key_hex=second_key),
    )
    assert rotated.public_key_hex == second_key

    found = crud.get_zone_signing_key(session=db, tenant_id=tenant_id, zone_id="zone-1")
    assert found is not None
    assert found.public_key_hex == second_key


def test_get_zone_signing_key_returns_none_when_unregistered(db: Session) -> None:
    tenant_id = random_lower_string()
    assert crud.get_zone_signing_key(session=db, tenant_id=tenant_id, zone_id="zone-1") is None


def test_client_snapshot_has_composite_zone_ts_index(db: Session) -> None:
    """get_latest_client_snapshot orders by snapshot_ts within one zone.
    Without a composite (tenant_id, zone_id, snapshot_ts) index MySQL
    filesorts entire rows -- including the multi-hundred-KB JSON columns --
    and dies with error 1038 (out of sort memory) on realistically sized
    snapshots, 500ing the zone detail endpoint."""
    from sqlalchemy import inspect

    indexes = inspect(db.get_bind()).get_indexes("client_snapshot")
    assert any(
        ix["column_names"] == ["tenant_id", "zone_id", "snapshot_ts"]
        for ix in indexes
    ), f"missing composite zone/ts index; have: {[ix['name'] for ix in indexes]}"
