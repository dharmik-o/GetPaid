#!/usr/bin/env bash
# Loads the repo's n8n workflows into a fresh n8n. The container sees ./n8n/workflows at
# /home/node/workflows. Credentials stay placeholders: pick yours in the n8n editor afterwards
# (docs/DEPLOY.md, step 7). Refuses when n8n already has workflows, because the files carry no ids
# and a second import would add every workflow again.
set -euo pipefail
cd "$(dirname "$0")/.."

# Git Bash on Windows would otherwise rewrite the container path.
export MSYS_NO_PATHCONV=1

existing=$(docker compose exec -T n8n n8n list:workflow | grep -c . || true)
if [ "$existing" -gt 0 ]; then
  echo "n8n already has $existing workflow(s), so nothing was imported (a second import would duplicate them)." >&2
  echo "To update one, change it in the n8n editor, or run: npm run n8n:go-live" >&2
  exit 1
fi

docker compose exec -T n8n n8n import:workflow --separate --input=/home/node/workflows/
echo "Imported. Next: open the n8n editor, pick the credentials on each workflow, then publish them."
