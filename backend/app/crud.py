import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlmodel import Session, col, select

from app.core.security import get_password_hash, verify_password
from app.models import (
    ClientSnapshot,
    ClientSnapshotCreate,
    Device,
    DeviceBulkImportRow,
    DeviceCreate,
    DiscoveredDevice,
    DiscoveredDeviceReport,
    InfraPollTarget,
    InfraPollTargetCreate,
    Item,
    ItemCreate,
    Node,
    NodeCreate,
    NodeType,
    NodeTypeCreate,
    User,
    UserCreate,
    UserUpdate,
    ZoneSigningKey,
    ZoneSigningKeyCreate,
    ZoneSummary,
)


def create_user(*, session: Session, user_create: UserCreate) -> User:
    db_obj = User.model_validate(
        user_create, update={"hashed_password": get_password_hash(user_create.password)}
    )
    session.add(db_obj)
    session.commit()
    session.refresh(db_obj)
    return db_obj


def update_user(*, session: Session, db_user: User, user_in: UserUpdate) -> Any:
    user_data = user_in.model_dump(exclude_unset=True)
    extra_data = {}
    if "password" in user_data:
        password = user_data["password"]
        hashed_password = get_password_hash(password)
        extra_data["hashed_password"] = hashed_password
    db_user.sqlmodel_update(user_data, update=extra_data)
    session.add(db_user)
    session.commit()
    session.refresh(db_user)
    return db_user


def get_user_by_email(*, session: Session, email: str) -> User | None:
    statement = select(User).where(User.email == email)
    session_user = session.exec(statement).first()
    return session_user


# Dummy hash to use for timing attack prevention when user is not found
# This is an Argon2 hash of a random password, used to ensure constant-time comparison
DUMMY_HASH = "$argon2id$v=19$m=65536,t=3,p=4$MjQyZWE1MzBjYjJlZTI0Yw$YTU4NGM5ZTZmYjE2NzZlZjY0ZWY3ZGRkY2U2OWFjNjk"


def authenticate(*, session: Session, email: str, password: str) -> User | None:
    db_user = get_user_by_email(session=session, email=email)
    if not db_user:
        # Prevent timing attacks by running password verification even when user doesn't exist
        # This ensures the response time is similar whether or not the email exists
        verify_password(password, DUMMY_HASH)
        return None
    verified, updated_password_hash = verify_password(password, db_user.hashed_password)
    if not verified:
        return None
    if updated_password_hash:
        db_user.hashed_password = updated_password_hash
        session.add(db_user)
        session.commit()
        session.refresh(db_user)
    return db_user


def create_item(*, session: Session, item_in: ItemCreate, owner_id: uuid.UUID) -> Item:
    db_item = Item.model_validate(item_in, update={"owner_id": owner_id})
    session.add(db_item)
    session.commit()
    session.refresh(db_item)
    return db_item


def create_node_type(*, session: Session, node_type_create: NodeTypeCreate) -> NodeType:
    """Create a NodeType, validating it extends its tenant's rank chain by
    exactly one level. See plan/dynamic-hierarchy-multi-zone-architecture.md §4.1."""
    if node_type_create.parent_type_id is None:
        if node_type_create.rank != 0:
            raise ValueError("a NodeType with no parent_type_id must have rank 0")
    else:
        parent_type = session.get(NodeType, node_type_create.parent_type_id)
        if parent_type is None:
            raise ValueError("parent_type_id does not reference an existing NodeType")
        if parent_type.tenant_id != node_type_create.tenant_id:
            raise ValueError("parent_type_id must belong to the same tenant_id")
        if node_type_create.rank != parent_type.rank + 1:
            raise ValueError(
                "rank must be exactly one greater than parent_type_id's rank"
            )

    db_obj = NodeType.model_validate(node_type_create)
    session.add(db_obj)
    session.commit()
    session.refresh(db_obj)
    return db_obj


def create_node(*, session: Session, node_create: NodeCreate) -> Node:
    """Create a Node, validating it against its NodeType's parent chain and
    computing its denormalized path_ids. See
    plan/dynamic-hierarchy-multi-zone-architecture.md §4.1-4.2."""
    node_type = session.get(NodeType, node_create.node_type_id)
    if node_type is None:
        raise ValueError("node_type_id does not reference an existing NodeType")

    if node_create.parent_id is None:
        if node_type.parent_type_id is not None:
            raise ValueError(
                "this node_type requires a parent_id (parent_type_id is set)"
            )
        path_ids: list[str] = []
    else:
        parent = session.get(Node, node_create.parent_id)
        if parent is None:
            raise ValueError("parent_id does not reference an existing Node")
        if parent.node_type_id != node_type.parent_type_id:
            raise ValueError(
                "parent node's node_type does not match this node_type's parent_type_id"
            )
        path_ids = [*parent.path_ids, str(parent.id)]

    db_obj = Node.model_validate(node_create, update={"path_ids": path_ids})
    session.add(db_obj)
    session.commit()
    session.refresh(db_obj)
    return db_obj


def get_device_by_addr(*, session: Session, addr: str) -> Device | None:
    return session.exec(select(Device).where(Device.addr == addr)).first()


def create_device(*, session: Session, device_create: DeviceCreate) -> Device:
    db_obj = Device.model_validate(device_create)
    session.add(db_obj)
    session.commit()
    session.refresh(db_obj)
    return db_obj


def bulk_import_device_row(
    *, session: Session, row: DeviceBulkImportRow
) -> tuple[str, Device | None, str | None]:
    """
    Apply one bulk-import CSV row (plan/device-naming-and-bulk-import-v1.md
    §2.6) using the exact same duplicate/orphan-reassignment semantics as
    POST /devices/ (see the create_device route) -- returns
    (outcome, device_or_none, error_or_none) instead of raising, so one bad
    row in a large batch never blocks the rest.
    """
    if not row.addr or not row.addr.strip():
        return "error", None, "Missing address"

    existing = get_device_by_addr(session=session, addr=row.addr)
    if existing:
        if existing.node_id is None and row.node_id is not None:
            existing.node_id = row.node_id
            if row.hostname is not None:
                existing.hostname = row.hostname
            if row.mac is not None:
                existing.mac = row.mac
            if row.timezone is not None:
                existing.timezone = row.timezone
            session.add(existing)
            session.commit()
            session.refresh(existing)
            return "reassigned", existing, None
        return "skipped_duplicate", None, None

    device = create_device(
        session=session,
        device_create=DeviceCreate(
            addr=row.addr,
            hostname=row.hostname,
            mac=row.mac,
            timezone=row.timezone,
            node_id=row.node_id,
        ),
    )
    return "created", device, None


def upsert_discovered_device(
    *, session: Session, report: DiscoveredDeviceReport
) -> DiscoveredDevice:
    """Merge a discovery sighting into the candidate pool (plan/device-
    discovery-v1.md §2.2), keyed by mac (falling back to addr when the
    report carries no mac). A later report missing a field an earlier one
    already established (e.g. an ARP sighting after an SNMP enrichment)
    must never null it out -- only addr is unconditionally updated to the
    latest sighting (an address can move; that's the whole point of
    keying identity by mac), everything else is COALESCE(new, existing).
    Does not touch status, so a repeat sighting after approve/reject never
    reverts it back to pending."""
    existing = None
    if report.mac:
        existing = session.exec(
            select(DiscoveredDevice).where(DiscoveredDevice.mac == report.mac)
        ).first()
    if existing is None:
        existing = session.exec(
            select(DiscoveredDevice).where(DiscoveredDevice.addr == report.addr)
        ).first()

    now = datetime.now(timezone.utc)
    if existing is None:
        db_obj = DiscoveredDevice(
            addr=report.addr,
            mac=report.mac,
            hostname=report.hostname,
            discovered_via=report.discovered_via,
            first_seen_at=now,
            last_seen_at=now,
        )
    else:
        db_obj = existing
        db_obj.addr = report.addr
        db_obj.mac = report.mac or db_obj.mac
        db_obj.hostname = report.hostname or db_obj.hostname
        db_obj.discovered_via = report.discovered_via or db_obj.discovered_via
        db_obj.last_seen_at = now

    session.add(db_obj)
    session.commit()
    session.refresh(db_obj)
    return db_obj


def get_infra_poll_target_by_addr(
    *, session: Session, addr: str
) -> InfraPollTarget | None:
    return session.exec(
        select(InfraPollTarget).where(InfraPollTarget.addr == addr)
    ).first()


def create_infra_poll_target(
    *, session: Session, target_create: InfraPollTargetCreate
) -> InfraPollTarget:
    db_obj = InfraPollTarget.model_validate(target_create)
    session.add(db_obj)
    session.commit()
    session.refresh(db_obj)
    return db_obj


def promote_discovered_device(
    *, session: Session, discovered: DiscoveredDevice
) -> Device:
    """Create (or non-destructively merge into) the real, monitored Device
    for an approved/auto-populated discovery -- reuses get_device_by_addr/
    create_device, the same primitives POST /devices/ uses, so discovery
    doesn't get its own parallel device-creation rules (plan §2.2). Never
    assigns a node: that's a separate, manual step via the existing Device
    UI, so unlike POST /devices/ there's no orphan-reassignment-conflict
    case to handle here."""
    existing = get_device_by_addr(session=session, addr=discovered.addr)
    if existing:
        existing.mac = existing.mac or discovered.mac
        existing.hostname = existing.hostname or discovered.hostname
        session.add(existing)
        session.commit()
        session.refresh(existing)
        return existing
    return create_device(
        session=session,
        device_create=DeviceCreate(
            addr=discovered.addr, mac=discovered.mac, hostname=discovered.hostname
        ),
    )


def approve_discovered_device(
    *, session: Session, discovered: DiscoveredDevice
) -> DiscoveredDevice:
    promote_discovered_device(session=session, discovered=discovered)
    discovered.status = "approved"
    session.add(discovered)
    session.commit()
    session.refresh(discovered)
    return discovered


def reject_discovered_device(
    *, session: Session, discovered: DiscoveredDevice
) -> DiscoveredDevice:
    discovered.status = "rejected"
    session.add(discovered)
    session.commit()
    session.refresh(discovered)
    return discovered


def discovered_device_is_stale(
    *, discovered: DiscoveredDevice, threshold_seconds: int
) -> bool:
    """A DiscoveredDevice not reconfirmed by any infra poll cycle in over
    threshold_seconds -- surfaced to the operator (plan/device-discovery-
    v1.md §2.5) rather than silently trusted forever. Mirrors
    get_stale_zones' time-delta math, but per-row rather than a filtered
    list, since GET /devices/discovered shows every candidate, not just
    the stale ones.

    get_stale_zones compares in the SQL query itself, so the DB driver
    handles it; here it's a plain Python comparison, and MySQL round-trips
    a DATETIME column as timezone-naive even though get_datetime_utc()
    wrote an aware UTC value -- normalize before comparing."""
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=threshold_seconds)
    last_seen_at = discovered.last_seen_at
    if last_seen_at.tzinfo is None:
        last_seen_at = last_seen_at.replace(tzinfo=timezone.utc)
    return last_seen_at < cutoff


def create_client_snapshot(
    *, session: Session, snapshot_create: ClientSnapshotCreate
) -> ClientSnapshot:
    """Insert an ingested snapshot. Raises IntegrityError (via the DB's
    unique constraint on storage_key) if this object was already ingested --
    callers doing a polling loop should check client_snapshot_already_ingested
    first to treat that as a routine skip rather than an error."""
    db_obj = ClientSnapshot.model_validate(snapshot_create)
    session.add(db_obj)
    session.commit()
    session.refresh(db_obj)
    return db_obj


def client_snapshot_already_ingested(*, session: Session, storage_key: str) -> bool:
    statement = select(ClientSnapshot).where(ClientSnapshot.storage_key == storage_key)
    return session.exec(statement).first() is not None


def get_zone_summary(
    *, session: Session, tenant_id: str, zone_id: str
) -> ZoneSummary | None:
    statement = select(ZoneSummary).where(
        ZoneSummary.tenant_id == tenant_id, ZoneSummary.zone_id == zone_id
    )
    return session.exec(statement).first()


def prune_old_client_snapshots(*, session: Session, retention_days: int) -> int:
    """Delete ClientSnapshot rows pulled more than retention_days ago,
    always keeping each zone's newest row -- a dark zone's last known
    state must stay inspectable no matter how old it gets. Returns the
    number of rows deleted. Row volume is one per zone per push interval,
    so loading candidate ids into memory is fine at any realistic scale."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)

    newest_ids = {
        session.exec(
            select(ClientSnapshot.id)
            .where(
                ClientSnapshot.tenant_id == tenant_id,
                ClientSnapshot.zone_id == zone_id,
            )
            .order_by(col(ClientSnapshot.snapshot_ts).desc())
            .limit(1)
        ).first()
        for tenant_id, zone_id in session.exec(
            select(ClientSnapshot.tenant_id, ClientSnapshot.zone_id).distinct()
        ).all()
    }

    expired = session.exec(
        select(ClientSnapshot).where(col(ClientSnapshot.pulled_at) < cutoff)
    ).all()
    deleted = 0
    for snap in expired:
        if snap.id in newest_ids:
            continue
        session.delete(snap)
        deleted += 1
    if deleted:
        session.commit()
    return deleted


def get_latest_client_snapshot(
    *, session: Session, tenant_id: str, zone_id: str
) -> ClientSnapshot | None:
    """Newest ingested snapshot for a zone, by the payload's own snapshot_ts
    (pingsvc's export time), not pulled_at -- ingestion order isn't guaranteed
    to match export order when a spool backlog is flushed."""
    statement = (
        select(ClientSnapshot)
        .where(
            ClientSnapshot.tenant_id == tenant_id,
            ClientSnapshot.zone_id == zone_id,
        )
        .order_by(col(ClientSnapshot.snapshot_ts).desc())
        .limit(1)
    )
    return session.exec(statement).first()


def upsert_zone_summary(
    *,
    session: Session,
    tenant_id: str,
    zone_id: str,
    up_count: int,
    down_count: int,
    last_snapshot_ts: int,
) -> ZoneSummary:
    """Create or update the single rollup row for (tenant_id, zone_id)."""
    statement = select(ZoneSummary).where(
        ZoneSummary.tenant_id == tenant_id, ZoneSummary.zone_id == zone_id
    )
    existing = session.exec(statement).first()

    now = datetime.now(timezone.utc)
    if existing is None:
        db_obj = ZoneSummary(
            tenant_id=tenant_id,
            zone_id=zone_id,
            up_count=up_count,
            down_count=down_count,
            last_snapshot_ts=last_snapshot_ts,
            last_pulled_at=now,
        )
    else:
        db_obj = existing
        db_obj.up_count = up_count
        db_obj.down_count = down_count
        db_obj.last_snapshot_ts = last_snapshot_ts
        db_obj.last_pulled_at = now

    session.add(db_obj)
    session.commit()
    session.refresh(db_obj)
    return db_obj


def set_zone_display_name(
    *, session: Session, tenant_id: str, zone_id: str, display_name: str | None
) -> ZoneSummary | None:
    """Set the operator-facing label on an existing zone summary row.
    Returns None if the zone has never been ingested (no row to label)."""
    statement = select(ZoneSummary).where(
        ZoneSummary.tenant_id == tenant_id, ZoneSummary.zone_id == zone_id
    )
    existing = session.exec(statement).first()
    if existing is None:
        return None
    existing.display_name = display_name
    session.add(existing)
    session.commit()
    session.refresh(existing)
    return existing


def create_zone_signing_key(
    *, session: Session, key_create: ZoneSigningKeyCreate
) -> ZoneSigningKey:
    """Register (or rotate) a zone's ed25519 public key. Rotation replaces
    the existing row for (tenant_id, zone_id) in place -- signatures made
    with the old key will correctly stop verifying after this, which is the
    intended effect of a rotation."""
    if len(key_create.public_key_hex) != 64:
        raise ValueError(
            f"public_key_hex must be 64 hex characters (32-byte ed25519 key), "
            f"got {len(key_create.public_key_hex)}"
        )
    try:
        bytes.fromhex(key_create.public_key_hex)
    except ValueError as e:
        raise ValueError(f"public_key_hex is not valid hex: {e}") from e

    statement = select(ZoneSigningKey).where(
        ZoneSigningKey.tenant_id == key_create.tenant_id,
        ZoneSigningKey.zone_id == key_create.zone_id,
    )
    existing = session.exec(statement).first()

    if existing is None:
        db_obj = ZoneSigningKey.model_validate(key_create)
    else:
        db_obj = existing
        db_obj.public_key_hex = key_create.public_key_hex

    session.add(db_obj)
    session.commit()
    session.refresh(db_obj)
    return db_obj


def get_zone_signing_key(
    *, session: Session, tenant_id: str, zone_id: str
) -> ZoneSigningKey | None:
    statement = select(ZoneSigningKey).where(
        ZoneSigningKey.tenant_id == tenant_id, ZoneSigningKey.zone_id == zone_id
    )
    return session.exec(statement).first()


def delete_zone(*, session: Session, tenant_id: str, zone_id: str) -> bool:
    """Remove a decommissioned zone entirely: its ZoneSummary row, every
    ClientSnapshot it ever pushed, and its registered ZoneSigningKey (if
    any). These three tables aren't linked by a foreign key -- each is
    independently keyed on (tenant_id, zone_id) -- so there's no cascade
    to rely on; all three have to be deleted explicitly. Returns False
    (no-op) if the zone has no ZoneSummary row, matching the 404 the
    route raises in that case."""
    summary = get_zone_summary(session=session, tenant_id=tenant_id, zone_id=zone_id)
    if summary is None:
        return False

    session.delete(summary)

    snapshots = session.exec(
        select(ClientSnapshot).where(
            ClientSnapshot.tenant_id == tenant_id, ClientSnapshot.zone_id == zone_id
        )
    ).all()
    for snap in snapshots:
        session.delete(snap)

    signing_key = get_zone_signing_key(
        session=session, tenant_id=tenant_id, zone_id=zone_id
    )
    if signing_key is not None:
        session.delete(signing_key)

    session.commit()
    return True


def get_stale_zones(*, session: Session, threshold_seconds: int) -> list[ZoneSummary]:
    """Return every ZoneSummary whose last_pulled_at is older than
    threshold_seconds -- the "zone went dark" signal from
    plan/dynamic-hierarchy-multi-zone-architecture.md §4.5, since a zone's
    own WAN outage means it can't self-report and the server must notice
    the absence of new data instead. last_pulled_at is always set once a
    ZoneSummary row exists (upsert_zone_summary always sets it), so no
    NULL-handling branch is needed here."""
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=threshold_seconds)
    statement = select(ZoneSummary).where(col(ZoneSummary.last_pulled_at) < cutoff)
    return list(session.exec(statement).all())
