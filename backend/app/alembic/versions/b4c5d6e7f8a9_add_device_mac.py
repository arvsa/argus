"""Add device.mac

Revision ID: b4c5d6e7f8a9
Revises: a9b8c7d6e5f4
Create Date: 2026-07-16

"""
from alembic import op
import sqlalchemy as sa


revision = 'b4c5d6e7f8a9'
down_revision = 'a9b8c7d6e5f4'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'device',
        sa.Column('mac', sa.String(length=32), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('device', 'mac')
