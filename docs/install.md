# Install, upgrade and uninstall

Target: a clean **Debian 13** LXC container or VM with **2 vCPU, 2 GB RAM** and room for the
media library (or a NAS mount). One script does everything; re-running it is safe.

## 1. Prepare the host

**Proxmox LXC (recommended).** Create an unprivileged Debian 13 container: 2 cores, **3072 MB RAM**
(Stereo Tool's library alone takes about 675 MB; 2048 MB works but leaves little headroom),
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

- **Thimeo Stereo Tool**: the generic plugin download
  [`Stereo_Tool_Generic_plugin.zip`](https://download.thimeo.com/Stereo_Tool_Generic_plugin.zip)
  as-is (the same library Liquidsoap and AzuraCast use), your licence key, and your station preset
  (`.sts`, exported from Stereo Tool). Commercial software: never commit it. The legacy
  `stereotool_cmd` binary still works (pass its directory instead).
- Your **media library** directory (or NAS mount path).
- An **emergency loop** audio file (played on silence/failure). A placeholder beep is generated
  if you don't have one yet.

## 3. Install

```bash
sudo ./scripts/install.sh \
  --domain radio.example.com --email ops@example.com \
  --station-name "Harbour FM" \
  --stereotool /root/Stereo_Tool_Generic_plugin.zip --preset /root/harbour.sts \
  --media /mnt/nas-music --emergency /root/station-loop.mp3
```

What it does (each step is skipped if already done): preflight (OS, CPU, RAM, ports) → packages
(FFmpeg, Icecast 2, nginx, SQLite, Certbot) → Node.js 22 + pnpm → `radio` system user and
`/srv/radio/*` → code synced to `/srv/radio/app`, built → secrets in `/etc/radio/secrets.env`
(random passwords) → `/etc/radio/station.json` → media link and emergency loop → Stereo Tool library for this CPU
extracted to `/opt/stereotool` and test-loaded (version, latency, licence) → DB migrate + seed (24 hour playlists and slots) and
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

### Stereo Tool

The default is Thimeo's **generic plugin library** (`stereotool.inputMode: "plugin"`). The playout
worker starts a small host process (`apps/playout/bin/stereotool-host.mjs`) that loads
`stereotool.library` and processes the station's 48 kHz stereo PCM with the preset in
`stereotool.preset`. This is the same API Liquidsoap's `stereotool` operator uses (ADR 0002).

1. **Licence key:** pass it to the installer with `--stereotool-key KEY` (or `--stereotool-key
@key.txt` to keep it out of your shell history), or paste it later in _Settings → Outputs →
   Stereo Tool_, which restarts Stereo Tool with it at once. Both store it with mode 600 in
   `/srv/radio/var/stereotool/license.key`; that file wins over `STEREOTOOL_LICENSE_KEY` in
   `/etc/radio/secrets.env` (still supported). Without a valid key the library still runs but
   adds beeps/voice to the audio; the console then shows Stereo Tool as **unlicensed** and raises
   the `stereotool_unlicensed` alert.
2. **Preset:** export your preset from Stereo Tool as `.sts` and install it as
   `/etc/radio/stereotool.sts` (`--preset`, or copy it with mode 600 owned by `radio`).
   `stereotool.presetLoadType` picks which parts load (default `totalinit`, like Liquidsoap and
   AzuraCast; also `all_settings`, `audiofm`, `audio`, `processing`).
3. **Updating Stereo Tool:** re-run `sudo ./scripts/install.sh --stereotool <new zip>` (only that step
   changes anything) and `systemctl restart radio-playout`.
4. **Check it** by hand, as the `radio` user (on Windows, see "Testing your preset and key
   locally" below):

   ```bash
   sudo -u radio env STEREOTOOL_LICENSE_KEY=… \
     STEREOTOOL_HOST='{"library":"/opt/stereotool/libStereoTool_intel64.so","preset":"/etc/radio/stereotool.sts","licenseKeyEnv":"STEREOTOOL_LICENSE_KEY"}' \
     node /srv/radio/app/apps/playout/bin/stereotool-host.mjs --probe 2>&1 | grep @stereotool
   # @stereotool {"event":"ready","softwareVersion":11080,"apiVersion":256,"latencyMs":85,"loadType":20387,"valid":true,"unlicensedFeatures":""}
   ```

   The console (_Dashboard_, _Playout_) shows the mode (`plugin`), version and licence state.

If the library crashes or stalls (no output for 5 s), only the host process dies. The worker
restarts it with backoff and keeps the station on air unprocessed meanwhile (`bypassOnFailure`,
critical alert). While the host starts up, audio is also passed through unprocessed, so a restart
never adds delay to the stream.

#### Testing your preset and key locally (Windows)

The zip also contains the Windows build of the same library (`lib\Windows\64\libStereoTool_64.dll`),
and the plugin host runs on Windows too. So you can check a preset and licence key on a
workstation before any server exists. From the repository root, after `pnpm install`:

```powershell
$env:STEREOTOOL_LICENSE_KEY = Read-Host "Stereo Tool licence key" -MaskInput
$env:STEREOTOOL_HOST = @{ library = "C:\stereotool\libStereoTool_64.dll"; preset = "C:\stereotool\station.sts"; licenseKeyEnv = "STEREOTOOL_LICENSE_KEY"; home = "C:\stereotool\home" } | ConvertTo-Json -Compress
node apps\playout\bin\stereotool-host.mjs --probe 2>&1 | Select-String "@stereotool|error"
```

Look for a numeric `loadType` (the preset loaded), `"valid":true` and `"unlicensedFeatures":""`.
To listen, run a song through it with `--out` (never stdout: the library prints text there):

```powershell
ffmpeg -v error -y -i "C:\music\song.mp3" -ac 2 -ar 48000 -f s16le "$env:TEMP\st-in.raw"
cmd /c "node apps\playout\bin\stereotool-host.mjs --out %TEMP%\st-out.raw < %TEMP%\st-in.raw"
ffmpeg -v error -y -f s16le -ar 48000 -ac 2 -i "$env:TEMP\st-out.raw" "$env:USERPROFILE\Desktop\stereotool-test.wav"
```

**Legacy CLI.** With only `stereotool_cmd`, set `inputMode: "stdio-pcm"`; the worker then runs
`stereotool.binary` with `stereotool.args` (default `["-", "-", "-s", "{preset}"]`, placeholders
`{preset} {license} {licenseKey} {rate} {channels}`), optionally WAV-framed (`wavIo`).

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
