#!/usr/bin/env bash
set -euo pipefail

# Minimal smoke test. Expands as milestones land (M5, M13.7).
API_URL="${API_URL:-http://127.0.0.1:3001}"
ICECAST_URL="${ICECAST_URL:-http://127.0.0.1:8000}"

echo "→ API health"
curl -fsS "${API_URL}/api/health" | grep -q '"status":"ok"'
echo "  ok"

echo "→ Icecast status"
if curl -fsS "${ICECAST_URL}/status-json.xsl" >/dev/null 2>&1; then
  echo "  ok"
else
  echo "  warning: Icecast not reachable at ${ICECAST_URL}" >&2
fi

echo "✅ smoke test passed"
