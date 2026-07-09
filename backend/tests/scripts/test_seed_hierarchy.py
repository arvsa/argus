from pathlib import Path

import pytest
import yaml
from sqlmodel import Session, select

from app.models import NodeType
from app.seed_hierarchy import (
    HierarchyDriftError,
    load_hierarchy_config,
    run,
    seed_hierarchy,
)
from tests.utils.utils import random_lower_string


def _write_config(tmp_path: Path, tenant_id: str, levels: list[str]) -> Path:
    path = tmp_path / "hierarchy.yaml"
    path.write_text(
        yaml.safe_dump(
            {"tenant_id": tenant_id, "levels": [{"name": n} for n in levels]}
        )
    )
    return path


# ── load_hierarchy_config ────────────────────────────────────────────────


def test_load_hierarchy_config_parses_yaml(tmp_path: Path) -> None:
    path = _write_config(tmp_path, "acme-corp", ["Region", "Site", "Rack"])
    tenant_id, levels = load_hierarchy_config(path)
    assert tenant_id == "acme-corp"
    assert levels == ["Region", "Site", "Rack"]


# ── seed_hierarchy (idempotent upsert + drift detection) ────────────────


def test_seed_hierarchy_creates_node_types_in_rank_order(db: Session) -> None:
    tenant_id = random_lower_string()
    node_types = seed_hierarchy(
        session=db, tenant_id=tenant_id, levels=["Campus", "Building", "Room"]
    )
    assert [nt.name for nt in node_types] == ["Campus", "Building", "Room"]
    assert [nt.rank for nt in node_types] == [0, 1, 2]
    assert node_types[0].parent_type_id is None
    assert node_types[1].parent_type_id == node_types[0].id
    assert node_types[2].parent_type_id == node_types[1].id


def test_seed_hierarchy_is_idempotent(db: Session) -> None:
    tenant_id = random_lower_string()
    first = seed_hierarchy(
        session=db, tenant_id=tenant_id, levels=["Campus", "Building"]
    )
    second = seed_hierarchy(
        session=db, tenant_id=tenant_id, levels=["Campus", "Building"]
    )

    assert [nt.id for nt in first] == [nt.id for nt in second]

    count = db.exec(select(NodeType).where(NodeType.tenant_id == tenant_id)).all()
    assert len(count) == 2


def test_seed_hierarchy_rename_raises_drift_error(db: Session) -> None:
    tenant_id = random_lower_string()
    seed_hierarchy(session=db, tenant_id=tenant_id, levels=["Campus", "Building"])

    with pytest.raises(HierarchyDriftError):
        seed_hierarchy(session=db, tenant_id=tenant_id, levels=["Region", "Building"])


def test_seed_hierarchy_removal_raises_drift_error(db: Session) -> None:
    tenant_id = random_lower_string()
    seed_hierarchy(
        session=db, tenant_id=tenant_id, levels=["Campus", "Building", "Room"]
    )

    with pytest.raises(HierarchyDriftError):
        seed_hierarchy(session=db, tenant_id=tenant_id, levels=["Campus", "Building"])


def test_seed_hierarchy_extending_with_new_level_is_allowed(db: Session) -> None:
    tenant_id = random_lower_string()
    seed_hierarchy(session=db, tenant_id=tenant_id, levels=["Campus", "Building"])

    extended = seed_hierarchy(
        session=db, tenant_id=tenant_id, levels=["Campus", "Building", "Room"]
    )
    assert [nt.name for nt in extended] == ["Campus", "Building", "Room"]


# ── run() (prestart entrypoint) ───────────────────────────────────────────


def test_run_skips_silently_when_config_file_missing(tmp_path: Path) -> None:
    missing = tmp_path / "does-not-exist.yaml"
    run(missing)  # must not raise


def test_run_skips_silently_when_config_path_is_a_directory(tmp_path: Path) -> None:
    """Docker auto-creates a missing bind-mount source as an empty
    directory rather than erroring (the same footgun already hit and fixed
    for pingsvc/targets.txt) -- an operator who never copied
    hierarchy.yaml.example into place must not get a crashing prestart."""
    accidental_dir = tmp_path / "hierarchy.yaml"
    accidental_dir.mkdir()
    run(accidental_dir)  # must not raise


def test_run_seeds_from_config_file(tmp_path: Path, db: Session) -> None:
    tenant_id = random_lower_string()
    path = _write_config(tmp_path, tenant_id, ["Campus", "Building"])

    run(path)

    node_types = db.exec(
        select(NodeType).where(NodeType.tenant_id == tenant_id).order_by(NodeType.rank)
    ).all()
    assert [nt.name for nt in node_types] == ["Campus", "Building"]
