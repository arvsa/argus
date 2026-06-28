import csv
import io

from fastapi import APIRouter, Depends
from pydantic.networks import EmailStr

from app.api.deps import get_current_active_superuser
from app.core.config import settings
from app.models import Message
from app.utils import generate_test_email, send_email

router = APIRouter(prefix="/utils", tags=["utils"])



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

def _is_csv_filename(filename: str | None) -> bool:
    if not filename:
        return False
    return any(filename.lower().endswith(ext) for ext in settings.ALLOWED_EXTENSIONS)


def _parse_csv(stream: io.TextIOBase) -> tuple[list[dict[str, str]], list[str]]:
    """
    Parse CSV into list of dict rows using csv.DictReader.
    Returns (rows, header_errors). Header errors includes missing header or malformed rows.
    """
    try:
        reader = csv.DictReader(stream)
    except Exception as exc:
        return [], [f"CSV parsing error: {exc}"]

    rows = []
    header_errors: list[str] = []

    if reader.fieldnames is None:
        header_errors.append("CSV file is missing header row.")
        return [], header_errors

    for i, row in enumerate(reader, start=1):
        # Optionally trim whitespace from values
        cleaned = {k: (v.strip() if isinstance(v, str) else v) for k, v in row.items()}
        rows.append(cleaned)

        if len(rows) > settings.MAX_ROWS:
            header_errors.append(f"CSV has more than the allowed {settings.MAX_ROWS} rows.")
            break

    return rows, header_errors