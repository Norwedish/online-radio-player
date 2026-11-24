# Operations runbook

For the on-call person keeping the station on air. Installing and upgrading are in
[install.md](./install.md); day-to-day use of the console is in [admin-guide.md](./admin-guide.md).

## The system at a glance

| Component      | systemd unit                                                                          | Listens on                                         | Logs                                                        |
| -------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| API + web UI   | `radio-api`                                                                           | `127.0.0.1:3001`                                   | `journalctl -u radio-api`                                   |
| Playout worker | `radio-playout`                                                                       | `127.0.0.1:3101` (protocol), `:3102` (live uplink) | `journalctl -u radio-playout`                               |
| Stereo Tool    | plugin host (`stereotool-host.mjs` loading `libStereoTool`), child of `radio-playout` | stdin/stdout pipes                                 | in the `radio-playout` journal, prefixed `stereotool`       |
| Encoders       | FFmpeg children of `radio-playout`                                                    | → Icecast                                          | in the `radio-playout` journal, prefixed `encoder <mount>:` |
| Icecast        | `radio-icecast`                                                                       | `127.0.0.1:8000`                                   | `/var/log/radio-icecast/`                                   |
| nginx          | `nginx`                                                                               | `:80`, `:443`                                      | `/var/log/nginx/`                                           |
| Backups        | `radio-backup.timer` → `.service`                                                     | daily 03:15                                        | `journalctl -u radio-backup`                                |

Staging (`install.sh --staging`) uses `-staging` unit names, API `3002`, worker `3201`, Icecast
`8002`, data in `/srv/radio-staging` and config in `/etc/radio-staging`.

Paths: data `/srv/radio` (`media/`, `backups/`, `recordings/`, `hls/`, `artwork/`, `logs/`,
`var/radio.sqlite`), config `/etc/radio/station.json`, secrets `/etc/radio/secrets.env` (mode 600),
code `/srv/radio/app` (synced from your source checkout by `install.sh`/`upgrade.sh`), Stereo Tool `/opt/stereotool`.

## Is it on air? (60-second check)

```bash
systemctl --failed                                   # should be empty
systemctl status radio-api radio-playout radio-icecast --no-pager
curl -s localhost:3001/api/ready | jq                # status ready|degraded|not_ready + checks
sudo /srv/radio/app/scripts/smoke-test.sh                # health, every mount audible, API, UI, HLS
```

`/api/ready` returns 503 only when the database or the worker is down. `degraded` means the
station is serving but something in `checks` is red (Icecast, Stereo Tool, an encoder,
emergency mode) — read the `detail` field.

## Alerts and what to do

Alerts appear in the console (bell icon / _Alerts_), by email (error and above, when SMTP is
configured), on configured webhooks and in syslog (`radio-player` tag). The same alert type is
throttled for `alerts.dedupeSeconds` (default 300 s) unless it gets more severe. Acknowledge in
the UI once someone is on it.

| Alert type                         | Meaning                                                                                                           | Action                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `silence`, `emergency_manual`      | Output below the silence threshold for `audio.silenceSeconds` → emergency loop (or an operator pressed Emergency) | Check _Playout_: is the queue empty, a file missing, the worker paused? Clear emergency from the console once a track plays. Check the generator (`generator_gap`) and media status. |
| `emergency_file_missing`           | The emergency loop file is missing — silence would stay silent                                                    | Put a file at `audio.emergencyFile` (default `media/Emergency/emergency-loop.mp3`).                                                                                                  |
| `worker_down`                      | The API lost the playout worker (heartbeat > 15 s)                                                                | `systemctl status radio-playout`; `journalctl -u radio-playout -n 100`. systemd restarts it; see "Worker won't start".                                                               |
| `deck_error`                       | A track could not be decoded; it was skipped                                                                      | Check the file in _Media_ (status `error`) and replace it.                                                                                                                           |
| `icecast_down`                     | The API cannot poll Icecast stats                                                                                 | Same as below; listener stats pause until it is back.                                                                                                                                |
| `icecast_source_loss`              | All mounts down for 15 s                                                                                          | `systemctl status radio-icecast`; `journalctl -u radio-icecast`; restart it. Encoders reconnect on their own (`icecast_source_restored` follows).                                    |
| `encoder_failure`                  | One encoder keeps exiting                                                                                         | `journalctl -u radio-playout \| grep 'encoder <mount>'`. Usually Icecast refused the source (password, mount limit) or the codec is missing from FFmpeg.                             |
| `encoder_queue_overflow`           | An encoder can't keep up; oldest audio dropped                                                                    | CPU starved or Icecast slow. `top`; consider fewer/lower-bitrate mounts.                                                                                                             |
| `stereotool_bypass`                | Stereo Tool died; audio is on air **unprocessed** while it restarts                                               | Look for `stereotool:` lines in the playout journal (license, preset path, crash). It restarts with backoff automatically.                                                           |
| `stereotool_unlicensed`            | The licence key does not cover the preset; the library mixes beeps/voice into the audio                           | Set or fix `STEREOTOOL_LICENSE_KEY` in `secrets.env` (or simplify the preset), then restart `radio-playout`. The alert lists the unlicensed features.                                |
| `stereotool_failed`                | Restart attempts exhausted; stays bypassed                                                                        | Fix the cause, then `systemctl restart radio-playout` (about 2 s of silence).                                                                                                        |
| `stereotool_missing`               | The plugin library (`stereotool.library`) or, in legacy mode, `stereotool_cmd` is missing                         | `sudo ./scripts/install.sh --stereotool Stereo_Tool_Generic_plugin.zip` (install.md), or set `stereotool.enabled: false` to run unprocessed on purpose.                              |
| `generator_failed`, `plan_missing` | The generator errored, or the worker found no plan for the current hour                                           | Automation falls back to the hour's playlist. _Schedule → Generate_ and read the run log under _Schedule → Runs_.                                                                    |
| `generator_gap`                    | Upcoming hours have no plan                                                                                       | _Schedule → Generate_; check the playlists of those hours have enough music, or turn on fallback mode.                                                                               |
| `news_missing`                     | A news file can't be read                                                                                         | Check the file under `media/Nieuws/` (name per generator settings) and the NAS mount.                                                                                                |
| `app_token_reused`                 | A remote-control app presented an already-used refresh token (likely copied); that device was signed out          | Ask the user whether they reinstalled/restored the app. If not, change their password (signs all their devices out) and check the audit log (`auth.token_reuse_detected`, IP).       |
| `listener_drop`                    | Listener count fell sharply                                                                                       | Check the public stream from outside (`curl -I https://<domain>/stream/hq.mp3`), nginx and TLS.                                                                                      |
| `live_no_show`                     | A booked live slot started without a DJ                                                                           | Automation keeps playing; contact the DJ or cancel the booking.                                                                                                                      |
| `disk_low`                         | Free space below `backups.minFreeDiskB`                                                                           | `df -h /srv/radio`; prune `recordings/`, old backups, or grow the disk.                                                                                                              |
| `backup_failed`                    | Nightly backup failed                                                                                             | `journalctl -u radio-backup`; run `sudo /srv/radio/app/scripts/backup.sh` by hand.                                                                                                   |

Send a test alert through every channel from _Settings → Alerts → Send test alert_
(`POST /api/alerts/test`).

## Common procedures

**Restart a service.** `sudo systemctl restart radio-api` is invisible to listeners (the worker
keeps playing; consoles reconnect). Restarting `radio-playout` or `radio-icecast` drops listeners
for a few seconds; do it at the top of a news bulletin if you can.

**Worker won't start.** `journalctl -u radio-playout -n 100`. Common causes: invalid
`/etc/radio/station.json` (validate with
`cd /srv/radio/app && sudo -u radio corepack pnpm -s config:validate /etc/radio/station.json`),
missing emergency file, unwritable `/srv/radio`, or port 3101 in use.

**Icecast admin.** It is bound to loopback and deliberately not proxied. Tunnel to it:
`ssh -L 8000:127.0.0.1:8000 <host>` → <http://127.0.0.1:8000/admin/> (user `admin`, password
`ICECAST_ADMIN_PASSWORD` in `secrets.env`).

**Regenerate Icecast config** after changing mounts in `station.json`:
`cd /srv/radio/app && sudo -u radio corepack pnpm icecast:config` then
`sudo systemctl restart radio-icecast radio-playout`.

**Rescan the library.** _Media → Scan library_, or
`cd /srv/radio/app && sudo -u radio corepack pnpm media:scan --analyze`.

**Rotate a secret.** Edit `/etc/radio/secrets.env`, regenerate the Icecast config if it was an
Icecast password, then restart `radio-icecast`, `radio-playout` and `radio-api`.

**Reset a forgotten admin password.**
`cd /srv/radio/app && sudo -u radio corepack pnpm user:password --username admin` (prints a generated password).

## Backup and restore

- Nightly at 03:15 (`radio-backup.timer`): SQLite online backup with integrity check into
  `/srv/radio/backups`, keeping 14 daily and 8 weekly copies. `upgrade.sh` also backs up first.
- On demand: `sudo /srv/radio/app/scripts/backup.sh` or _Settings → Backups → Back up now_.
- Media, config and secrets are **not** in the DB backup: back up `/srv/radio/media` (or the NAS),
  `/etc/radio` and `/opt/stereotool` with your host/NAS backup.

Restore (stops API + worker, verifies the file, keeps a safety copy of the current DB, restarts,
runs the smoke test):

```bash
ls -lt /srv/radio/backups | head
sudo /srv/radio/app/scripts/restore.sh /srv/radio/backups/<file>.sqlite3 --yes
```

**Drill result (M15.4, 2026-11-22):** live DB overwritten with garbage → `restore.sh` → audible on
all mounts again in **19.5 s (RTO)**. **RPO** = time since the last backup (≤ 24 h, plus the
pre-upgrade backup). The broken DB was kept as a safety copy.

## Retention

Runs in the API every 6 h (first run a minute after start), configurable under
_Settings → Retention_: play history 90 days, logs 30, requests 30, live recordings 30. Each run
logs what it deleted. Run by hand: `cd /srv/radio/app && sudo -u radio corepack pnpm retention`.

## Upgrades and rollback

```bash
cd ~/online-radio-player && git pull   # your source checkout, or unpack a release
sudo ./scripts/upgrade.sh              # backup → sync → build → migrate → restart → smoke test
```

Rollback: `sudo ./scripts/upgrade.sh --ref <previous tag>` (source must be a git clone) and, if the
migration changed data, restore the backup the upgrade printed.

## Monitoring

Prometheus scrapes `http://127.0.0.1/metrics` on the host (`deploy/grafana/prometheus-scrape.yml`);
import `deploy/grafana/radio-dashboard.json` into Grafana. Useful series:
`radio_worker_connected`, `radio_encoder_up{mount}`, `radio_stereotool_up`,
`radio_stereotool_bypassed`, `radio_emergency_active`, `radio_listeners{mount}`,
`radio_boundary_last_deviation_ms`, `radio_alerts_active`, `radio_disk_free_bytes`.
Suggested alert rules: worker disconnected 1 min, any encoder down 2 min, emergency active,
bypassed Stereo Tool 5 min, disk free < 5 GB.

## Measured budgets (for spotting regressions)

| What                                              | Measured                                                  | Budget                         |
| ------------------------------------------------- | --------------------------------------------------------- | ------------------------------ |
| Whole audio chain CPU (mock ST)                   | 7.9 % of 2 vCPU, worker RSS 133 MB                        | < 50 % of 2 vCPU               |
| API under load (500 listeners, 200 WS, 100 req/s) | p95 6.8 ms, p99 12.6 ms, 0 errors, 10 % CPU, 136 MB       | p95 < 200 ms                   |
| Library scan                                      | 1 000 files in 2.97 s                                     | < 60 s                         |
| Stereo Tool plugin instance                       | ~675 MB RSS, 38 threads, 85 ms latency (default settings) | fits in 3 GB RAM with the rest |
| Restore RTO                                       | 19.5 s                                                    | —                              |
| Fresh install                                     | 30 s (container, packages cached)                         | < 30 min                       |

The 24-hour soak and real Stereo Tool CPU must be measured on the production LXC (see the launch
checklist).
