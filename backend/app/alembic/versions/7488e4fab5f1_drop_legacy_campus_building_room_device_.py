"""drop legacy campus building room device and orphaned floor tables

Revision ID: 7488e4fab5f1
Revises: b3c4d5e6f7a8
Create Date: 2026-07-07 21:47:11.723500

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

# revision identifiers, used by Alembic.
revision = '7488e4fab5f1'
down_revision = 'b3c4d5e6f7a8'
branch_labels = None
depends_on = None


def upgrade():
    # Manually reordered from autogenerate's output: children must drop
    # before the parents their FKs reference, or MySQL refuses the DROP
    # TABLE with a "referenced by a foreign key constraint" error.
    # device -> room -> floor -> building -> campus (leaf to root).
    op.drop_table('device')
    op.drop_table('room')
    op.drop_table('floor')
    op.drop_table('building')
    op.drop_table('campus')


def downgrade():
    # Manually reordered: parents must exist before a child table's FK can
    # reference them. campus -> building -> floor -> room -> device (root to leaf).
    op.create_table('campus',
    sa.Column('name', mysql.VARCHAR(length=255), nullable=False),
    sa.Column('id', mysql.CHAR(length=32), nullable=False),
    sa.Column('created_at', mysql.DATETIME(), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    mysql_collate='utf8mb4_0900_ai_ci',
    mysql_default_charset='utf8mb4',
    mysql_engine='InnoDB'
    )
    op.create_table('building',
    sa.Column('name', mysql.VARCHAR(length=255), nullable=False),
    sa.Column('id', mysql.CHAR(length=32), nullable=False),
    sa.Column('created_at', mysql.DATETIME(), nullable=True),
    sa.Column('campus_id', mysql.CHAR(length=32), nullable=False),
    sa.ForeignKeyConstraint(['campus_id'], ['campus.id'], name=op.f('building_ibfk_1'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    mysql_collate='utf8mb4_0900_ai_ci',
    mysql_default_charset='utf8mb4',
    mysql_engine='InnoDB'
    )
    op.create_table('floor',
    sa.Column('id', mysql.CHAR(length=32), nullable=False),
    sa.Column('name', mysql.VARCHAR(length=10), nullable=False),
    sa.Column('created_at', mysql.DATETIME(), nullable=True),
    sa.Column('building_id', mysql.CHAR(length=32), nullable=False),
    sa.ForeignKeyConstraint(['building_id'], ['building.id'], name=op.f('floor_ibfk_1'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    mysql_collate='utf8mb4_0900_ai_ci',
    mysql_default_charset='utf8mb4',
    mysql_engine='InnoDB'
    )
    op.create_table('room',
    sa.Column('name', mysql.VARCHAR(length=255), nullable=False),
    sa.Column('id', mysql.CHAR(length=32), nullable=False),
    sa.Column('created_at', mysql.DATETIME(), nullable=True),
    sa.Column('building_id', mysql.CHAR(length=32), nullable=False),
    sa.Column('floor_id', mysql.CHAR(length=32), nullable=True),
    sa.ForeignKeyConstraint(['building_id'], ['building.id'], name=op.f('room_ibfk_1'), ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['floor_id'], ['floor.id'], name=op.f('room_ibfk_2'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    mysql_collate='utf8mb4_0900_ai_ci',
    mysql_default_charset='utf8mb4',
    mysql_engine='InnoDB'
    )
    op.create_table('device',
    sa.Column('name', mysql.VARCHAR(length=255), nullable=False),
    sa.Column('device_type', mysql.VARCHAR(length=255), nullable=False),
    sa.Column('ip_address', mysql.VARCHAR(length=255), nullable=False),
    sa.Column('id', mysql.CHAR(length=32), nullable=False),
    sa.Column('created_at', mysql.DATETIME(), nullable=True),
    sa.Column('room_id', mysql.CHAR(length=32), nullable=True),
    sa.ForeignKeyConstraint(['room_id'], ['room.id'], name=op.f('device_ibfk_1'), ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    mysql_collate='utf8mb4_0900_ai_ci',
    mysql_default_charset='utf8mb4',
    mysql_engine='InnoDB'
    )
