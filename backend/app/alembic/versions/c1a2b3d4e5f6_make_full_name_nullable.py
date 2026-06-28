"""Make full_name nullable

Revision ID: c1a2b3d4e5f6
Revises: 5a6bd4722c28
Create Date: 2026-06-28

"""
from alembic import op
import sqlalchemy as sa


revision = 'c1a2b3d4e5f6'
down_revision = '5a6bd4722c28'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        'user', 'full_name',
        existing_type=sa.VARCHAR(length=255),
        nullable=True,
    )


def downgrade() -> None:
    op.execute("UPDATE `user` SET full_name = '' WHERE full_name IS NULL")
    op.alter_column(
        'user', 'full_name',
        existing_type=sa.VARCHAR(length=255),
        nullable=False,
    )
