#!/usr/bin/env bash
set -euo pipefail

# Restore a SQLite backup. Full implementation lands in M12.4.
# Usage: scripts/restore.sh /srv/radio/backups/radio-YYYY-MM-DD_HHMMSS.sqlite3 --yes
DB_PATH="${DB_PATH:-/srv/radio/data/radio.db}"
SRC="${1:-}"
CONFIRM="${2:-}"

if [[ -z "$SRC" || ! -f "$SRC" ]]; then
  echo "Usage: $0 <backup.sqlite3> --yes" >&2
  exit 1
fi
if [[ "$CONFIRM" != "--yes" ]]; then
  echo "Refusing to overwrite $DB_PATH without --yes" >&2
  exit 1
fi

sqlite3 "$SRC" "PRAGMA integrity_check;" | grep -qx "ok"
cp "$DB_PATH" "$DB_PATH.before-restore.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
cp "$SRC" "$DB_PATH"
echo "restored $SRC -> $DB_PATH"
echo "Restart services: systemctl restart radio-api radio-playout"
