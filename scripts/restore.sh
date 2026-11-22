#!/usr/bin/env bash
# Restore a backup (PLAN §10.3): stops the API and worker, verifies and swaps the DB
# (keeping a pre-restore safety copy), restarts, runs the smoke test.
#   sudo ./scripts/restore.sh /srv/radio/backups/radio-2026-11-22T031500Z.sqlite3 --yes
set -euo pipefail
SRC="${1:-}"; CONFIRM="${2:-}"; ETC="${ETC:-/etc/radio}"; ROOT="${ROOT:-/srv/radio}"
[[ -n "$SRC" && -f "$SRC" ]] || { echo "usage: $0 <backup.sqlite3> --yes" >&2; exit 1; }
[[ "$CONFIRM" == "--yes" ]] || { echo "refusing to overwrite the live database without --yes" >&2; exit 1; }
systemctl stop radio-api radio-playout
runuser -u radio -- bash -c "set -a && . '$ETC/secrets.env' && set +a && export RADIO_CONFIG='$ETC/station.json' NODE_ENV=production && cd '$ROOT/app' && corepack pnpm -s db:restore --file '$SRC'"
systemctl start radio-playout radio-api
sleep 4
"$ROOT/app/scripts/smoke-test.sh"
