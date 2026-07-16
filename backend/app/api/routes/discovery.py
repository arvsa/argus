import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import select

from app import crud
from app.api.deps import SessionDep, get_current_active_superuser, verify_pingsvc_token
from app.models import (
    InfraPollTarget,
    InfraPollTargetCreate,
    InfraPollTargetInternal,
    InfraPollTargetPublic,
    InfraPollTargetsPublic,
    InfraPollTargetUpdate,
)

router = APIRouter(prefix="/discovery", tags=["discovery"])


def _public(target: InfraPollTarget) -> InfraPollTargetPublic:
    """Never includes the plaintext community -- see
    InfraPollTarget.community's doc comment in models.py."""
    return InfraPollTargetPublic(
        id=target.id,
        addr=target.addr,
        kind=target.kind,
        enabled=target.enabled,
        created_at=target.created_at,
        community_set=bool(target.community),
    )


@router.get(
    "/infra-targets",
    dependencies=[Depends(get_current_active_superuser)],
    response_model=InfraPollTargetsPublic,
)
def read_infra_poll_targets(session: SessionDep) -> Any:
    """
    List configured infrastructure poll targets for operator review
    (superuser-only, ordinary admin workflow) -- never echoes the
    community string (plan/device-discovery-v1.md §2.6).
    """
    targets = session.exec(select(InfraPollTarget)).all()
    return InfraPollTargetsPublic(
        data=[_public(t) for t in targets], count=len(targets)
    )


@router.post(
    "/infra-targets",
    dependencies=[Depends(get_current_active_superuser)],
    response_model=InfraPollTargetPublic,
)
def create_infra_poll_target(
    session: SessionDep, target_in: InfraPollTargetCreate
) -> Any:
    """
    Register a new router/switch to poll for discovery. Rejects a
    duplicate addr the same way POST /devices/ does.
    """
    existing = crud.get_infra_poll_target_by_addr(session=session, addr=target_in.addr)
    if existing:
        raise HTTPException(
            status_code=400,
            detail="An infra poll target with this address already exists.",
        )
    return _public(
        crud.create_infra_poll_target(session=session, target_create=target_in)
    )


@router.patch(
    "/infra-targets/{id}",
    dependencies=[Depends(get_current_active_superuser)],
    response_model=InfraPollTargetPublic,
)
def update_infra_poll_target(
    *, session: SessionDep, id: uuid.UUID, target_in: InfraPollTargetUpdate
) -> Any:
    """
    Update an infra poll target -- community is only present in the
    request body when the operator wants to change it (write-only, per
    InfraPollTargetUpdate's doc comment); the response never echoes it
    back either way.
    """
    target = session.get(InfraPollTarget, id)
    if not target:
        raise HTTPException(status_code=404, detail="Infra poll target not found")

    update_dict = target_in.model_dump(exclude_unset=True)
    target.sqlmodel_update(update_dict)
    session.add(target)
    session.commit()
    session.refresh(target)
    return _public(target)


@router.delete(
    "/infra-targets/{id}",
    dependencies=[Depends(get_current_active_superuser)],
)
def delete_infra_poll_target(session: SessionDep, id: uuid.UUID) -> dict[str, str]:
    target = session.get(InfraPollTarget, id)
    if not target:
        raise HTTPException(status_code=404, detail="Infra poll target not found")
    session.delete(target)
    session.commit()
    return {"message": "Infra poll target deleted successfully"}


@router.get(
    "/infra-targets-internal",
    dependencies=[Depends(verify_pingsvc_token)],
    response_model=list[InfraPollTargetInternal],
)
def read_infra_poll_targets_internal(session: SessionDep) -> Any:
    """
    pingsvc-facing pull route (same auth as targets-export-internal) --
    the decrypted, pingsvc-usable list. Only enabled targets: keeps
    pingsvc a dumb executor rather than needing to filter itself. No
    hash-then-fetch optimization (unlike target-sync) -- this list is
    small and changes rarely, so pingsvc just re-fetches it in full every
    discovery cycle (plan §2.6).
    """
    targets = session.exec(
        select(InfraPollTarget).where(InfraPollTarget.enabled.is_(True))
    ).all()
    return [
        InfraPollTargetInternal(addr=t.addr, community=t.community, kind=t.kind)
        for t in targets
    ]
