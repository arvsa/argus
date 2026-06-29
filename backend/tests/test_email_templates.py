"""
Tests that compiled email HTML templates exist and render without error (Bug #5).

These run locally without DB or Redis — no fixtures needed.
"""
from pathlib import Path

import pytest
from jinja2 import Environment, FileSystemLoader

_BUILD = Path(__file__).parent.parent / "app" / "email-templates" / "build"

_TEMPLATES = [
    ("new_account.html",    {"project_name": "Argus", "username": "alice", "password": "s3cr3t", "link": "http://x"}),
    ("reset_password.html", {"project_name": "Argus", "username": "alice", "link": "http://x", "valid_hours": 48}),
    ("test_email.html",     {"project_name": "Argus", "email": "alice@example.com"}),
]


@pytest.mark.parametrize("filename,_", _TEMPLATES)
def test_template_file_exists(filename: str, _) -> None:
    assert (_BUILD / filename).exists(), (
        f"Missing compiled template: {_BUILD / filename}\n"
        "Run: compile MJML sources → app/email-templates/build/"
    )


@pytest.mark.parametrize("filename,ctx", _TEMPLATES)
def test_template_renders_without_error(filename: str, ctx: dict) -> None:
    env = Environment(loader=FileSystemLoader(str(_BUILD)), autoescape=True)
    rendered = env.get_template(filename).render(**ctx)
    assert len(rendered) > 0
    # Basic sanity: Jinja2 variables should be replaced, not left as {{ ... }}
    assert "{{" not in rendered
