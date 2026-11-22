#!/usr/bin/env bash
# Upgrade in place (PLAN §10.4 / M13.6): backup → new code → build → migrate → restart → smoke test.
# Data, media, config and secrets are never touched.
#
#   sudo ./scripts/upgrade.sh                 # from the directory you pulled/unpacked
#   sudo ./scripts/upgrade.sh --ref v1.2.0    # git checkout a tag first (source dir must be a git clone)
#   sudo ./scripts/upgrade.sh --staging
# Rollback: restore the backup printed below (pnpm db:restore --file …), redeploy the previous
# tag with this script, restart services.
set -euo pipefail
REF=""; STAGING=0
while [[ $# -gt 0 ]]; do case "$1" in --ref) REF="$2"; shift 2 ;; --staging) STAGING=1; shift ;; *) echo "unknown option $1" >&2; exit 2 ;; esac; done
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [[ $STAGING -eq 1 ]]; then ROOT=/srv/radio-staging; ETC=/etc/radio-staging; SUFFIX="-staging"; API_PORT=3002; ICE=8002; else ROOT=/srv/radio; ETC=/etc/radio; SUFFIX=""; API_PORT=3001; ICE=8000; fi
APP="$ROOT/app"
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
as_radio() { runuser -u radio -- env -i HOME="$ROOT" PATH="$PATH" LANG=C.UTF-8 ${HTTPS_PROXY:+HTTPS_PROXY="$HTTPS_PROXY"} ${NODE_EXTRA_CA_CERTS:+NODE_EXTRA_CA_CERTS="$NODE_EXTRA_CA_CERTS"} bash -c "set -a && . '$ETC/secrets.env' && set +a && export RADIO_CONFIG='$ETC/station.json' NODE_ENV=production && cd '$APP' && $*"; }

echo "→ backup before upgrade"
as_radio "corepack pnpm -s db:backup" | grep '"path"' || true
if [[ -n "$REF" ]]; then git -C "$SRC_DIR" fetch --tags && git -C "$SRC_DIR" checkout "$REF"; fi
echo "→ code $(git -C "$SRC_DIR" describe --tags --always 2>/dev/null || echo "from $SRC_DIR")"
if [[ "$SRC_DIR" != "$APP" ]]; then
  rsync -a --delete --chmod=D755,F644 --exclude node_modules --exclude data --exclude .git --exclude 'apps/*/dist' --exclude 'packages/*/dist' --exclude test-results --exclude '*.tsbuildinfo' --exclude playwright-report "$SRC_DIR/" "$APP/"
  chown -R radio:radio "$APP"
  chmod 755 "$APP"/scripts/*.sh
fi
echo "→ install + build"
as_radio "corepack pnpm install --frozen-lockfile --prod=false && corepack pnpm build"
chmod 755 "$APP" "$APP/apps" "$APP/apps/web" && chmod -R a+rX "$APP/apps/web/dist"
echo "→ validate config + migrate"
as_radio "corepack pnpm -s config:validate '$ETC/station.json' && corepack pnpm -s db:migrate \"\$(jq -r .db.file '$ETC/station.json')\""
echo "→ refresh systemd units and Icecast config (nginx template changes: re-run install.sh, it is idempotent)"
for unit in radio-api.service radio-playout.service radio-icecast.service radio-backup.service radio-backup.timer; do
  sed -e "s#/usr/bin/node #$(command -v node) #g" -e "s#__NODE_DIR__#$(dirname "$(readlink -f "$(command -v node)")")#g" -e "s#/srv/radio#$ROOT#g" -e "s#/etc/radio#$ETC#g" -e "s#radio-icecast.service#radio-icecast$SUFFIX.service#g" -e "s#radio-playout.service#radio-playout$SUFFIX.service#g" -e "s#/run/radio#/run/radio$SUFFIX#g" -e "s#RuntimeDirectory=radio#RuntimeDirectory=radio$SUFFIX#g" "$APP/deploy/systemd/$unit" >"/etc/systemd/system/${unit%.*}$SUFFIX.${unit##*.}"
done
as_radio "corepack pnpm -s icecast:config --out '$ROOT/var/icecast.xml'" && install -o root -g icecast -m 640 "$ROOT/var/icecast.xml" "$ETC/icecast.xml" && rm -f "$ROOT/var/icecast.xml"
systemctl daemon-reload
echo "→ restart (API first; the playout worker last so audio is interrupted for ~2 s only)"
systemctl restart "radio-api$SUFFIX"
systemctl reload-or-restart "radio-icecast$SUFFIX"
systemctl restart "radio-playout$SUFFIX"
sleep 5
API_URL="http://127.0.0.1:$API_PORT" ICECAST_URL="http://127.0.0.1:$ICE" WEB_URL="http://127.0.0.1" "$APP/scripts/smoke-test.sh"
