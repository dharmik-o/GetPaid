#!/usr/bin/env bash
# Dumps the database to deploy/backups/<date>.sql.gz and keeps the 14 newest. The files hold client
# data: they are git-ignored, readable only by you, and should also be copied off the server.
#   bash deploy/backup.sh
# Daily, at 03:00 server time (crontab -e):
#   0 3 * * * bash $HOME/getpaid/deploy/backup.sh >> $HOME/getpaid/deploy/backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
export COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml:docker-compose.prod.yml}"

dir=deploy/backups
mkdir -p "$dir"
chmod 700 "$dir"

file="$dir/$(date -u +%Y-%m-%d).sql.gz"
partial="$file.partial"
trap 'rm -f "$partial"' EXIT

# The database name and user come from the Postgres container's own settings.
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' | gzip >"$partial"
mv "$partial" "$file"
chmod 600 "$file"

# shellcheck disable=SC2012 # the names are dates, so ls is safe here
ls -1t "$dir"/*.sql.gz | tail -n +15 | xargs -r rm --
echo "$(date -u +%FT%TZ) backup saved: $file ($(du -h "$file" | cut -f1))"
