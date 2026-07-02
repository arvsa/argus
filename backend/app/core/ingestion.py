import asyncio
import gzip
import hashlib
import json
import logging
from typing import Any

import boto3  # type: ignore[import-untyped]
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlmodel import Session

from app import crud
from app.core.config import settings
from app.core.db import engine
from app.models import ClientSnapshotCreate

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

    crud.create_client_snapshot(
        session=session,
        snapshot_create=ClientSnapshotCreate(
            tenant_id=tenant_id,
            zone_id=zone_id,
            snapshot_ts=payload.get("ts", 0),
            storage_key=key,
            nodes_json=nodes,
            devices_json=devices,
            signature_verified=signature_verified,
        ),
    )

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
        last_snapshot_ts=payload.get("ts", 0),
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


async def ingestion_task(stop_event: asyncio.Event) -> None:
    """Background task mirroring redis_listener_task's shape: periodically
    poll settings.S3_BUCKET for new snapshot objects and ingest them until
    stop_event is set. No-ops immediately if S3_BUCKET isn't configured,
    matching pingsvc's own opt-in pattern for its side of the push (its
    -s3-bucket flag). boto3 is sync, so each cycle runs in a worker thread
    via asyncio.to_thread rather than blocking the event loop."""
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
        except Exception:
            logger.exception("ingestion cycle failed")

        try:
            await asyncio.wait_for(
                stop_event.wait(), timeout=settings.INGESTION_INTERVAL_SECONDS
            )
        except asyncio.TimeoutError:
            pass
