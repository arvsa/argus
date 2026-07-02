"""add_client_snapshot_zone_summary_and_zone_signing_key

Revision ID: b3c4d5e6f7a8
Revises: 9f1c2d3e4a5b
Create Date: 2026-07-02

"""
from alembic import op
import sqlalchemy as sa
import sqlmodel.sql.sqltypes


# revision identifiers, used by Alembic.
revision = 'b3c4d5e6f7a8'
down_revision = '9f1c2d3e4a5b'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'client_snapshot',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('tenant_id', sqlmodel.sql.sqltypes.AutoString(length=255), nullable=False),
        sa.Column('zone_id', sqlmodel.sql.sqltypes.AutoString(length=255), nullable=False),
        sa.Column('snapshot_ts', sa.BigInteger(), nullable=False),
        sa.Column('storage_key', sqlmodel.sql.sqltypes.AutoString(length=512), nullable=False),
        sa.Column('nodes_json', sa.JSON(), nullable=False),
        sa.Column('devices_json', sa.JSON(), nullable=False),
        sa.Column('signature_verified', sa.Boolean(), nullable=True),
        sa.Column('pulled_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_client_snapshot_tenant_id'), 'client_snapshot', ['tenant_id'], unique=False)
    op.create_index(op.f('ix_client_snapshot_zone_id'), 'client_snapshot', ['zone_id'], unique=False)
    op.create_index(op.f('ix_client_snapshot_storage_key'), 'client_snapshot', ['storage_key'], unique=True)

    op.create_table(
        'zone_summary',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('tenant_id', sqlmodel.sql.sqltypes.AutoString(length=255), nullable=False),
        sa.Column('zone_id', sqlmodel.sql.sqltypes.AutoString(length=255), nullable=False),
        sa.Column('up_count', sa.Integer(), nullable=False),
        sa.Column('down_count', sa.Integer(), nullable=False),
        sa.Column('last_snapshot_ts', sa.BigInteger(), nullable=True),
        sa.Column('last_pulled_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'zone_id', name='uq_zone_summary_tenant_zone'),
    )
    op.create_index(op.f('ix_zone_summary_tenant_id'), 'zone_summary', ['tenant_id'], unique=False)
    op.create_index(op.f('ix_zone_summary_zone_id'), 'zone_summary', ['zone_id'], unique=False)

    op.create_table(
        'zone_signing_key',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('tenant_id', sqlmodel.sql.sqltypes.AutoString(length=255), nullable=False),
        sa.Column('zone_id', sqlmodel.sql.sqltypes.AutoString(length=255), nullable=False),
        sa.Column('public_key_hex', sqlmodel.sql.sqltypes.AutoString(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('tenant_id', 'zone_id', name='uq_zone_signing_key_tenant_zone'),
    )
    op.create_index(op.f('ix_zone_signing_key_tenant_id'), 'zone_signing_key', ['tenant_id'], unique=False)
    op.create_index(op.f('ix_zone_signing_key_zone_id'), 'zone_signing_key', ['zone_id'], unique=False)


def downgrade():
    op.drop_index(op.f('ix_zone_signing_key_zone_id'), table_name='zone_signing_key')
    op.drop_index(op.f('ix_zone_signing_key_tenant_id'), table_name='zone_signing_key')
    op.drop_table('zone_signing_key')

    op.drop_index(op.f('ix_zone_summary_zone_id'), table_name='zone_summary')
    op.drop_index(op.f('ix_zone_summary_tenant_id'), table_name='zone_summary')
    op.drop_table('zone_summary')

    op.drop_index(op.f('ix_client_snapshot_storage_key'), table_name='client_snapshot')
    op.drop_index(op.f('ix_client_snapshot_zone_id'), table_name='client_snapshot')
    op.drop_index(op.f('ix_client_snapshot_tenant_id'), table_name='client_snapshot')
    op.drop_table('client_snapshot')
