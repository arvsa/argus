import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from pydantic.networks import EmailStr

from app.api.deps import CurrentUser, get_current_active_superuser
from app.core.config import settings
from app.models import Message
from app.utils import generate_test_email, send_email

router = APIRouter(prefix="/utils", tags=["utils"])


class AppConfig(BaseModel):
    role: str


@router.get("/app-config")
def app_config() -> AppConfig:
    """
    Runtime deployment config for the frontend: which role this backend
    runs as (client = zone-local stack with the live ping pipeline,
    server = central ingestion instance where those routes don't exist).
    Public on purpose -- the shell needs it before login, and the role is
    already inferable from which routes 404.
    """
    return AppConfig(role=settings.ROLE)


class ZoneIdentity(BaseModel):
    zone_id: str
    tenant_id: str
    public_key_hex: str | None = None


@router.get("/zone-identity")
def zone_identity(current_user: CurrentUser) -> ZoneIdentity:
    """
    This zone's own connection info for registering with a central
    argus-server: zone_id/tenant_id and the signing public key, proxied
    from pingsvc's /identity endpoint. Only pingsvc (not this backend
    process) knows these -- they're CLI flags/env passed to it, not to the
    backend -- so there's no local source of truth to read this from
    directly (see pingsvc/cmd/pingsvc/identity.go). Client-role only: a
    server backend has no local pingsvc to ask.
    """
    if settings.ROLE != "client":
        raise HTTPException(
            status_code=404, detail="Not available for this deployment role"
        )
    try:
        resp = httpx.get(f"{settings.PINGSVC_METRICS_URL}/identity", timeout=3.0)
        resp.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=503, detail="Couldn't reach pingsvc"
        ) from e
    return ZoneIdentity(**resp.json())


@router.post(
    "/test-email/",
    dependencies=[Depends(get_current_active_superuser)],
    status_code=201,
)
def test_email(email_to: EmailStr) -> Message:
    """
    Test emails.
    """
    email_data = generate_test_email(email_to=email_to)
    send_email(
        email_to=email_to,
        subject=email_data.subject,
        html_content=email_data.html_content,
    )
    return Message(message="Test email sent")


@router.get("/health-check/")
async def health_check() -> bool:
    return True