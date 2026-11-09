#!/usr/bin/env bash
# Brings the server up to date with the repository: pull, install, build, migrate, restart, then
# show the health of each service. Run it on the server from anywhere:
#   bash deploy/update.sh
# It stops at the first problem (nothing is half-restarted before the build and migration pass).
set -euo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml:docker-compose.prod.yml}"

git pull --ff-only
npm ci
docker compose build
# Migrations run from the server's shell against the Postgres published on 127.0.0.1 only.
npm run db:migrate
docker compose up -d --wait

echo
docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Health}}'
