#!/usr/bin/env bash
# Post-install smoke test (PLAN M13.7): API health/readiness, Icecast mounts with real
# audio, public API, UI and HLS. Exit code 0 only when everything essential passes.
set -uo pipefail
API_URL="${API_URL:-http://127.0.0.1:3001}"
ICECAST_URL="${ICECAST_URL:-http://127.0.0.1:8000}"
WEB_URL="${WEB_URL:-$API_URL}"
FAIL=0
ok() { echo "  ✓ $*"; }
bad() { echo "  ✗ $*" >&2; FAIL=1; }
note() { echo "  · $*"; }

echo "→ API"
curl -fsS "$API_URL/api/health" | grep -q '"status":"ok"' && ok "health" || bad "health ($API_URL/api/health)"
READY="$(curl -sS "$API_URL/api/ready" || true)"
echo "$READY" | grep -qE '"status":"(ready|degraded)"' && ok "ready: $(echo "$READY" | grep -oE '"status":"[a-z_]+"' | head -1)" || bad "readiness: $READY"
echo "$READY" | grep -q '"worker":{"ok":true' && ok "playout worker connected" || bad "playout worker not connected"

echo "→ Icecast mounts"
STATUS="$(curl -fsS "$ICECAST_URL/status-json.xsl" 2>/dev/null || true)"
if [[ -z "$STATUS" ]]; then bad "Icecast not reachable at $ICECAST_URL"; else
  MOUNTS="$(echo "$STATUS" | grep -oE '"listenurl":"[^"]+"' | sed -E 's#.*/##; s#"##')"
  [[ -n "$MOUNTS" ]] && ok "mounts: $(echo $MOUNTS)" || bad "no mounts published"
  for m in $MOUNTS; do
    [[ "$m" == live* ]] && continue
    TMP="$(mktemp)"
    for _ in 1 2 3; do  # an encoder may still be in its restart backoff right after (re)start
      curl -s --max-time 3 -o "$TMP" "$ICECAST_URL/$m" || true
      [[ -s "$TMP" ]] && break; sleep 5
    done
    if command -v ffmpeg >/dev/null && [[ -s "$TMP" ]]; then
      VOL="$(ffmpeg -hide_banner -nostats -i "$TMP" -af volumedetect -f null - 2>&1 | grep -oE 'mean_volume: -?[0-9.]+' | grep -oE -- '-?[0-9.]+$')"
      if [[ -n "$VOL" ]] && awk "BEGIN{exit !($VOL > -60)}"; then ok "$m audible (mean ${VOL} dB)"; else bad "$m silent or undecodable"; fi
    else
      [[ -s "$TMP" ]] && ok "$m streams ($(stat -c %s "$TMP") bytes in 3 s)" || bad "$m returned no data"
    fi
    rm -f "$TMP"
  done
fi

echo "→ Public API + UI"
curl -fsS "$API_URL/api/public/now-playing" | grep -q '"streams"' && ok "now-playing" || bad "now-playing"
curl -fsS "$API_URL/api/docs" | grep -q '"openapi"' && ok "OpenAPI" || bad "OpenAPI"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$WEB_URL/listen")"
[[ "$CODE" == "200" || "$CODE" == "301" || "$CODE" == "308" ]] && ok "listener page ($CODE)" || bad "listener page HTTP $CODE at $WEB_URL/listen"
if curl -fsS "$WEB_URL/hls/stream.m3u8" 2>/dev/null | head -c 7 | grep -q '#EXTM3U'; then ok "HLS playlist"
else note "no HLS playlist at $WEB_URL/hls/stream.m3u8 (fine when HLS is disabled)"; fi

[[ $FAIL -eq 0 ]] && echo "✅ smoke test passed" || echo "❌ smoke test failed"
exit $FAIL
