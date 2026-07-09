#! /usr/bin/env sh

# Exit in case of error
set -e
set -x

# --profile client: redis/pingsvc only start under this profile (see
# compose.yml); the test backend's default ROLE=client needs Redis
# reachable at startup, so tests must bring the client stack up, not just
# the profile-less default services.
docker compose --profile client build
docker compose --profile client down -v --remove-orphans # Remove possibly previous broken stacks left hanging after an error
docker compose --profile client up -d
docker compose exec -T backend bash scripts/tests-start.sh "$@"
docker compose --profile client down -v --remove-orphans
