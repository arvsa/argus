"""add_discovered_device_table

Revision ID: d6e7f8a9b0c1
Revises: c5d6e7f8a9b0
Create Date: 2026-07-16

"""
from alembic import op
import sqlalchemy as sa
import sqlmodel.sql.sqltypes


revision = 'd6e7f8a9b0c1'
down_revision = 'c5d6e7f8a9b0'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'discovered_device',
        sa.Column('addr', sqlmodel.sql.sqltypes.AutoString(length=255), nullable=False),
        sa.Column('mac', sqlmodel.sql.sqltypes.AutoString(length=32), nullable=True),
        sa.Column(
            'hostname', sqlmodel.sql.sqltypes.AutoString(length=255), nullable=True
        ),
        sa.Column(
            'discovered_via', sqlmodel.sql.sqltypes.AutoString(length=64), nullable=False
        ),
        sa.Column('status', sqlmodel.sql.sqltypes.AutoString(length=16), nullable=False),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('first_seen_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        op.f('ix_discovered_device_addr'), 'discovered_device', ['addr'], unique=True
    )


def downgrade():
    op.drop_index(op.f('ix_discovered_device_addr'), table_name='discovered_device')
    op.drop_table('discovered_device')
