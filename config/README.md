# Configuration

- `station.example.json` — documented configuration shape. Copy to `station.json` (git-ignored) and edit.
- `icecast.dev.xml` — local development Icecast config.
- `icecast.xml.example` — production Icecast sketch; `install.sh` generates the real file (M13).
- `nginx.example.conf` — production reverse-proxy sketch (M13).

## Secrets

Do not put passwords in these files. Use `.env` for development or `/etc/radio/secrets.env`
(chmod 600) in production:

```bash
ICECAST_SOURCE_PASSWORD=...
ICECAST_ADMIN_PASSWORD=...
SESSION_SECRET=...
SMTP_PASSWORD=...
```

## Thimeo Stereo Tool

Thimeo Stereo Tool is commercial software. This repository does **not** include:

- the `stereotool_cmd` binary,
- `.sds` presets,
- `.lic` license files.

Point `stereotool.binary`, `stereotool.preset` and `stereotool.license` at your licensed
installation. The installer detects the edition and validates the preset at install time.
