import uuid
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import EmailStr
from sqlalchemy import JSON, BigInteger, Column, DateTime, UniqueConstraint
from sqlmodel import Field, Relationship, SQLModel


def get_datetime_utc() -> datetime:
    return datetime.now(timezone.utc)

AdmissionStatus = Literal["pending", "approved", "rejected"]
Privileges = Literal["user", "tech"]

# =========== CURR VERSION ============

# Shared properties
class UserBase(SQLModel):
    email: EmailStr = Field(unique=True, index=True, max_length=255)
    is_active: bool = True
    is_superuser: bool = False
    full_name: str | None = Field(default=None, max_length=255)

# Properties to receive via API on creation
class UserCreate(UserBase):
    password: str = Field(min_length=8, max_length=128)

class UserRegister(SQLModel):
    email: EmailStr = Field(max_length=255)
    password: str = Field(min_length=8, max_length=128)
    full_name: str | None = Field(default=None, max_length=255)

# Properties to receive via API on update, all are optional
class UserUpdate(UserBase):
    email: EmailStr | None = Field(default=None, max_length=255)  # type: ignore
    password: str | None = Field(default=None, min_length=8, max_length=128)
    admission_status: str | None = Field(default=None)

class UserUpdateMe(SQLModel):
    full_name: str | None = Field(default=None, max_length=255)
    email: EmailStr | None = Field(default=None, max_length=255)

class UpdatePassword(SQLModel):
    current_password: str = Field(min_length=8, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)

# Database model, database table inferred from class name
class User(UserBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    hashed_password: str
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),  # type: ignore
    )
    # employee_id: str = Field(default=None, max_length=255)
    admission_status: str = Field(default="pending")


# Properties to return via API, id is always required
class UserPublic(UserBase):
    id: uuid.UUID
    created_at: datetime | None = None
    email: str  # override: don't re-validate stored addresses on read


class UsersPublic(SQLModel):
    data: list[UserPublic]
    count: int


# Shared properties
class ItemBase(SQLModel):
    title: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=255)


# Properties to receive on item creation
class ItemCreate(ItemBase):
    pass


# Properties to receive on item update
class ItemUpdate(ItemBase):
    title: str | None = Field(default=None, min_length=1, max_length=255)  # type: ignore


# Database model, database table inferred from class name
class Item(ItemBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),  # type: ignore
    )
    # owner_id: uuid.UUID = Field(
    #     foreign_key="user.id", nullable=False, ondelete="CASCADE"
    # )
    # owner: User | None = Relationship(back_populates="items")


# Properties to return via API, id is always required
class ItemPublic(ItemBase):
    id: uuid.UUID
    # owner_id: uuid.UUID
    created_at: datetime | None = None


class ItemsPublic(SQLModel):
    data: list[ItemPublic]
    count: int

# Generic message
class Message(SQLModel):
    message: str


# JSON payload containing access token
class Token(SQLModel):
    access_token: str
    token_type: str = "bearer"


# Contents of JWT token
class TokenPayload(SQLModel):
    sub: str | None = None


class NewPassword(SQLModel):
    token: str
    new_password: str = Field(min_length=8, max_length=128)

#### RUST MODELS ####

# Shared properties (From Rust)
class BuildingBase(SQLModel):
    name: str = Field(max_length=255)

# Properties to receive via API on creation (Rust Transfer)
class BuildingCreate(BuildingBase):
    campus_id: uuid.UUID

# Properties to receive via API on update, all are optional
class BuildingUpdate(SQLModel):
    name: str | None = Field(default=None, max_length=255)

# Properties to return via API, id is always required
class BuildingPublic(BuildingBase):
    id: uuid.UUID
    created_at: datetime | None = None
    campus_id: uuid.UUID

class BuildingsPublic(SQLModel):
    data: list[BuildingPublic]
    count: int
# Shared properties (From Rust)
class CampusBase(SQLModel):
    name: str = Field(max_length=255)
    
# Properties to receive via API on creation (Rust Transfer)    
class CampusCreate(CampusBase):
    pass

# Shared properties (From Rust)
class RoomBase(SQLModel):
    name: str = Field(max_length=255)

# Properties to receive via API on creation (Rust Transfer)    
class RoomCreate(RoomBase):
    building_id: uuid.UUID

# Properties to receive via API on creation (Rust Transfer)    
class RoomsUpdate(SQLModel):
    name: str | None = Field(default=None, max_length=255)

# Properties to return via API, id is always required   
class RoomPublic(RoomBase):
    id: uuid.UUID
    created_at: datetime | None = None
    building_id: uuid.UUID

class RoomsPublic(SQLModel):
    data: list[RoomPublic]
    count: int

# Shared properties (From Rust)
class DeviceBase(SQLModel):
    name: str = Field(max_length=255)
    device_type: str = Field(max_length=255)
    ip_address: str = Field(default=None, max_length=255)

# Properties to receive via API on creation (Rust Transfer)    
class DeviceCreate(DeviceBase):
    room_id: uuid.UUID | None = None

# Properties to return via API, id is always required   
class DevicePublic(DeviceBase):
    id: uuid.UUID
    created_at: datetime | None = None
    room_id: uuid.UUID | None = None

class DevicesPublic(SQLModel):
    data: list[DevicePublic]
    count: int

# Properties to receive via API on creation (Rust Transfer)    
class CampusUpdate(SQLModel):
    name: str | None = Field(default=None, max_length=255)

# Properties to return via API, id is always required
class CampusPublic(CampusBase):
    id: uuid.UUID
    created_at: datetime | None = None

class CampusesPublic(SQLModel):
    data: list[CampusPublic]
    count: int

# ========== Database model, database table inferred from class name ============
class Building(BuildingBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),  # type: ignore
    )
    campus_id: uuid.UUID = Field(
        foreign_key="campus.id", nullable=False, ondelete="CASCADE"
    )
    campus: "Campus" = Relationship(back_populates="buildings")
    rooms: list["Room"] = Relationship(back_populates="building", cascade_delete=True)

class Campus(CampusBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),  # type: ignore
    )
    buildings: list["Building"] = Relationship(back_populates="campus", cascade_delete=True)

class Room(RoomBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),  # type: ignore
    )
    building_id: uuid.UUID = Field(
        foreign_key="building.id", nullable=False, ondelete="CASCADE"
    )
    building: "Building" = Relationship(back_populates="rooms")
    devices: list["Device"] = Relationship(back_populates="room", cascade_delete=True)


class Device(DeviceBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),  # type: ignore
    )
    room_id: uuid.UUID | None = Field(
        foreign_key="room.id", nullable=True, ondelete="CASCADE", default=None,
    )
    room: "Room" = Relationship(back_populates="devices")


# ========== Dynamic hierarchy (NodeType / Node) ============
#
# Generalizes the fixed Campus->Building->Room chain above into an
# admin-configurable, arbitrary-depth tree per tenant. See
# plan/dynamic-hierarchy-multi-zone-architecture.md §4.1.

class NodeTypeBase(SQLModel):
    tenant_id: str = Field(max_length=255, index=True)
    name: str = Field(max_length=255)
    rank: int

class NodeTypeCreate(NodeTypeBase):
    parent_type_id: uuid.UUID | None = None

# rank/parent_type_id are structural (they define the chain) and aren't
# updatable via the API -- only a rename is safe post-creation.
class NodeTypeUpdate(SQLModel):
    name: str | None = Field(default=None, max_length=255)

class NodeType(NodeTypeBase, table=True):
    __tablename__ = "node_type"
    __table_args__ = (
        UniqueConstraint("tenant_id", "rank", name="uq_node_type_tenant_rank"),
    )

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),  # type: ignore
    )
    parent_type_id: uuid.UUID | None = Field(
        default=None, foreign_key="node_type.id", nullable=True, ondelete="CASCADE",
    )

class NodeTypePublic(NodeTypeBase):
    id: uuid.UUID
    created_at: datetime | None = None
    parent_type_id: uuid.UUID | None = None

class NodeTypesPublic(SQLModel):
    data: list[NodeTypePublic]
    count: int


class NodeBase(SQLModel):
    name: str = Field(max_length=255)

class NodeCreate(NodeBase):
    node_type_id: uuid.UUID
    parent_id: uuid.UUID | None = None

# node_type_id/parent_id are structural (they determine path_ids) and
# aren't updatable via the API -- only a rename is safe post-creation.
class NodeUpdate(SQLModel):
    name: str | None = Field(default=None, max_length=255)

class Node(NodeBase, table=True):
    __tablename__ = "node"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),  # type: ignore
    )
    node_type_id: uuid.UUID = Field(foreign_key="node_type.id", nullable=False)
    parent_id: uuid.UUID | None = Field(
        default=None, foreign_key="node.id", nullable=True, ondelete="CASCADE",
    )
    # Denormalized ancestor id chain (root-first), recomputed only on
    # structural writes, so per-node aggregation never needs a recursive
    # query on the hot device-state-change path.
    path_ids: list[str] = Field(default_factory=list, sa_column=Column(JSON, nullable=False))

class NodePublic(NodeBase):
    id: uuid.UUID
    created_at: datetime | None = None
    node_type_id: uuid.UUID
    parent_id: uuid.UUID | None = None
    path_ids: list[str]

class NodesPublic(SQLModel):
    data: list[NodePublic]
    count: int


# ========== argus-server ingestion (Phase 3) ============
#
# Stores what argus-server pulls from object storage, per zone, as opaque
# JSON rather than trying to unify taxonomy across zones (plan §4.5). Note:
# pingsvc's actual exported Snapshot payload is {zone_id, ts, nodes,
# devices} (see pingsvc/cmd/pingsvc/exporter.go) -- it has no separate
# hierarchy_json describing the NodeType chain's shape, since pingsvc has
# no connection to the backend's Node/NodeType model at all (it only knows
# ancestor id *strings* from its target file, not type names/ranks). The
# plan's original §4.5 sketch assumed a hierarchy_json field that was never
# actually produced; ClientSnapshot below stores what pingsvc really emits.

class ClientSnapshotBase(SQLModel):
    tenant_id: str = Field(max_length=255, index=True)
    zone_id: str = Field(max_length=255, index=True)
    snapshot_ts: int  # the "ts" field embedded in the pulled payload (pingsvc's nowMs())
    storage_key: str = Field(max_length=512, unique=True, index=True)

class ClientSnapshotCreate(ClientSnapshotBase):
    nodes_json: dict[str, Any] = Field(default_factory=dict)
    devices_json: dict[str, Any] = Field(default_factory=dict)
    signature_verified: bool | None = None

class ClientSnapshot(ClientSnapshotBase, table=True):
    __tablename__ = "client_snapshot"

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    # unix-ms timestamp (pingsvc's nowMs(), ~13 digits) needs BigInteger --
    # a plain MySQL INT overflows on real timestamps (caught by an
    # end-to-end smoke test; small test fixture values like 1000 never
    # exercised this).
    snapshot_ts: int = Field(sa_type=BigInteger)
    nodes_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    devices_json: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSON, nullable=False))
    # None = no ZoneSigningKey registered for this zone at ingest time, so
    # the manifest (if any) couldn't be checked either way.
    signature_verified: bool | None = Field(default=None)
    pulled_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),  # type: ignore
    )

class ClientSnapshotPublic(ClientSnapshotBase):
    id: uuid.UUID
    nodes_json: dict[str, Any]
    devices_json: dict[str, Any]
    signature_verified: bool | None = None
    pulled_at: datetime | None = None


# Per-zone rollup, upserted (not appended) on every ingest cycle -- one row
# per (tenant_id, zone_id), independent of that zone's hierarchy shape, for
# cross-zone dashboards that don't need per-node detail.
class ZoneSummaryBase(SQLModel):
    tenant_id: str = Field(max_length=255, index=True)
    zone_id: str = Field(max_length=255, index=True)

class ZoneSummary(ZoneSummaryBase, table=True):
    __tablename__ = "zone_summary"
    __table_args__ = (
        UniqueConstraint("tenant_id", "zone_id", name="uq_zone_summary_tenant_zone"),
    )

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    up_count: int = 0
    down_count: int = 0
    last_snapshot_ts: int | None = Field(default=None, sa_type=BigInteger)
    last_pulled_at: datetime | None = Field(
        default=None, sa_type=DateTime(timezone=True),  # type: ignore
    )

class ZoneSummaryPublic(ZoneSummaryBase):
    id: uuid.UUID
    up_count: int
    down_count: int
    last_snapshot_ts: int | None = None
    last_pulled_at: datetime | None = None
    is_stale: bool

class ZoneSummariesPublic(SQLModel):
    data: list[ZoneSummaryPublic]
    count: int


# A zone's registered ed25519 public key (plan §4.4: "a real deployment
# verifies against a public key registered out-of-band," not one carried in
# the manifest itself). Registering/rotating this is an ops action -- no
# HTTP route yet, only the crud functions an ingestion job or future admin
# tool needs.
class ZoneSigningKeyBase(SQLModel):
    tenant_id: str = Field(max_length=255, index=True)
    zone_id: str = Field(max_length=255, index=True)
    public_key_hex: str = Field(max_length=64)  # ed25519 public key, hex-encoded (32 bytes)

class ZoneSigningKeyCreate(ZoneSigningKeyBase):
    pass

class ZoneSigningKey(ZoneSigningKeyBase, table=True):
    __tablename__ = "zone_signing_key"
    __table_args__ = (
        UniqueConstraint("tenant_id", "zone_id", name="uq_zone_signing_key_tenant_zone"),
    )

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),  # type: ignore
    )
