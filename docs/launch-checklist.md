# Launch checklist (M15.6)

Work through this on the production host. Tick each box, note who and when, and keep this file
(or a copy) as the sign-off record. Items marked **(host)** can only be done on the real LXC; the
software side of every item has been verified in CI and a clean container.

## Before launch day

- [ ] **Domain** — DNS `A`/`AAAA` for the station domain points at the host; ports 80/443 open.
- [ ] **TLS** — `install.sh` ran without `--skip-certbot` (or `certbot --nginx -d <domain>`
      afterwards); `curl -I https://<domain>/listen` shows a valid certificate and the HSTS header;
      `systemctl list-timers | grep certbot` shows the renewal timer.
- [ ] **Icecast passwords** — `ICECAST_SOURCE_PASSWORD`, `ICECAST_ADMIN_PASSWORD`,
      `ICECAST_LIVE_PASSWORD` in `/etc/radio/secrets.env` are the generated random values (not
      `hackme`); `secrets.env` is mode 600 owned by `radio`; `curl -s -o /dev/null -w '%{http_code}'
https://<domain>/stream/admin/` returns 404.
- [ ] **Admin account** — first-login password changed; TOTP enabled for every admin; recovery
      codes stored offline; personal accounts created for each operator/DJ (no shared logins).
- [ ] **Stereo Tool (host)** — licensed `stereotool_cmd` in `/opt/stereotool`, preset in place,
      `stereotool.args` confirmed by hand (install.md §4); _Dashboard_ shows Stereo Tool
      **running**, not bypassed; ADR 0002 updated with the confirmed command and measured
      latency/CPU.
- [ ] **Media scan** — library linked/copied; _Media library → Scan library_ finished with few or
      no errors; loudness backfill done (`pnpm media:scan --analyze` or wait for the background
      job); each `[PM] HH:00` playlist, `General`, `Jingles` and `Nieuws` has content.
- [ ] **News files** — the hourly and half-hourly news files exist at the paths in the generator
      settings and play (preview in _Media_).
- [ ] **First 24 h plans** — _Schedule → Generate_ for today and tomorrow; no `generator_gap`
      alert; the plan view shows full hours with news at :00 and :30.
- [ ] **Emergency loop** — the placeholder beep replaced with the station's own loop at
      `media/Emergency/emergency-loop.mp3`; test: _Playout → Emergency_ plays it, clearing returns
      to automation.
- [ ] **Monitoring** — Prometheus scrapes `/metrics` from the host; Grafana dashboard imported;
      external uptime check on `https://<domain>/api/health` and on a stream URL.
- [ ] **Alert channels** — SMTP configured (`SMTP_*` in `secrets.env`), recipients set in
      _Settings → Alerts_, webhook(s) configured; _Send test alert_ arrives on every channel.
- [ ] **Backup schedule** — `systemctl list-timers | grep radio-backup` shows the 03:15 run; one
      manual backup taken (`scripts/backup.sh`); media, `/etc/radio` and `/opt/stereotool` are in
      the host/NAS backup.
- [ ] **Restore drill (host)** — `scripts/restore.sh <latest backup> --yes` on the production host
      (or staging copy) brings the station back; record the RTO here: \_\_\_\_ s.
      (Container drill: 19.5 s.)
- [ ] **Reboot test (host)** — `reboot`; afterwards `systemctl --failed` is empty and the smoke
      test passes.
- [ ] **24 h soak (host)** — run on air (or on staging) for 24 h: no restarts in
      `journalctl -u radio-playout`, worker RSS stable (`systemctl status radio-playout`), CPU
      under 50 % of 2 vCPU with the real Stereo Tool, boundary deviations within tolerance in the
      boundary log. Record CPU \_\_\_\_ %, RSS start/end \_\_\_\_ / \_\_\_\_ MB.
- [ ] **Browsers** — `/listen` plays on desktop Chrome, Firefox, Safari (HLS or MP3) and on a
      phone over mobile data.
- [ ] **Licences** — broadcast/performance licences for the music are in place (e.g.
      BUMA/STEMRA + SENA); Stereo Tool edition matches the use (see `NOTICE`).

## Launch

- [ ] `sudo /srv/radio/app/scripts/smoke-test.sh` exits 0.
- [ ] `curl -s localhost:3001/api/ready | jq .status` is `"ready"`.
- [ ] Listen on the public URL for the first news join; the boundary log shows it within tolerance.
- [ ] Public page, request form and partner API keys announced.

## Sign-off

| Role               | Name | Date | Signature |
| ------------------ | ---- | ---- | --------- |
| Station owner      |      |      |           |
| Technical operator |      |      |           |
