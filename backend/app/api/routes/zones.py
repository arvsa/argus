from typing import Any

from fastapi import APIRouter
from sqlmodel import func, select

from app.api.deps import CurrentUser, SessionDep
from app.core.config import settings
from app.core.ingestion import is_zone_stale
from app.models import ZoneSummariesPublic, ZoneSummary, ZoneSummaryPublic

router = APIRouter(prefix="/zones", tags=["zones"])


@router.get("/summary", response_model=ZoneSummariesPublic)
def read_zone_summaries(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """
    Retrieve per-zone rollup summaries, including whether each zone is
    currently considered stale (plan §4.5 -- a zone that's stopped pushing
    without being able to self-report a WAN outage).
    """
    count_statement = select(func.count()).select_from(ZoneSummary)
    count = session.exec(count_statement).one()
    statement = select(ZoneSummary).offset(skip).limit(limit)
    summaries = session.exec(statement).all()

    data = [
        ZoneSummaryPublic(
            **summary.model_dump(),
            is_stale=is_zone_stale(
                summary.last_pulled_at,
                threshold_seconds=settings.STALENESS_THRESHOLD_SECONDS,
            ),
        )
        for summary in summaries
    ]
    return ZoneSummariesPublic(data=data, count=count)
