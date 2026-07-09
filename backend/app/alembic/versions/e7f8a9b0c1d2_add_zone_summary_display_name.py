"""Add zone_summary.display_name

Revision ID: e7f8a9b0c1d2
Revises: d9840a02dbed
Create Date: 2026-07-09

"""
from alembic import op
import sqlalchemy as sa


revision = 'e7f8a9b0c1d2'
down_revision = 'd9840a02dbed'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'zone_summary',
        sa.Column('display_name', sa.String(length=255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('zone_summary', 'display_name')
