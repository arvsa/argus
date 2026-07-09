import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlmodel import Session, col, select

from app.core.security import get_password_hash, verify_password
from app.models import (
    ClientSnapshot,
    ClientSnapshotCreate,
    Device,
    DeviceCreate,
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
