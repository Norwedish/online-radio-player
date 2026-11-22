#!/usr/bin/env bash
# Remove the station services (PLAN M13.6). Data stays unless --purge is given.
#   sudo ./scripts/uninstall.sh            # stop + remove units and nginx site
#   sudo ./scripts/uninstall.sh --purge    # also delete /srv/radio, /etc/radio and the radio user
set -euo pipefail
PURGE=0; SUFFIX=""; ROOT=/srv/radio; ETC=/etc/radio
for a in "$@"; do case "$a" in --purge) PURGE=1 ;; --staging) SUFFIX="-staging"; ROOT=/srv/radio-staging; ETC=/etc/radio-staging ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
for u in "radio-api$SUFFIX" "radio-playout$SUFFIX" "radio-icecast$SUFFIX" "radio-backup$SUFFIX.timer" "radio-backup$SUFFIX"; do
  systemctl disable --now "$u" 2>/dev/null || true
  rm -f "/etc/systemd/system/$u" "/etc/systemd/system/$u.service"
done
systemctl daemon-reload || true
rm -f "/etc/nginx/sites-enabled/radio$SUFFIX.conf" "/etc/nginx/sites-available/radio$SUFFIX.conf"
nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
pgrep -u radio >/dev/null && { echo "stopping leftover radio processes"; pkill -u radio || true; }
if [[ $PURGE -eq 1 ]]; then
  read -r -p "Delete $ROOT (media symlink target is kept), $ETC and the radio user? Type 'purge': " ok
  [[ "$ok" == "purge" ]] || { echo "aborted"; exit 1; }
  rm -rf "$ROOT" "$ETC"
  [[ -z "$SUFFIX" ]] && { userdel radio 2>/dev/null || true; rm -rf /var/lib/radio-icecast /var/log/radio-icecast; }
  echo "purged"
else
  echo "services removed; data kept in $ROOT and config in $ETC"
fi
