"""
Shared helpers for seeding the Campus → Building → Room → Device hierarchy in tests.
All functions commit their object and refresh it so the returned instance has a valid .id.
"""
import uuid

from sqlmodel import Session

from app.models import Building, Campus, Device, Room
from tests.utils.utils import random_lower_string


def seed_campus(db: Session) -> Campus:
    _rollback(db)
    campus = Campus(name=f"campus-{random_lower_string()[:8]}")
    db.add(campus)
    db.commit()
    db.refresh(campus)
    return campus


def seed_building(db: Session, campus_id: uuid.UUID) -> Building:
    _rollback(db)
    building = Building(name=f"bldg-{random_lower_string()[:8]}", campus_id=campus_id)
    db.add(building)
    db.commit()
    db.refresh(building)
    return building


def seed_room(db: Session, building_id: uuid.UUID) -> Room:
    _rollback(db)
    room = Room(name=f"room-{random_lower_string()[:8]}", building_id=building_id)
    db.add(room)
    db.commit()
    db.refresh(room)
    return room


def seed_device(db: Session, room_id: uuid.UUID | None = None) -> Device:
    _rollback(db)
    suffix = random_lower_string()[:8]
    device = Device(
        name=f"dev-{suffix}",
        device_type="switch",
        ip_address=f"10.0.{len(suffix)}.1",
        room_id=room_id,
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def seed_hierarchy(db: Session) -> tuple[Campus, Building, Room]:
    """Return a fully linked (Campus, Building, Room) committed to the DB."""
    campus = seed_campus(db)
    building = seed_building(db, campus.id)
    room = seed_room(db, building.id)
    return campus, building, room


def _rollback(db: Session) -> None:
    try:
        db.rollback()
    except Exception:
        pass
