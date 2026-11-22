# Install, upgrade and uninstall

Target: a clean **Debian 13** LXC container or VM with **2 vCPU, 2 GB RAM** and room for the
media library (or a NAS mount). One script does everything; re-running it is safe.

## 1. Prepare the host

**Proxmox LXC (recommended).** Create an unprivileged Debian 13 container: 2 cores, 2048 MB RAM,
512 MB swap, 16 GB root disk (+ media), `nesting=1` (systemd inside unprivileged containers needs
it). No extra devices are needed: the whole audio path is software (files → FFmpeg → Stereo Tool
→ FFmpeg → Icecast). ALSA/sound devices are **not** required.

- Optional line-in: pass the host's sound card through (`lxc.cgroup2.devices.allow: c 116:* rwm`
  and `lxc.mount.entry: /dev/snd dev/snd none bind,optional,create=dir`). Only needed for a
  physical studio input; browser studio and Icecast `/live` ingest need nothing.
- NAS media: mount the share on the Proxmox host and bind-mount it into the container
  (`mp0: /mnt/nas-music,mp=/mnt/nas-music,ro=1`), or mount NFS/SMB inside a privileged
  container. Make it readable by the container's `radio` user (uid mapping: host uid 100000 +
  container uid).
- Containers often have no IPv6; the installer detects that and makes nginx listen on IPv4 only.
- Resource limits: keep at least 2 cores. Measured chain cost is ~8 % of 2 vCPU with the
  passthrough Stereo Tool; the real Stereo Tool adds its own load (measure on your edition).

**VM / bare metal** works the same way.

Open ports 80 and 443 to the internet (DNS `A`/`AAAA` record for your domain pointing at the
host). Nothing else needs to be public: the API, worker and Icecast bind to `127.0.0.1`.

## 2. Get the code and your files

```bash
apt-get update && apt-get install -y git
git clone <your repository URL> ~/online-radio-player
cd ~/online-radio-player
```

Have ready (all optional; the installer works without them and tells you what's missing):

- **Thimeo Stereo Tool** for Linux: a directory with `stereotool_cmd` (and the `.lic` file if
  your edition uses one), plus your preset (`.sts`/`.sds`). Commercial software; never commit it.
- Your **media library** directory (or NAS mount path).
- An **emergency loop** audio file (played on silence/failure). A placeholder beep is generated
  if you don't have one yet.

## 3. Install

```bash
sudo ./scripts/install.sh \
  --domain radio.example.com --email ops@example.com \
  --station-name "Harbour FM" \
  --stereotool /root/stereotool --preset /root/harbour.sts \
  --media /mnt/nas-music --emergency /root/station-loop.mp3
```

What it does (each step is skipped if already done): preflight (OS, CPU, RAM, ports) → packages
(FFmpeg, Icecast 2, nginx, SQLite, Certbot) → Node.js 22 + pnpm → `radio` system user and
`/srv/radio/*` → code synced to `/srv/radio/app`, built → secrets in `/etc/radio/secrets.env`
(random passwords) → `/etc/radio/station.json` → media link and emergency loop → Stereo Tool to
`/opt/stereotool` with edition detection → DB migrate + seed (24 hour playlists and slots) and
the first admin → Icecast config → systemd units → nginx site with security headers → start →
Let's Encrypt (unless `--skip-certbot`) → smoke test.

**The first admin password is printed once** at the end of the secrets step (also stored in
`secrets.env` as `ADMIN_PASSWORD`). Sign in at `https://<domain>/admin` and change it.

Useful flags: `--skip-certbot` (no TLS yet, e.g. no DNS), `--stereotool-bypass` (run without
Stereo Tool), `--staging` (separate ports/paths, see below), `--no-start`, `--dry-run`
(print every step without changing anything). `--help` lists them all.

Measured: a fresh install in a clean Debian container took 30 s with packages cached; expect a
few minutes on a real host (package downloads, the build). Budget: < 30 minutes.

### Check it

```bash
systemctl --failed                     # empty
curl -s localhost:3001/api/ready | jq  # "ready" (or "degraded" with a reason)
sudo /srv/radio/app/scripts/smoke-test.sh
```

Then reboot once (`reboot`) and run the same checks: all units are enabled and start in order
(Icecast → playout → API).

## 4. Configure

- `/etc/radio/station.json` — station name/domain/timezone, mounts, Stereo Tool paths and
  arguments, media roots, generator settings. Validate after editing:
  `cd /srv/radio/app && sudo -u radio corepack pnpm -s config:validate /etc/radio/station.json`.
  Mount changes need `corepack pnpm icecast:config` and a restart of `radio-icecast` and
  `radio-playout`.
- `/etc/radio/secrets.env` — passwords and tokens, plus optional `SMTP_HOST`/`SMTP_USER`/
  `SMTP_PASSWORD`/`SMTP_FROM`, webhook URLs (the env names you referenced in `webhooks.alerts`),
  `SYSLOG_HOST`, `METRICS_TOKEN`, `STEREOTOOL_LICENSE_KEY`. Restart the services after changes.
- Everything operational (branding, ducking, request rules, retention, alert recipients) is in
  the web UI under _Settings_.

### Stereo Tool command line

The adapter runs `stereotool.binary` with `stereotool.args`, feeding 48 kHz/16-bit stereo PCM
(wrapped in a streaming WAV header when `wavIo` is true) on stdin and reading processed audio
from stdout. Default arguments are `["-", "-", "-s", "{preset}"]`; placeholders `{preset}`,
`{license}`, `{licenseKey}`, `{rate}`, `{channels}` are filled in. **Confirm the arguments against
your licensed binary** (ADR 0002 / M0.5) — run it by hand first:

```bash
ffmpeg -v error -f lavfi -i "sine=f=440:d=5" -ac 2 -ar 48000 -f wav - \
  | /opt/stereotool/stereotool_cmd - - -s /etc/radio/stereotool.sds \
  | ffprobe -v error -show_entries stream=codec_name,sample_rate,channels -
```

If Stereo Tool exits or stalls (no output for 5 s), the worker restarts it with backoff and keeps
the station on air unprocessed meanwhile (`bypassOnFailure`, critical alert).

## 5. Staging

`sudo ./scripts/install.sh --staging --domain staging.radio.example.com --skip-certbot
--stereotool-bypass` installs a second, independent station on the same host: units
`radio-*-staging`, API 3002, worker 3201, Icecast 8002, data `/srv/radio-staging`, config
`/etc/radio-staging`. It never touches production data. Upgrade it first with
`sudo ./scripts/upgrade.sh --staging`, run the smoke test, then upgrade production.

## 6. Upgrade

```bash
cd ~/online-radio-player && git pull        # or check out a release tag
sudo ./scripts/upgrade.sh                   # or: --ref v1.2.0
```

Order: DB backup → sync code → install deps + build → migrate → restart → smoke test. Media,
config, secrets and data are never touched. **Rollback:** `sudo ./scripts/upgrade.sh --ref
<previous tag>`; if the new migration changed data, restore the backup the upgrade printed
(`sudo /srv/radio/app/scripts/restore.sh <file> --yes`).

## 7. Uninstall

```bash
sudo ./scripts/uninstall.sh            # stop + remove units and the nginx site; data stays
sudo ./scripts/uninstall.sh --purge    # also delete /srv/radio, /etc/radio and the radio user
```

`--purge` deletes the database, recordings and backups. Take what you need first.

## Development setup (Windows/macOS/Linux)

```bash
pnpm install
cp .env.example .env
pnpm dev            # API :3001, worker, Vite :5173 (mock Stereo Tool, tone source)
pnpm demo           # self-contained stack with fixtures, Icecast (if installed), seeded users
```

Icecast for development: `docker compose -f docker-compose.dev.yml up`. The real Stereo Tool is
Linux-only; dev and CI use `scripts/mock-stereotool.mjs` (PCM passthrough).
