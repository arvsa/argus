"""add_infra_poll_target_table

Revision ID: b5c6d7e8f9a0
Revises: a9b8c7d6e5f4
Create Date: 2026-07-16

"""
from alembic import op
import sqlalchemy as sa
import sqlmodel.sql.sqltypes


revision = 'b5c6d7e8f9a0'
down_revision = 'd6e7f8a9b0c1'
branch_labels = None
depends_on = None


def upgrade():
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


def downgrade():
    op.drop_index(op.f('ix_infra_poll_target_addr'), table_name='infra_poll_target')
    op.drop_table('infra_poll_target')
