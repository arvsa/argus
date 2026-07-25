"""Add device.hostname and device.timezone

Revision ID: c5d6e7f8a9b0
Revises: b4c5d6e7f8a9
Create Date: 2026-07-16

"""
from alembic import op
import sqlalchemy as sa


revision = 'c5d6e7f8a9b0'
down_revision = 'b4c5d6e7f8a9'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'device',
        sa.Column('hostname', sa.String(length=255), nullable=True),
    )
    op.add_column(
        'device',
        sa.Column('timezone', sa.String(length=64), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('device', 'timezone')
    op.drop_column('device', 'hostname')
