import asyncio
import gzip
import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any

import boto3  # type: ignore[import-untyped]
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlmodel import Session

from app import crud
from app.core.config import settings
from app.core.db import engine
from app.models import ClientSnapshotCreate, ZoneSummary

logger = logging.getLogger(__name__)


class StorageKeyParseError(Exception):
    """An S3 key doesn't match the expected
    {tenant_id}/{zone_id}/YYYY/MM/DD/HH/<ts>.json.gz layout (plan §4.4)."""


def parse_storage_key(key: str) -> tuple[str, str]:
    """Extract (tenant_id, zone_id) from a snapshot object key. Matches
    exactly the layout pingsvc's objectKeyForSpoolFile builds."""
    parts = key.split("/")
    if len(parts) < 7 or not key.endswith(".json.gz"):
        raise StorageKeyParseError(f"key {key!r} does not match the expected layout")
    return parts[0], parts[1]


def verify_manifest(manifest: dict[str, Any], data: bytes, public_key_hex: str) -> bool:
    """Verify a pingsvc-signed manifest against data, using a public key
    the server already has on file for this zone -- NOT the public_key
    field embedded in the manifest itself. Trusting an attacker-supplied
    public key would let anyone sign anything; the entire point of
    registering a zone's key out-of-band (plan §4.4) is that only that
    registered key is ever trusted here."""
    payload_hash = hashlib.sha256(data).hexdigest()
    if payload_hash != manifest.get("payload_hash"):
        return False
    signed = f"{payload_hash}:{manifest.get('ts')}".encode()
    try:
        pubkey = Ed25519PublicKey.from_public_bytes(bytes.fromhex(public_key_hex))
        pubkey.verify(bytes.fromhex(manifest["signature"]), signed)
        return True
    except (InvalidSignature, ValueError, KeyError):
        return False


def build_s3_client() -> Any:
    kwargs: dict[str, Any] = {"region_name": settings.S3_REGION}
    if settings.S3_ENDPOINT:
        kwargs["endpoint_url"] = settings.S3_ENDPOINT
    if settings.S3_ACCESS_KEY and settings.S3_SECRET_KEY:
        kwargs["aws_access_key_id"] = settings.S3_ACCESS_KEY
        kwargs["aws_secret_access_key"] = settings.S3_SECRET_KEY
    return boto3.client("s3", **kwargs)


def _fetch_bytes(s3_client: Any, bucket: str, key: str) -> bytes:
    obj = s3_client.get_object(Bucket=bucket, Key=key)
    body: bytes = obj["Body"].read()
    return body


# Highest snapshot schema_version (plan §8) this server understands.
# Payloads with no version at all are pre-versioning exporters, accepted
# as-is; anything newer than this is skipped until the server upgrades.
SUPPORTED_SNAPSHOT_SCHEMA_VERSION = 1


def ingest_object(*, session: Session, s3_client: Any, bucket: str, key: str) -> bool:
    """Ingest a single snapshot object. Returns False without re-ingesting
    if storage_key was already seen (idempotent).

    Signature verification is best-effort: if no ZoneSigningKey is
    registered for the zone yet, signature_verified stays None (unknown,
    not failed). If one IS registered but the manifest is missing or
    invalid, signature_verified is False and the snapshot is still stored
    -- rejecting outright would make a one-off bad WAN transfer
    indistinguishable from real tampering; storing it lets an operator see
    and investigate the failed verification instead of silently losing
    the data."""
    if crud.client_snapshot_already_ingested(session=session, storage_key=key):
        return False

    tenant_id, zone_id = parse_storage_key(key)
    raw_gz = _fetch_bytes(s3_client, bucket, key)
    payload = json.loads(gzip.decompress(raw_gz))

    schema_version = payload.get("schema_version")
    if schema_version is not None and schema_version > SUPPORTED_SNAPSHOT_SCHEMA_VERSION:
        logger.warning(
            "skipping %s: schema_version %s is newer than supported %s -- "
            "upgrade argus-server to ingest this zone",
            key,
            schema_version,
            SUPPORTED_SNAPSHOT_SCHEMA_VERSION,
        )
        return False

    signature_verified: bool | None = None
    registered_key = crud.get_zone_signing_key(
        session=session, tenant_id=tenant_id, zone_id=zone_id
    )
    if registered_key is not None:
        try:
            manifest_raw = _fetch_bytes(s3_client, bucket, key + ".manifest.json")
            manifest = json.loads(manifest_raw)
            signature_verified = verify_manifest(manifest, raw_gz, registered_key.public_key_hex)
        except Exception:
            logger.warning("failed to fetch/verify manifest for %s", key, exc_info=True)
            signature_verified = False

    nodes = payload.get("nodes", {})
    devices = payload.get("devices", {})
    snapshot_ts = payload.get("ts", 0)

    crud.create_client_snapshot(
        session=session,
        snapshot_create=ClientSnapshotCreate(
            tenant_id=tenant_id,
            zone_id=zone_id,
            snapshot_ts=snapshot_ts,
            storage_key=key,
            nodes_json=nodes,
            devices_json=devices,
            signature_verified=signature_verified,
            schema_version=schema_version,
        ),
    )

    # Replay guard (plan §4.4, monotonic-ts variant): exact-key idempotency
    # can't catch a validly-signed OLD payload re-uploaded under a NEW key,
    # which would roll the zone's summary back to stale counts. The row
    # above is still stored (audit trail); only the summary is protected.
    # Legitimate spool-backlog flushes are oldest-first and strictly
    # increasing, so they never trip this.
    existing_summary = crud.get_zone_summary(
        session=session, tenant_id=tenant_id, zone_id=zone_id
    )
    if (
        existing_summary is not None
        and existing_summary.last_snapshot_ts is not None
        and snapshot_ts <= existing_summary.last_snapshot_ts
    ):
        logger.warning(
            "possible replay: %s has ts %s <= zone %s/%s's last_snapshot_ts %s; "
            "stored for audit but not applied to the zone summary",
            key,
            snapshot_ts,
            tenant_id,
            zone_id,
            existing_summary.last_snapshot_ts,
        )
        return True

    # Derived from `devices` (one entry per device), not summed across
    # `nodes` -- nodes is an ancestor rollup, so a single device is counted
    # under every ancestor id simultaneously and would wildly over-count.
    up_count = sum(1 for d in devices.values() if d.get("ok"))
    down_count = sum(1 for d in devices.values() if not d.get("ok"))
    crud.upsert_zone_summary(
        session=session,
        tenant_id=tenant_id,
        zone_id=zone_id,
        up_count=up_count,
        down_count=down_count,
        last_snapshot_ts=snapshot_ts,
    )
    return True


def run_ingestion_cycle(*, session: Session, s3_client: Any, bucket: str) -> int:
    """List every snapshot object in bucket and ingest any not already
    seen. Returns the number of objects newly ingested this cycle."""
    ingested = 0
    paginator = s3_client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if not key.endswith(".json.gz"):
                continue  # skips "<key>.manifest.json" companions
            try:
                if ingest_object(session=session, s3_client=s3_client, bucket=bucket, key=key):
                    ingested += 1
            except StorageKeyParseError as e:
                logger.warning("skipping unparseable key: %s", e)
            except Exception:
                logger.exception("failed to ingest %s", key)
    return ingested


def is_zone_stale(last_pulled_at: datetime | None, *, threshold_seconds: int) -> bool:
    """A zone is stale once it's gone longer than threshold_seconds without
    a successful pull -- the "zone went dark" signal from plan §4.5. None
    (never pulled) counts as stale too, though in practice a ZoneSummary
    row's last_pulled_at is always set by the time this is called."""
    if last_pulled_at is None:
        return True
    # MySQL round-trips DateTime(timezone=True) columns as naive datetimes
    # (it has no native tz-aware type) even though the app always writes
    # datetime.now(timezone.utc) -- treat a naive value read back from the
    # DB as UTC rather than crashing on tz-aware - tz-naive subtraction.
    if last_pulled_at.tzinfo is None:
        last_pulled_at = last_pulled_at.replace(tzinfo=timezone.utc)
    age_seconds = (datetime.now(timezone.utc) - last_pulled_at).total_seconds()
    return age_seconds > threshold_seconds


def check_and_log_stale_zones(
    *, session: Session, threshold_seconds: int
) -> list[ZoneSummary]:
    """Log a warning for every zone that hasn't been successfully pulled
    within threshold_seconds, and return them. A zone's own WAN outage
    means it can't self-report -- this is how the server notices instead."""
    stale = crud.get_stale_zones(session=session, threshold_seconds=threshold_seconds)
    for zone in stale:
        logger.warning(
            "zone %s/%s has not pushed since %s (threshold %ds)",
            zone.tenant_id,
            zone.zone_id,
            zone.last_pulled_at,
            threshold_seconds,
        )
    return stale


async def ingestion_task(stop_event: asyncio.Event) -> None:
    """Background task mirroring redis_listener_task's shape: periodically
    poll settings.S3_BUCKET for new snapshot objects, ingest them, and log
    any zones that have gone stale, until stop_event is set. No-ops
    immediately if S3_BUCKET isn't configured, matching pingsvc's own
    opt-in pattern for its side of the push (its -s3-bucket flag). boto3 is
    sync, so each cycle runs in a worker thread via asyncio.to_thread
    rather than blocking the event loop."""
    if not settings.S3_BUCKET:
        logger.info("ingestion: no S3_BUCKET configured, ingestion task disabled")
        return

    s3_client = build_s3_client()
    bucket = settings.S3_BUCKET

    while not stop_event.is_set():
        try:
            with Session(engine) as session:
                count = await asyncio.to_thread(
                    run_ingestion_cycle, session=session, s3_client=s3_client, bucket=bucket
                )
                if count:
                    logger.info("ingestion: ingested %d new snapshot(s)", count)
                await asyncio.to_thread(
                    check_and_log_stale_zones,
                    session=session,
                    threshold_seconds=settings.STALENESS_THRESHOLD_SECONDS,
                )
                pruned = await asyncio.to_thread(
                    crud.prune_old_client_snapshots,
                    session=session,
                    retention_days=settings.SNAPSHOT_RETENTION_DAYS,
                )
                if pruned:
                    logger.info("ingestion: pruned %d expired snapshot(s)", pruned)
        except Exception:
            logger.exception("ingestion cycle failed")

        try:
            await asyncio.wait_for(
                stop_event.wait(), timeout=settings.INGESTION_INTERVAL_SECONDS
            )
        except asyncio.TimeoutError:
            pass
