#! /usr/bin/env bash

set -e
set -x

# Let the DB start
python app/backend_pre_start.py

# Run migrations
alembic upgrade head

# Seed the Node/NodeType hierarchy shape from hierarchy.yaml, if present
# (see plan/dynamic-hierarchy-multi-zone-architecture.md §4.7)
python app/seed_hierarchy.py

# # Create initial data in DB
python app/initial_data.py
