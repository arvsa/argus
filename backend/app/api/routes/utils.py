from fastapi import APIRouter, Depends
from pydantic import BaseModel
from pydantic.networks import EmailStr

from app.api.deps import get_current_active_superuser
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