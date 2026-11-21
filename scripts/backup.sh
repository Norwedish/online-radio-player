#!/usr/bin/env bash
set -euo pipefail

# Daily SQLite backup with simple retention. Full implementation lands in M12.4.
DB_PATH="${DB_PATH:-/srv/radio/data/radio.db}"
BACKUP_DIR="${BACKUP_DIR:-/srv/radio/backups}"
KEEP_DAILY="${KEEP_DAILY:-14}"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required" >&2
  exit 1
fi
if [[ ! -f "$DB_PATH" ]]; then
  echo "Database not found: $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y-%m-%d_%H%M%S)"
OUT="$BACKUP_DIR/radio-$STAMP.sqlite3"

sqlite3 "$DB_PATH" ".backup '$OUT'"
sqlite3 "$OUT" "PRAGMA integrity_check;" | grep -qx "ok"
echo "backup ok: $OUT"

# Keep the newest N daily backups.
find "$BACKUP_DIR" -maxdepth 1 -name 'radio-*.sqlite3' -type f -printf '%T@ %p\n' \
  | sort -nr \
  | tail -n +$((KEEP_DAILY + 1)) \
  | cut -d' ' -f2- \
  | xargs -r rm -f
