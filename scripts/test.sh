#! /usr/bin/env sh

# Exit in case of error
set -e
set -x

# Isolated project name -- Compose's default project name is just the
# current directory's basename, so without this, a bare `docker compose
# down -v` here would tear down (and wipe the volumes of) a developer's
# own manually-running "argus" stack purely because it happens to share
# that name; there's no per-checkout isolation otherwise. This must never
# be able to touch anything outside its own project.
export COMPOSE_PROJECT_NAME=argus-test

# -f compose.yml only (skip compose.override.yml): the override file
# republishes db/redis/backend to fixed host ports (3306/6379/8000) purely
# for local dev convenience -- this test run only ever talks to these
# services via `docker compose exec`/the internal Compose network, never
# the host, so there's nothing to publish and nothing to conflict with.
#
# Only bring up db/prestart/backend/redis (the ROLE=client backend under
# test needs Redis reachable at startup, see compose.yml's "client"
# profile) -- frontend/pingsvc are irrelevant to backend pytest, and
# skipping them means their hardcoded host ports (5173/9090, in the base
# compose.yml itself) are never touched either, so this can run fully
# alongside a live dev stack with zero port conflicts.
COMPOSE="docker compose -f compose.yml --profile client"

$COMPOSE build backend
$COMPOSE down -v --remove-orphans # Remove possibly previous broken stacks left hanging after an error
$COMPOSE up -d db prestart backend redis
$COMPOSE exec -T backend bash scripts/tests-start.sh "$@"
$COMPOSE down -v --remove-orphans
