import argparse
import logging
from pathlib import Path

import yaml
from sqlmodel import Session, col, select

from app import crud
from app.core.db import engine
from app.models import NodeType, NodeTypeCreate

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class HierarchyDriftError(Exception):
    """A hierarchy.yaml would rename or remove a rank that already has
    NodeType rows on record for its tenant. Structural changes like that
    need an explicit, reviewed migration -- not unattended prestart seeding.
    See plan/dynamic-hierarchy-multi-zone-architecture.md §4.7."""


def load_hierarchy_config(path: Path) -> tuple[str, list[str]]:
    with open(path) as f:
        data = yaml.safe_load(f)
    tenant_id: str = data["tenant_id"]
    levels: list[str] = [level["name"] for level in data["levels"]]
    return tenant_id, levels


def seed_hierarchy(*, session: Session, tenant_id: str, levels: list[str]) -> list[NodeType]:
    """Idempotently upsert NodeType rows for tenant_id from an ordered level
    name list (rank = list index, root-first). Raises HierarchyDriftError if
    an existing rank would be renamed or removed."""
    existing = session.exec(
        select(NodeType).where(NodeType.tenant_id == tenant_id).order_by(col(NodeType.rank))
    ).all()
    existing_by_rank = {nt.rank: nt for nt in existing}

    for rank, nt in existing_by_rank.items():
        if rank >= len(levels):
            raise HierarchyDriftError(
                f"tenant {tenant_id!r} rank {rank} ({nt.name!r}) exists but "
                "hierarchy.yaml no longer defines it"
            )

    result: list[NodeType] = []
    parent_type_id = None
    for rank, name in enumerate(levels):
        current = existing_by_rank.get(rank)
        if current is not None:
            if current.name != name:
                raise HierarchyDriftError(
                    f"tenant {tenant_id!r} rank {rank} is already {current.name!r}, "
                    f"hierarchy.yaml wants {name!r}"
                )
            result.append(current)
            parent_type_id = current.id
            continue

        created = crud.create_node_type(
            session=session,
            node_type_create=NodeTypeCreate(
                tenant_id=tenant_id, name=name, rank=rank, parent_type_id=parent_type_id
            ),
        )
        result.append(created)
        parent_type_id = created.id

    return result


def run(config_path: Path) -> None:
    if not config_path.exists():
        logger.info("no hierarchy config at %s, skipping hierarchy seeding", config_path)
        return

    tenant_id, levels = load_hierarchy_config(config_path)
    with Session(engine) as session:
        seed_hierarchy(session=session, tenant_id=tenant_id, levels=levels)
    logger.info("seeded hierarchy for tenant %r (%d levels)", tenant_id, len(levels))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="hierarchy.yaml")
    args = parser.parse_args()
    run(Path(args.config))


if __name__ == "__main__":
    main()
