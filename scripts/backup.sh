#!/usr/bin/env bash
# Daily backup (systemd radio-backup.timer): online SQLite .backup, integrity check,
# 14 daily / 8 weekly rotation (configurable in Settings → Backups). PLAN M12.4.
# Needs RADIO_CONFIG and the secrets in the environment (the unit provides both).
set -euo pipefail
cd "$(dirname "$0")/.."
exec ./node_modules/.bin/tsx scripts/cli.ts db:backup "$@"
