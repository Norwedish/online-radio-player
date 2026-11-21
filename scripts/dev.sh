#!/usr/bin/env bash
set -euo pipefail

# Start the development environment (Linux/macOS/Git Bash/WSL).
# Icecast is optional; start it with:
#   docker compose -f docker-compose.dev.yml up -d
cd "$(dirname "$0")/.."

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required (npm install -g pnpm@10)" >&2
  exit 1
fi

exec pnpm dev
