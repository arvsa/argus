"""drop_infra_poll_target_and_discovered_device_tables

Revision ID: e1f2a3b4c5d6
Revises: b5c6d7e8f9a0
Create Date: 2026-07-31

"""
from alembic import op
import sqlalchemy as sa
import sqlmodel.sql.sqltypes


revision = 'e1f2a3b4c5d6'
down_revision = 'b5c6d7e8f9a0'
branch_labels = None
depends_on = None


def upgrade():
    op.drop_index(op.f('ix_infra_poll_target_addr'), table_name='infra_poll_target')
    op.drop_table('infra_poll_target')
    op.drop_index(op.f('ix_discovered_device_addr'), table_name='discovered_device')
    op.drop_table('discovered_device')


def downgrade():
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
    op.create_table(
        'infra_poll_target',
        sa.Column('addr', sqlmodel.sql.sqltypes.AutoString(length=255), nullable=False),
        sa.Column('kind', sqlmodel.sql.sqltypes.AutoString(length=16), nullable=False),
        sa.Column('enabled', sa.Boolean(), nullable=False),
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column(
            'community', sqlmodel.sql.sqltypes.AutoString(length=255), nullable=False
        ),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        op.f('ix_infra_poll_target_addr'), 'infra_poll_target', ['addr'], unique=True
    )
