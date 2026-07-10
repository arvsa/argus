"""add composite (tenant_id, zone_id, snapshot_ts) index to client_snapshot

get_latest_client_snapshot's ORDER BY snapshot_ts DESC LIMIT 1 has no index
to walk, so MySQL filesorts full rows -- including the multi-hundred-KB JSON
columns -- and fails with error 1038 (out of sort memory) on realistically
sized snapshots, 500ing GET /zones/{tenant_id}/{zone_id}/latest.

Revision ID: a9b8c7d6e5f4
Revises: f1a2b3c4d5e6
Create Date: 2026-07-10

"""
from alembic import op

# revision identifiers, used by Alembic.
revision = 'a9b8c7d6e5f4'
down_revision = 'f1a2b3c4d5e6'
branch_labels = None
depends_on = None


def upgrade():
    op.create_index(
        'ix_client_snapshot_zone_latest',
        'client_snapshot',
        ['tenant_id', 'zone_id', 'snapshot_ts'],
    )


def downgrade():
    op.drop_index('ix_client_snapshot_zone_latest', table_name='client_snapshot')
