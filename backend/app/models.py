import uuid
from datetime import datetime, timezone
from typing import Literal

from pydantic import EmailStr
from sqlalchemy import DateTime
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
    rooms: list["Room"] = Relationship(back_populates="building")

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
    devices: list["Device"] = Relationship(back_populates="room")


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
