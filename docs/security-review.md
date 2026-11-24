# Security review (M15.1)

**Date:** 2026-11-22 · **Scope:** `main` at the M15 commit · **Result:** no open high/critical
findings; one accepted exception (below).

## Method

| Area                | How it was checked                                                                            | Result                                                                                                                                                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency audit    | `pnpm audit --audit-level high` (also a CI job)                                               | 0 unignored; 1 high ignored with mitigation (see exceptions)                                                                                                                                                                                        |
| Secrets in git      | `gitleaks detect` with `.gitleaks.toml` over the full history (also a CI job)                 | 18 commits, no leaks                                                                                                                                                                                                                                |
| Committed artefacts | `.gitignore` review                                                                           | Fixed: unanchored patterns had hidden source dirs (see F-1)                                                                                                                                                                                         |
| HTTP headers        | `deploy/nginx/radio.conf.template`, `apps/api/src/server.ts`                                  | CSP, nosniff, frame-options, referrer and permissions policy set                                                                                                                                                                                    |
| AuthN/session       | `apps/api/src/routes/auth.ts`, `services/auth.ts`, API tests                                  | argon2id, opaque tokens, HttpOnly + SameSite=Lax, CSRF double submit                                                                                                                                                                                |
| App tokens (mobile) | `services/device-auth.ts`, `/api/auth/token`, app-token API tests                             | Opaque `rat_`/`rrt_` tokens hashed at rest, 60 min access, rotating refresh with reuse detection (device revoked + alert), pairing codes single-use 10 min, per-user device cap, revoked on password change/reset/deactivation, rate-limited 10/min |
| RBAC                | `packages/shared/src/roles.ts` matrix vs every route guard (generated table in `docs/api.md`) | Every non-public route has a guard; RBAC matrix test passes                                                                                                                                                                                         |
| Uploads             | `routes/library.ts` upload + artwork routes, upload test                                      | Extension allow-list, magic-byte sniffing, random names, 500 MB cap                                                                                                                                                                                 |
| Rate limits         | route configs                                                                                 | Login 10/min, reset 5/15 min, public 60/min, requests 10/min                                                                                                                                                                                        |
| Proxy trust         | `trustProxy` setting                                                                          | Loopback only (fixed in M14: spoofed `X-Forwarded-For` bypassed limits)                                                                                                                                                                             |
| Icecast exposure    | Icecast bind address, nginx template                                                          | Fixed: `/stream/admin` was proxied publicly (see F-2)                                                                                                                                                                                               |
| Process isolation   | systemd units                                                                                 | `User=radio`, `NoNewPrivileges`, `ProtectSystem=full`, `PrivateTmp`                                                                                                                                                                                 |
| Vendor native code  | Stereo Tool plugin host (ADR 0002)                                                            | Proprietary library runs in its own child process; web/UECP bound to loopback; key via env, not argv                                                                                                                                                |
| Secrets at rest     | `install.sh`                                                                                  | `/etc/radio/secrets.env` 600 radio; Stereo Tool `.lic` 600                                                                                                                                                                                          |
| Logging             | alert/syslog paths, encoder/Stereo Tool stderr                                                | Icecast source password and Stereo Tool key redacted from process logs                                                                                                                                                                              |

## Findings

| ID  | Severity | Finding                                                                                                                                                                                                                                    | Status                                                                                                                                       |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | High     | `.gitignore` had unanchored `media/` and `stereotool*`, which silently excluded `apps/api/src/services/media/` and `apps/playout/src/stereotool/` from every commit. CI was red from the M4/M5 push on, and a fresh clone could not build. | **Fixed:** runtime dirs anchored (`/media/` …), Stereo Tool patterns narrowed to binaries/licences; the missing modules restored with tests. |
| F-2 | Medium   | nginx proxied `/stream/` to Icecast's root, so Icecast's web admin (`/stream/admin/…`, basic auth only) was reachable from the internet.                                                                                                   | **Fixed:** `location ^~ /stream/admin { return 404; }`. Use an SSH tunnel to reach the Icecast admin.                                        |
| F-3 | Medium   | `trustProxy: true` let any client spoof `X-Forwarded-For` and bypass login and request rate limits.                                                                                                                                        | **Fixed in M14:** trust loopback only (`TRUST_PROXY` to override).                                                                           |
| F-4 | Medium   | Tests and dev runs fell back to `/etc/radio/station.json` on a host with an installed station, so the test suite opened the production DB.                                                                                                 | **Fixed in M14:** the `/etc/radio` fallback applies only with `NODE_ENV=production`.                                                         |
| F-5 | Low      | HSTS is not sent until TLS is configured.                                                                                                                                                                                                  | **By design:** Certbot enables HSTS along with the certificate; the launch checklist covers it.                                              |
| F-6 | Low      | Session cookies get `Secure` only when the request arrived over HTTPS (dev runs over HTTP).                                                                                                                                                | **Accepted:** behind nginx with TLS every request is HTTPS (`X-Forwarded-Proto` from loopback).                                              |

## Accepted exceptions

### GHSA-mrhx-c7xc-m3w5 — zod 3 (high), ignored in `package.json` → `pnpm.auditConfig`

zod 3 keeps validating every element of an array after a `.max()` failure and records one issue
per failing element, so a large array can cost a lot of CPU and memory. The fix ships in zod 4,
whose API differs throughout the config schema and route validation.

**Mitigation (in place):** `parse()` in `apps/api/src/http.ts` rejects any array longer than
20 000 items before zod runs, the JSON body limit is 1 MiB, and returned validation details are
capped at 20. Covered by the API test "rejects oversized arrays before validation and caps
returned issues".

**Revisit:** when migrating to zod 4 (tracked as post-launch work); then remove the ignore.

## RBAC review

Roles and permissions live in `packages/shared/src/roles.ts`; every route's guard is listed in
the generated table in [`api.md`](./api.md). Summary:

- **Admin**: everything (users, API keys, settings, audit log, backups, triggers).
- **Operator**: playout control, media/playlists, schedule, requests, events, stats, alerts,
  recordings. No users, settings or API keys.
- **DJ**: playout control, live broadcast, request moderation, own shift reports, read-only
  media/schedule/stats/alerts. No settings, users, schedule edits or media edits.
- **Public** (no auth): health/readiness, `/api/public/*` (rate-limited, CORS), artwork, OpenAPI,
  and the app token endpoints `/api/auth/token` and `/api/auth/token/revoke`.
  `/api/public/stats` needs an API key with `public:stats`; `/api/triggers/:id` needs
  `triggers:fire`.

## Upload review

- Only the configured audio extensions are accepted; the first 16 bytes must match a known audio
  signature (MP3/ID3, FLAC, Ogg, WAV, MP4, ADTS). Disguised PHP and `.exe` files return 415
  (tested).
- Files are written under a random temporary name, then renamed to a sanitised name with a random
  suffix inside `media/Inbox`, outside any web root. They are only served back through the
  authenticated `/api/media/:id/preview` route with a fixed audio content type.
- Artwork uploads must be PNG, JPEG or WebP by magic bytes, max 10 MB.

## App tokens (added 2026-11-24)

The remote-control app API exposes the control API to phones over the internet, so it gets its
own controls:

- **Tokens:** two opaque tokens per device. The access token (`rat_`, 60 min) is checked on every
  request; the refresh token (`rrt_`, 90 days sliding) is rotated on each use. Both are only stored
  as SHA-256 hashes. A rotated refresh token that shows up again is treated as stolen: the device
  is revoked, the event is audited and the `app_token_reused` alert fires.
- **Permissions:** the user's role is checked on every request (RBAC unchanged; demotions apply
  immediately). Bearer requests are not cookie-based, so CSRF does not apply; a session cookie
  takes precedence when both are sent.
- **Sign-in:** the password grant shares the web login's checks (argon2id, dummy verify for
  unknown users, TOTP / recovery codes) and its rate limit (10/min/IP). Pairing codes (8 chars from
  a 31-symbol alphabet, about 8.5 × 10¹¹ combinations) are single-use, expire after 10 min and can
  only be minted from a web session, never by another device.
- **Revocation:** per device by the user or an admin, by the app itself, and automatically on
  password change/reset or account deactivation. Each user has at most 10 devices; the station can
  turn app access off entirely (`users.appTokens.enabled`), which invalidates all app tokens at
  once.
- **Residual:** an open WebSocket keeps running until it disconnects even after its token is
  revoked; reconnects need a valid token. Tokens are bearer secrets: the app must keep them in
  Keystore-backed storage (see mobile-app-api.md).

## Residual risks and recommendations

- Put the admin UI behind the VPN or an allow-list if the station has a fixed set of operators.
- Turn on TOTP for all admin accounts (the launch checklist requires it for admins).
- Point Prometheus at the host only (`/metrics` is denied by nginx for non-loopback clients and can
  also require `METRICS_TOKEN`).
- Re-run this review after any change to auth, uploads, nginx or the Stereo Tool adapter.
