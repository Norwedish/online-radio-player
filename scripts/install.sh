#!/usr/bin/env bash
# One-command installer for a clean Debian 13 LXC/VM (PLAN §6.12 / M13.1).
# Idempotent: re-running only fills in what is missing and keeps data, config and secrets.
#
#   sudo ./scripts/install.sh --domain radio.example.com --email ops@example.com
#   sudo ./scripts/install.sh --domain radio.example.com --skip-certbot --stereotool-bypass
#
# Options:
#   --domain NAME          public hostname (default: radio.example.com)
#   --email ADDR           Let's Encrypt account email (required for Certbot)
#   --skip-certbot         do not request a TLS certificate
#   --stereotool-bypass    run without Thimeo Stereo Tool (stereotool.enabled=false)
#   --stereotool PATH      Thimeo Stereo_Tool_Generic_plugin.zip (recommended: the libStereoTool
#                          plugin, like Liquidsoap/AzuraCast), a libStereoTool*.so, or a directory
#                          with either the .so or the legacy stereotool_cmd; installed to /opt/stereotool
#   --preset FILE          Stereo Tool preset (.sts) copied to /etc/radio/stereotool.sts
#   --stereotool-key KEY   Stereo Tool licence key (or @FILE to read it from a file, which keeps
#                          it out of your shell history); stored 0600 in /srv/radio/var/stereotool
#   --media DIR            existing media library to link as /srv/radio/media
#   --emergency FILE       emergency loop audio file
#   --station-name NAME    station name for the first config
#   --staging              staging ports/paths (API 3002, Icecast 8002, /srv/radio-staging)
#   --no-start             install everything but do not (re)start services
#   --dry-run              print the steps without changing the system
set -euo pipefail

DOMAIN="radio.example.com"
EMAIL=""
SKIP_CERTBOT=0
ST_BYPASS=0
ST_DIR=""
ST_PRESET=""
ST_KEY=""
MEDIA_SRC=""
EMERGENCY_SRC=""
STATION_NAME="My Radio Station"
STAGING=0
NO_START=0
DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --skip-certbot) SKIP_CERTBOT=1; shift ;;
    --stereotool-bypass) ST_BYPASS=1; shift ;;
    --stereotool) ST_DIR="$2"; shift 2 ;;
    --preset) ST_PRESET="$2"; shift 2 ;;
    --stereotool-key) ST_KEY="$2"; shift 2 ;;
    --media) MEDIA_SRC="$2"; shift 2 ;;
    --emergency) EMERGENCY_SRC="$2"; shift 2 ;;
    --station-name) STATION_NAME="$2"; shift 2 ;;
    --staging) STAGING=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [[ $STAGING -eq 1 ]]; then
  ROOT=/srv/radio-staging; ETC=/etc/radio-staging; API_PORT=3002; ICECAST_PORT=8002; WORKER_PORT=3201; SUFFIX="-staging"
else
  ROOT=/srv/radio; ETC=/etc/radio; API_PORT=3001; ICECAST_PORT=8000; WORKER_PORT=3101; SUFFIX=""
fi
LIVE_PORT=$((WORKER_PORT + 1))
APP="$ROOT/app"
NODE_MAJOR=22
STEP=0
HAS_SYSTEMD=0
[[ -d /run/systemd/system ]] && HAS_SYSTEMD=1

step() { STEP=$((STEP + 1)); printf '\n\033[1;33m[%02d]\033[0m %s\n' "$STEP" "$*"; }
run() { if [[ $DRY -eq 1 ]]; then echo "  + $*"; else "$@"; fi; }
info() { echo "  $*"; }
warn() { echo -e "  \033[1;31mwarning:\033[0m $*" >&2; }
# Build/CLI steps run as the radio user with a clean environment (only proxy/CA settings pass through).
radio_env() {
  local v out=(HOME="$ROOT" PATH="$PATH" LANG=C.UTF-8)
  for v in HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy NODE_EXTRA_CA_CERTS; do [[ -n "${!v:-}" ]] && out+=("$v=${!v}"); done
  printf '%s\n' "${out[@]}"
}
as_radio() {
  if [[ $DRY -eq 1 ]]; then echo "  + (radio) $*"; return; fi
  local envs=()
  mapfile -t envs < <(radio_env)
  runuser -u radio -- env -i "${envs[@]}" bash -c "$*"
}

[[ $EUID -eq 0 || $DRY -eq 1 ]] || { echo "run as root (sudo)" >&2; exit 1; }

# Fail before touching the system when a path argument is wrong (e.g. "/~/file" instead of "~/file").
die() { echo -e "\033[1;31merror:\033[0m $*" >&2; exit 2; }
[[ -z "$ST_DIR" || -e "$ST_DIR" ]] || die "--stereotool: $ST_DIR does not exist (use an absolute path; '~' is not expanded after '/')"
[[ -z "$ST_PRESET" || -f "$ST_PRESET" ]] || die "--preset: $ST_PRESET is not a file"
[[ -z "$MEDIA_SRC" || -d "$MEDIA_SRC" ]] || die "--media: $MEDIA_SRC is not a directory"
[[ -z "$EMERGENCY_SRC" || -f "$EMERGENCY_SRC" ]] || die "--emergency: $EMERGENCY_SRC is not a file"
if [[ "$ST_KEY" == @* ]]; then
  [[ -f "${ST_KEY#@}" ]] || die "--stereotool-key: ${ST_KEY#@} is not a file"
  ST_KEY="$(tr -d '\r\n' <"${ST_KEY#@}")"
fi
[[ -z "$ST_KEY" || ${#ST_KEY} -ge 8 ]] || die "--stereotool-key: that does not look like a licence key"

step "Preflight"
. /etc/os-release 2>/dev/null || true
info "OS: ${PRETTY_NAME:-unknown}  CPUs: $(nproc)  RAM: $(awk '/MemTotal/ {printf "%.1f GB", $2/1048576}' /proc/meminfo)  free disk: $(df -h / | awk 'NR==2 {print $4}')"
[[ "${ID:-}" == "debian" && "${VERSION_ID:-}" == "13" ]] || warn "tested on Debian 13; continuing on ${PRETTY_NAME:-this system}"
[[ $(nproc) -ge 2 ]] || warn "fewer than 2 vCPUs: encoders + Stereo Tool may not keep up"
for p in "$API_PORT" "$ICECAST_PORT" "$WORKER_PORT" "$LIVE_PORT"; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then
    systemctl is-active --quiet "radio-api$SUFFIX" 2>/dev/null || warn "port $p is already in use"
  fi
done
[[ $HAS_SYSTEMD -eq 1 ]] || warn "systemd is not PID 1 here: units are installed but not started"

step "System packages"
export DEBIAN_FRONTEND=noninteractive
run apt-get update -qq
run apt-get install -y -qq ffmpeg icecast2 sqlite3 nginx curl ca-certificates gnupg unzip build-essential python3 rsync jq
# libStereoTool links against the ALSA userspace library (no sound device needed); Debian 13 renamed it.
run apt-get install -y -qq libasound2t64 2>/dev/null || run apt-get install -y -qq libasound2
[[ $SKIP_CERTBOT -eq 1 ]] || run apt-get install -y -qq certbot python3-certbot-nginx
# We run Icecast through radio-icecast.service with our generated config.
if [[ $HAS_SYSTEMD -eq 1 ]]; then run systemctl disable --now icecast2 >/dev/null 2>&1 || true; fi

step "Node.js $NODE_MAJOR and pnpm"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt $NODE_MAJOR ]]; then
  run bash -c "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - && apt-get install -y -qq nodejs"
fi
run corepack enable
info "node $(node -v 2>/dev/null || echo '?')"

step "User and directories"
id radio >/dev/null 2>&1 || run useradd --system --home "$ROOT" --shell /usr/sbin/nologin radio
run mkdir -p "$ROOT"/{media,recordings,backups,logs,hls,artwork,var} "$ETC" /var/lib/radio-icecast /var/log/radio-icecast
run mkdir -p "$ROOT/media/Inbox" "$ROOT/media/Nieuws" "$ROOT/media/Emergency" "$ROOT/media/General" "$ROOT/media/Jingles"
run chown -R radio:radio "$ROOT"
run chown icecast2:icecast /var/lib/radio-icecast /var/log/radio-icecast
run chmod 751 "$ETC"   # traversable for icecast2 (reads only icecast.xml); files stay 0640
run chown root:radio "$ETC"
getent group icecast >/dev/null && run usermod -aG icecast radio || true

step "Application code"
if [[ "$SRC_DIR" != "$APP" ]]; then
  run rsync -a --delete --chmod=D755,F644 --exclude node_modules --exclude data --exclude .git --exclude 'apps/*/dist' --exclude 'packages/*/dist' --exclude test-results --exclude '*.tsbuildinfo' --exclude playwright-report --exclude coverage --exclude .env --exclude '*.zip' --exclude '*.sts' --exclude '*.lic' "$SRC_DIR/" "$APP/"
  run chown -R radio:radio "$APP"
  run chmod 755 "$APP"/scripts/*.sh
fi
as_radio "cd '$APP' && corepack pnpm install --frozen-lockfile --prod=false && corepack pnpm build"
run chmod 755 "$APP" "$APP/apps" "$APP/apps/web"; run chmod -R a+rX "$APP/apps/web/dist"   # nginx (www-data) serves the SPA

step "Secrets ($ETC/secrets.env)"
SECRETS="$ETC/secrets.env"
gen() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24; }
if [[ ! -f "$SECRETS" ]]; then
  ADMIN_PW="$(gen)"
  if [[ $DRY -eq 0 ]]; then
    umask 077
    cat >"$SECRETS" <<EOS
# Generated by install.sh on $(date -I). Keep chmod 600. Never commit.
ICECAST_SOURCE_PASSWORD=$(gen)
ICECAST_ADMIN_PASSWORD=$(gen)
ICECAST_LIVE_PASSWORD=$(gen)
SESSION_SECRET=$(gen)$(gen)
PLAYOUT_TOKEN=$(gen)
ADMIN_USERNAME=admin
ADMIN_EMAIL=admin@$DOMAIN
ADMIN_PASSWORD=$ADMIN_PW
PORT=$API_PORT
PLAYOUT_LIVE_PORT=$LIVE_PORT
PUBLIC_BASE_URL=https://$DOMAIN
SMTP_USER=
SMTP_PASSWORD=
STEREOTOOL_LICENSE_KEY=
# Set to protect /api/metrics with "Authorization: Bearer <token>" (needed when Prometheus scrapes remotely)
METRICS_TOKEN=
EOS
    chown root:radio "$SECRETS"
    chmod 640 "$SECRETS"
    umask 022
  fi
  info "created; first admin password: $ADMIN_PW (change it after the first login)"
else
  info "kept existing secrets"
fi

step "Station configuration ($ETC/station.json)"
CONF="$ETC/station.json"
if [[ ! -f "$CONF" ]]; then
  if [[ $DRY -eq 0 ]]; then
    jq --arg name "$STATION_NAME" --arg domain "$DOMAIN" --arg root "$ROOT" --argjson icePort "$ICECAST_PORT" --argjson wport "$WORKER_PORT" --argjson st "$([[ $ST_BYPASS -eq 1 ]] && echo false || echo true)" '
      .station.name = $name | .station.domain = $domain
      | .icecast.port = $icePort | .worker.protocolPort = $wport
      | .media.root = ($root + "/media") | .media.watchFolder = ($root + "/media/Inbox") | .media.artworkDir = ($root + "/artwork") | .media.nasPaths = []
      | .audio.emergencyFile = ($root + "/media/Emergency/emergency-loop.mp3")
      | .backups.dir = ($root + "/backups") | .db.backupDir = ($root + "/backups") | .db.file = ($root + "/var/radio.sqlite")
      | .worker.logDir = ($root + "/logs") | .web.publicBaseUrl = ("https://" + $domain + "/listen")
      | .stereotool.enabled = $st | .stereotool.preset = ($etc + "/stereotool.sts")' --arg etc "$ETC" "$APP/config/station.example.json" >"$CONF"
    chown root:radio "$CONF"
    chmod 640 "$CONF"
  fi
  info "created from config/station.example.json (edit it, then: systemctl restart radio-api$SUFFIX radio-playout$SUFFIX)"
else
  info "kept existing config"
fi
as_radio "cd '$APP' && set -a && . '$SECRETS' && set +a && corepack pnpm -s config:validate '$CONF'"

step "Media library and emergency loop"
if [[ -n "$MEDIA_SRC" ]]; then
  [[ -d "$MEDIA_SRC" ]] || { echo "media dir not found: $MEDIA_SRC" >&2; exit 1; }
  if [[ ! -L "$ROOT/media" ]]; then run mv "$ROOT/media" "$ROOT/media.empty"; run ln -s "$MEDIA_SRC" "$ROOT/media"; fi
  info "linked $MEDIA_SRC → $ROOT/media (the radio user needs read access)"
fi
# A linked library does not have the standard folders yet (the emergency loop below needs Emergency/).
for d in Inbox Nieuws Emergency General Jingles; do
  if [[ ! -d "$ROOT/media/$d" ]]; then
    run mkdir -p "$ROOT/media/$d"
    # Mounted filesystems (NFS, WSL /mnt/*) may refuse chown; the folder is still usable.
    run chown radio:radio "$ROOT/media/$d" 2>/dev/null || true
  fi
done
EMERGENCY="$ROOT/media/Emergency/emergency-loop.mp3"
if [[ -n "$EMERGENCY_SRC" ]]; then run install -o radio -g radio -m 644 "$EMERGENCY_SRC" "$EMERGENCY"; fi
if [[ ! -f "$EMERGENCY" ]]; then
  warn "no emergency loop at $EMERGENCY — generating a placeholder; replace it with your own station loop"
  run ffmpeg -v error -y -f lavfi -i "aevalsrc=0.2*sin(2*PI*440*t)*lt(mod(t\,3)\,1):s=48000:d=30" -ac 2 -ar 48000 -c:a libmp3lame -b:a 128k "$EMERGENCY"
  run chown radio:radio "$EMERGENCY"
fi
ffprobe -v error "$EMERGENCY" >/dev/null 2>&1 || [[ $DRY -eq 1 ]] || warn "emergency loop is not a readable audio file"

step "Thimeo Stereo Tool"
# Library for this CPU, like AzuraCast: the headless (non-X11) build from lib/Linux/<arch>.
st_lib_name() {
  case "$(uname -m)" in
    x86_64) echo "libStereoTool_intel64.so" ;;
    aarch64|arm64) echo "libStereoTool_arm64.so" ;;
    i?86) echo "libStereoTool_intel32.so" ;;
    armv7l|armhf) echo "libStereoTool_arm32.so" ;;
    *) echo "libStereoTool_intel64.so" ;;
  esac
}
set_conf() { [[ $DRY -eq 1 ]] || { jq "$@" "$CONF" >"$CONF.tmp" && mv "$CONF.tmp" "$CONF" && chown root:radio "$CONF" && chmod 640 "$CONF"; }; }
if [[ $ST_BYPASS -eq 1 ]]; then
  info "bypass requested: stereotool.enabled=false"
else
  LIBNAME="$(st_lib_name)"
  if [[ -n "$ST_DIR" ]]; then
    run mkdir -p /opt/stereotool
    if [[ -f "$ST_DIR" && "$ST_DIR" == *.zip ]]; then
      # Stereo_Tool_Generic_plugin.zip: libStereoTool_<version>/lib/Linux/<arch>/<lib>.so
      TMPX="$(mktemp -d)"
      run unzip -q -o "$ST_DIR" -d "$TMPX" 2>/dev/null || true   # warns about backslash paths; still extracts
      FOUND="$(find "$TMPX" -type f -name "$LIBNAME" ! -path '*Kantar*' | head -1)"
      if [[ -n "$FOUND" ]]; then
        run install -o radio -g radio -m 644 "$FOUND" "/opt/stereotool/$LIBNAME"
        VERSION_DIR="$(find "$TMPX" -maxdepth 1 -type d -name 'libStereoTool_*' | head -1)"
        [[ -n "$VERSION_DIR" && $DRY -eq 0 ]] && basename "$VERSION_DIR" | sed 's/^libStereoTool_//' >/opt/stereotool/.currentversion
        info "installed $LIBNAME from $(basename "$ST_DIR")"
      else
        warn "$LIBNAME not found in $ST_DIR (expected lib/Linux/... inside Thimeo's generic plugin zip)"
      fi
      rm -rf "$TMPX"
    elif [[ -f "$ST_DIR" && "$ST_DIR" == *.so ]]; then
      run install -o radio -g radio -m 644 "$ST_DIR" "/opt/stereotool/$LIBNAME"
    else
      run cp -a "$ST_DIR"/. /opt/stereotool/
      run chmod 755 /opt/stereotool/stereotool_cmd* 2>/dev/null || true
      run chmod 600 /opt/stereotool/*.lic 2>/dev/null || true
      run chown -R radio:radio /opt/stereotool
    fi
  fi
  [[ -n "$ST_PRESET" ]] && run install -o radio -g radio -m 600 "$ST_PRESET" "$ETC/stereotool.sts"
  PRESET="$(jq -r .stereotool.preset "$CONF" 2>/dev/null)"
  [[ -f "$PRESET" ]] || warn "no Stereo Tool preset at $PRESET: the library runs with its default settings (pass --preset FILE.sts)"
  LIB="/opt/stereotool/$LIBNAME"
  if [[ -f "$LIB" ]]; then
    # Prefer the plugin library whenever it is installed.
    set_conf --arg lib "$LIB" '.stereotool.inputMode = "plugin" | .stereotool.library = $lib'
    run mkdir -p "$ROOT/var/stereotool" && run chown radio:radio "$ROOT/var/stereotool"
    KEYFILE="$ROOT/var/stereotool/license.key"
    if [[ -n "$ST_KEY" && $DRY -eq 0 ]]; then
      (umask 077 && printf '%s\n' "$ST_KEY" >"$KEYFILE") && chown radio:radio "$KEYFILE" && chmod 600 "$KEYFILE"
      info "licence key stored in $KEYFILE (change it later in Settings → Outputs)"
    fi
    # The key file wins over secrets.env (same rule as the playout worker).
    KEYENV=""; [[ -s "$KEYFILE" ]] && KEYENV="STEREOTOOL_LICENSE_KEY=\"\$(cat '$KEYFILE')\" "
    # Load it once as the radio user: version, latency, preset and licence check.
    PROBE_CFG="$(jq -nc --arg lib "$LIB" --arg preset "$( [[ -f "$PRESET" ]] && echo "$PRESET" )" --arg home "$ROOT/var/stereotool" \
      '{library: $lib, preset: (if $preset == "" then null else $preset end), loadType: "totalinit", licenseKeyEnv: "STEREOTOOL_LICENSE_KEY", home: $home}')"
    if [[ $DRY -eq 0 ]]; then
      PROBE="$(as_radio "set -a && . '$SECRETS' && set +a && ${KEYENV}STEREOTOOL_HOST='$PROBE_CFG' node '$APP/apps/playout/bin/stereotool-host.mjs' --probe 2>&1" | grep '^@stereotool ' | sed 's/^@stereotool //' || true)"
      if [[ -n "$PROBE" ]]; then
        info "libStereoTool $(jq -r '.softwareVersion' <<<"$PROBE") (API $(jq -r '.apiVersion' <<<"$PROBE")), latency $(jq -r '.latencyMs' <<<"$PROBE") ms, licence valid: $(jq -r '.valid' <<<"$PROBE")"
        [[ "$(jq -r '.unlicensedFeatures' <<<"$PROBE")" == "" ]] || warn "unlicensed features in the preset: $(jq -r '.unlicensedFeatures' <<<"$PROBE") — pass --stereotool-key or set it in Settings → Outputs"
        if [[ -s "$KEYFILE" ]] || grep -q '^STEREOTOOL_LICENSE_KEY=.\+' "$SECRETS" 2>/dev/null; then EDITION=live; else EDITION=free; fi
        set_conf --arg e "$EDITION" '.stereotool.edition = $e'
      else
        warn "libStereoTool at $LIB could not be loaded or the preset failed (see: journalctl -u radio-playout$SUFFIX)"
      fi
    fi
  else
    BIN="$(jq -r .stereotool.binary "$CONF" 2>/dev/null || echo /opt/stereotool/stereotool_cmd)"
    if [[ -x "$BIN" ]]; then
      set_conf '.stereotool.inputMode = "stdio-pcm"'
      VERSION="$("$BIN" --version 2>&1 | head -1 || true)"
      info "found legacy $BIN: ${VERSION:-version unknown} (the plugin library is recommended — ADR 0002)"
      if [[ -f "$(jq -r .stereotool.license "$CONF")" ]] || grep -q '^STEREOTOOL_LICENSE_KEY=.\+' "$SECRETS" 2>/dev/null; then EDITION=live; else EDITION=free; fi
      set_conf --arg e "$EDITION" '.stereotool.edition = $e'
    else
      warn "no Stereo Tool installed ($LIB / $BIN): playout bypasses processing and raises a critical alert until it is (pass --stereotool Stereo_Tool_Generic_plugin.zip, or --stereotool-bypass)"
    fi
  fi
fi

step "Database (migrate + seed + bootstrap admin)"
as_radio "cd '$APP' && set -a && . '$SECRETS' && set +a && RADIO_CONFIG='$CONF' NODE_ENV=production corepack pnpm -s db:migrate \"\$(jq -r .db.file '$CONF')\" >/dev/null && RADIO_CONFIG='$CONF' NODE_ENV=production corepack pnpm -s db:seed >/dev/null"
info "database ready at $(jq -r .db.file "$CONF" 2>/dev/null)"

step "Icecast configuration"
as_radio "cd '$APP' && set -a && . '$SECRETS' && set +a && RADIO_CONFIG='$CONF' corepack pnpm -s icecast:config --out '$ROOT/var/icecast.xml'"
run install -o root -g icecast -m 640 "$ROOT/var/icecast.xml" "$ETC/icecast.xml"
run rm -f "$ROOT/var/icecast.xml"

step "systemd units"
for unit in radio-api.service radio-playout.service radio-icecast.service radio-backup.service radio-backup.timer; do
  target="/etc/systemd/system/${unit%.*}$SUFFIX.${unit##*.}"
  if [[ $DRY -eq 1 ]]; then echo "  + install $unit → $target"; continue; fi
  sed -e "s#/usr/bin/node #$(command -v node) #g" -e "s#__NODE_DIR__#$(dirname "$(readlink -f "$(command -v node)")")#g" -e "s#/srv/radio#$ROOT#g" -e "s#/etc/radio#$ETC#g" -e "s#radio-icecast.service#radio-icecast$SUFFIX.service#g" -e "s#radio-playout.service#radio-playout$SUFFIX.service#g" -e "s#/run/radio#/run/radio$SUFFIX#g" -e "s#RuntimeDirectory=radio#RuntimeDirectory=radio$SUFFIX#g" "$APP/deploy/systemd/$unit" >"$target"
done
if [[ $HAS_SYSTEMD -eq 1 ]]; then
  run systemctl daemon-reload
  run systemctl enable "radio-icecast$SUFFIX" "radio-playout$SUFFIX" "radio-api$SUFFIX" "radio-backup$SUFFIX.timer" >/dev/null
fi

step "nginx"
SITE="/etc/nginx/sites-available/radio$SUFFIX.conf"
if [[ $DRY -eq 0 ]]; then
  sed -e "s#__DOMAIN__#$DOMAIN#g" -e "s#__API_PORT__#$API_PORT#g" -e "s#__LIVE_PORT__#$LIVE_PORT#g" -e "s#__ICECAST_PORT__#$ICECAST_PORT#g" -e "s#/srv/radio#$ROOT#g" "$APP/deploy/nginx/radio.conf.template" >"$SITE"
  ln -sf "$SITE" "/etc/nginx/sites-enabled/radio$SUFFIX.conf"
  rm -f /etc/nginx/sites-enabled/default
  # Containers without IPv6 (common LXC setting) cannot bind [::]:80.
  [[ -s /proc/net/if_inet6 ]] || { sed -i '/listen \[::\]/d' "$SITE"; warn "no IPv6 in this container: nginx listens on IPv4 only"; }
  nginx -t
fi
if [[ $HAS_SYSTEMD -eq 1 ]]; then run systemctl reload nginx || run systemctl restart nginx; fi

if [[ $NO_START -eq 0 && $HAS_SYSTEMD -eq 1 ]]; then
  step "Start services"
  run systemctl restart "radio-icecast$SUFFIX"
  run systemctl restart "radio-playout$SUFFIX"
  run systemctl restart "radio-api$SUFFIX"
  run systemctl start "radio-backup$SUFFIX.timer"
  sleep 4
fi

if [[ $SKIP_CERTBOT -eq 0 && $DRY -eq 0 && $HAS_SYSTEMD -eq 1 ]]; then
  step "TLS (Let's Encrypt)"
  if [[ -z "$EMAIL" ]]; then warn "--email missing: skipping Certbot (run: certbot --nginx -d $DOMAIN)"; else
    certbot --nginx --non-interactive --agree-tos --redirect --hsts -m "$EMAIL" -d "$DOMAIN" || warn "Certbot failed (is DNS for $DOMAIN pointing here and port 80 reachable?)"
  fi
fi

if [[ $NO_START -eq 0 && $HAS_SYSTEMD -eq 1 && $DRY -eq 0 ]]; then
  step "Smoke test"
  API_URL="http://127.0.0.1:$API_PORT" ICECAST_URL="http://127.0.0.1:$ICECAST_PORT" WEB_URL="http://127.0.0.1" "$APP/scripts/smoke-test.sh" || warn "smoke test reported problems (see above)"
fi

cat <<EOT

$(printf '\033[1;32m')Installed.$(printf '\033[0m')
  Control panel : https://$DOMAIN/admin   (user admin, password in $ETC/secrets.env until you change it)
  Listener page : https://$DOMAIN/listen
  Config        : $CONF   Secrets: $SECRETS
Next steps:
  1. Put music in $ROOT/media (folders: "PM 07", 80s, General, Nieuws, Jingles …), then Media → Scan folders.
  2. Put the news files at Nieuws/nieuws-heel-uur.mp3 and Nieuws/nieuws-half-uur.mp3.
  3. Replace $ROOT/media/Emergency/emergency-loop.mp3 with your own loop.
  4. Schedule → Generate day.   5. Settings → Alerts: add alert e-mail addresses; SMTP in $SECRETS.
EOT
