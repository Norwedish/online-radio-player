# API reference

The station exposes one HTTP API on the API process (default `127.0.0.1:3001`, published by nginx
under `https://<domain>/api/`). The machine-readable contract is the OpenAPI 3.1 document at
**`GET /api/docs`**; this page explains the conventions and lists every route with the permission
it requires. The tables below are generated from the route registrations in `apps/api/src/routes`.

## Conventions

**Authentication.** Browser users sign in with `POST /api/auth/login`
(`{ "login": "admin", "password": "…", "totp": "123456" }`; `totp` only when 2FA is on). The
response sets an HttpOnly session cookie and a readable `csrf` cookie and returns `{ csrf }`.
Every state-changing request with a session cookie must send the same value in the
`x-csrf-token` header.

**App tokens (mobile / remote-control apps).** A phone app signs in with
`POST /api/auth/token` (username + password, or a one-time pairing code from _Account → Connected
apps_), receives a short-lived bearer access token (`rat_…`, 60 min) and a rotating refresh token
(`rrt_…`, 90 days), and sends `Authorization: Bearer rat_…`. The request then acts as that user
with the user's role; there is no CSRF step (no cookies). The complete guide for app developers is
[mobile-app-api.md](./mobile-app-api.md).

**API keys.** Admins create keys under _Users → API keys_ (`POST /api/admin/api-keys`). The key
(`rk_…`) is shown once; send it as `x-api-key: rk_…` or `Authorization: Bearer rk_…`. Keys carry
scopes instead of a role:

| Scope             | Grants                                                          |
| ----------------- | --------------------------------------------------------------- |
| `read`            | Read-only playout state, queue and history                      |
| `playout:control` | Playout control endpoints (skip, pause, queue, play-now, …)     |
| `triggers:fire`   | `POST /api/triggers/:id` (MIDI / Stream Deck / home automation) |
| `public:stats`    | `GET /api/public/stats` (partner listener figures)              |

**Errors** always use one envelope with a stable `code`:

```json
{
  "error": {
    "code": "validation_error",
    "message": "…",
    "details": [{ "path": "title", "message": "…" }]
  }
}
```

Common codes: `unauthorized` (401), `invalid_token` (401, app token unknown/expired: refresh), `token_reused` (401, device signed out), `forbidden` (403), `not_found` (404), `conflict` (409),
`validation_error` (400, at most 20 details), `unsupported_type` (415), `too_large` (413),
`rate_limited` (429), `worker_unavailable` (503 when the playout worker is down).

**Rate limits** (per client IP; nginx is the only trusted proxy): login 10/min, password
forgot 5 per 15 min, password reset 10 per 15 min, playout control 120/min, public API 60/min,
public request submission 10/min (plus the station's own per-IP cooldown and hourly cap).

**Roles.** `admin` has every permission. `operator` and `dj` get the subsets in
`packages/shared/src/roles.ts`, summarised in [security-review.md](./security-review.md#rbac-review).

## Public API

No session needed; CORS is open (`Access-Control-Allow-Origin: *`).

```bash
curl -s https://radio.example.com/api/public/now-playing
curl -s 'https://radio.example.com/api/public/schedule?date=2026-11-23'
curl -s 'https://radio.example.com/api/public/history?limit=10'
curl -s 'https://radio.example.com/api/public/search?q=queen'
curl -s -X POST https://radio.example.com/api/public/requests \
  -H 'content-type: application/json' \
  -d '{"mediaId": 42, "displayName": "Sam", "message": "For the night shift!"}'
curl -s https://radio.example.com/api/public/requests/17          # status: pending|approved|played|rejected
curl -s -H 'x-api-key: rk_…' https://radio.example.com/api/public/stats
```

A request either names a library track (`mediaId`, from `/api/public/search`) or gives free-text
`artist` + `title`, which goes to moderation. Optional fields: `displayName`, `contact`, `message`, `dedication`; the `website` field is a honeypot and must stay empty.
Profanity filtering, blacklist patterns, per-IP cooldown and the hourly cap apply.

Streams are plain HTTP under `/stream/<mount>` (e.g. `/stream/hq.mp3`, `/stream/mobile.mp3`,
`/stream/opus.ogg`, `/stream/aac.aac`) and HLS under `/hls/stream.m3u8` when HLS is enabled; the
`now-playing` response lists the configured mounts under `streams.mounts`.

## WebSocket

`GET /ws` (same origin; the session cookie authenticates). The server first sends
`{ "type": "hello", "data": { "authenticated": true, "channels": [...], "workerConnected": true } }`
and, for signed-in users, the full `playout:state`. Events then arrive as `{ "type", "data" }`.

- Channels: `playout`, `live`, `alerts`, `requests` (needs `requests:moderate`), `stats`, `media`.
  Narrow them with `{ "type": "subscribe", "channels": ["playout", "alerts"] }`.
- Keep-alive: send `{ "type": "ping" }`, receive `pong`.
- Apps authenticate the socket with the same `Authorization: Bearer rat_…` header on the
  handshake.
- Anonymous sockets only receive `public:now-playing` (title/artist; news shows as "News").
- Typical events: `playout:state`, `playout:now-playing`, `playout:track-started`, `meter`,
  `encoder:status`, `stereotool:status`, `alerts:new`, `alerts:resolved`, `requests:new`,
  `requests:updated`, `media:imported`, `media:scan-done`, `plans:changed`.

`/ws/live` is the browser live studio's PCM uplink (ADR 0004); it needs `live:broadcast`.

## Health and monitoring

- `GET /api/health` — liveness; 200 while the API process runs.
- `GET /api/ready` — 200 when the database and the playout worker (heartbeat < 15 s) are OK,
  otherwise 503. Icecast, Stereo Tool, encoders and emergency mode are reported in `checks`;
  any of them failing makes `status` `"degraded"` without failing readiness.
- `GET /metrics` — Prometheus text format; nginx only allows loopback, and `METRICS_TOKEN`
  (if set) must be sent as `Authorization: Bearer …`. A Grafana dashboard and scrape example
  live in `deploy/grafana/`.

## Endpoints

### Public API (no session)

| Method | Path                       | Permission             | Purpose                                         |
| ------ | -------------------------- | ---------------------- | ----------------------------------------------- |
| GET    | `/api/public/now-playing`  | `public`               | Now playing, next up, listeners, streams        |
| GET    | `/api/public/schedule`     | `public`               | Public 24h schedule (planned times)             |
| GET    | `/api/public/history`      | `public`               | Recently played                                 |
| GET    | `/api/public/search`       | `public`               | Library search for requests (artist/title only) |
| POST   | `/api/public/requests`     | `public`               | Submit a song request                           |
| GET    | `/api/public/requests/:id` | `public`               | Request status                                  |
| GET    | `/api/public/stats`        | API key `public:stats` | Partner stats (API key scope public:stats)      |

### System

| Method | Path          | Permission                 | Purpose                                               |
| ------ | ------------- | -------------------------- | ----------------------------------------------------- |
| GET    | `/api/health` | `public`                   | Liveness                                              |
| GET    | `/api/ready`  | `public`                   | Readiness: DB, worker, Icecast, Stereo Tool, encoders |
| GET    | `/metrics`    | loopback / `METRICS_TOKEN` | Prometheus metrics                                    |
| GET    | `/api/docs`   | `public`                   | OpenAPI document                                      |

### Authentication, users, API keys, audit

| Method | Path                        | Permission              | Purpose                                                                    |
| ------ | --------------------------- | ----------------------- | -------------------------------------------------------------------------- |
| POST   | `/api/auth/login`           | `public`                | Login (username/email + password, optional TOTP)                           |
| POST   | `/api/auth/logout`          | signed in               | Revoke the current session                                                 |
| POST   | `/api/auth/logout-all`      | signed in               | Revoke all other sessions                                                  |
| GET    | `/api/auth/me`              | signed in               | Current user                                                               |
| GET    | `/api/auth/sessions`        | signed in               | My active sessions                                                         |
| POST   | `/api/auth/password/change` | signed in               | Change my password                                                         |
| POST   | `/api/auth/password/forgot` | `public`                | Request a reset email                                                      |
| POST   | `/api/auth/password/reset`  | `public`                | Reset password with a token                                                |
| POST   | `/api/auth/2fa/setup`       | signed in               | Start TOTP setup                                                           |
| POST   | `/api/auth/2fa/enable`      | signed in               | Confirm TOTP                                                               |
| POST   | `/api/auth/2fa/disable`     | signed in               | Disable TOTP                                                               |
| POST   | `/api/auth/token`           | `public`                | App sign-in / refresh: `password`, `pairing_code` or `refresh_token` grant |
| POST   | `/api/auth/token/revoke`    | `public`                | App sign-out (bearer, or `refreshToken` in the body)                       |
| GET    | `/api/auth/devices`         | signed in               | My connected app devices                                                   |
| POST   | `/api/auth/devices/pair`    | signed in (web session) | Create a one-time pairing code + QR payload                                |
| DELETE | `/api/auth/devices/:id`     | signed in               | Sign out an app device (own; admins: any)                                  |
| GET    | `/api/admin/users`          | `users:manage`          | List users                                                                 |
| POST   | `/api/admin/users`          | `users:manage`          | Create user                                                                |
| PATCH  | `/api/admin/users/:id`      | `users:manage`          | Update user (role, email, active, password)                                |
| DELETE | `/api/admin/users/:id`      | `users:manage`          | Deactivate user                                                            |
| GET    | `/api/admin/api-keys`       | `apikeys:manage`        | List API keys                                                              |
| POST   | `/api/admin/api-keys`       | `apikeys:manage`        | Create API key (shown once)                                                |
| DELETE | `/api/admin/api-keys/:id`   | `apikeys:manage`        | Revoke API key                                                             |
| GET    | `/api/admin/audit`          | `audit:view`            | Audit log (filterable)                                                     |
| GET    | `/api/admin/devices`        | `users:manage`          | All connected app devices                                                  |

### Playout, live studio, events, triggers

| Method | Path                        | Permission              | Purpose                                          |
| ------ | --------------------------- | ----------------------- | ------------------------------------------------ |
| GET    | `/api/playout/state`        | `playout:view`          | Full playout state                               |
| POST   | `/api/playout/skip`         | `playout:control`       | Skip current                                     |
| POST   | `/api/playout/pause`        | `playout:control`       | Pause output                                     |
| POST   | `/api/playout/resume`       | `playout:control`       | Resume output                                    |
| POST   | `/api/playout/stop`         | `playout:control`       | Stop automation                                  |
| POST   | `/api/playout/play`         | `playout:control`       | Start automation                                 |
| POST   | `/api/playout/replay-last`  | `playout:control`       | Replay last track                                |
| POST   | `/api/playout/seek`         | `playout:control`       | Seek current                                     |
| GET    | `/api/playout/queue`        | `playout:view`          | Upcoming queue                                   |
| POST   | `/api/playout/queue/move`   | `playout:control`       | Reorder queue                                    |
| DELETE | `/api/playout/queue/:uid`   | `playout:control`       | Remove queue item                                |
| POST   | `/api/playout/queue/insert` | `playout:control`       | Insert media into the queue                      |
| POST   | `/api/playout/queue/jump`   | `playout:control`       | Jump to a queued item                            |
| POST   | `/api/playout/play-now`     | `playout:control`       | Interrupt / play-now (stinger, ad, jingle, news) |
| POST   | `/api/playout/voice-over`   | `playout:control`       | Play a voice-over over the music (ducked)        |
| PATCH  | `/api/playout/fader`        | `playout:control`       | Master fader (0–1.5)                             |
| POST   | `/api/playout/monitor`      | `playout:control`       | Monitor on/off                                   |
| POST   | `/api/playout/emergency`    | `playout:control`       | Trigger or clear emergency mode                  |
| GET    | `/api/playout/history`      | `playout:view`          | Recently played                                  |
| POST   | `/api/live/start`           | `live:broadcast`        | Start a live session                             |
| POST   | `/api/live/stop`            | `live:broadcast`        | Stop the live session                            |
| POST   | `/api/live/mode`            | `live:broadcast`        | Switch duck/takeover                             |
| POST   | `/api/live/gain`            | `live:broadcast`        | Live input gain (dB)                             |
| GET    | `/api/live/status`          | `playout:view`          | Live status                                      |
| GET    | `/api/live/recordings`      | `recordings:manage`     | List recordings                                  |
| GET    | `/api/live/recordings/:id`  | `recordings:manage`     | Download a recording                             |
| DELETE | `/api/live/recordings/:id`  | `recordings:manage`     | Delete a recording                               |
| GET    | `/api/live/sessions`        | `stats:view`            | DJ shift reports (own sessions for DJs)          |
| GET    | `/api/events`               | `schedule:view`         | List events                                      |
| POST   | `/api/events`               | `events:manage`         | Create event                                     |
| PATCH  | `/api/events/:id`           | `events:manage`         | Update event                                     |
| DELETE | `/api/events/:id`           | `events:manage`         | Delete a non-active event                        |
| POST   | `/api/events/:id/start`     | `events:manage`         | Start event now                                  |
| POST   | `/api/events/:id/stop`      | `events:manage`         | Stop event                                       |
| GET    | `/api/admin/triggers`       | `settings:manage`       | List trigger mappings                            |
| PUT    | `/api/admin/triggers`       | `settings:manage`       | Replace trigger mappings                         |
| POST   | `/api/triggers/:id`         | API key `triggers:fire` | Fire a trigger (API key scope triggers:fire)     |

### Media library and playlists

| Method | Path                                | Permission         | Purpose                                                       |
| ------ | ----------------------------------- | ------------------ | ------------------------------------------------------------- |
| GET    | `/api/media`                        | `media:view`       | Search/filter media                                           |
| GET    | `/api/media/stats`                  | `media:view`       | Library counts by status                                      |
| GET    | `/api/media/duplicates`             | `media:view`       | Duplicate groups                                              |
| POST   | `/api/media/duplicates/merge`       | `media:manage`     | Merge a duplicate group                                       |
| POST   | `/api/media/duplicates/ignore`      | `media:manage`     | Ignore a duplicate group                                      |
| POST   | `/api/media/import`                 | `media:manage`     | Start a folder scan                                           |
| POST   | `/api/media/upload`                 | `media:manage`     | Multipart upload into media/Inbox                             |
| GET    | `/api/media/suggestions`            | `media:view`       | Pending metadata suggestions                                  |
| POST   | `/api/media/suggestions/:id/apply`  | `media:manage`     | Apply a metadata suggestion                                   |
| POST   | `/api/media/suggestions/:id/reject` | `media:manage`     | Reject a metadata suggestion                                  |
| GET    | `/api/media/:id`                    | `media:view`       | Get media                                                     |
| PATCH  | `/api/media/:id`                    | `media:manage`     | Edit media (tags, cue/fade, gain, status)                     |
| PATCH  | `/api/media/:id/tags`               | `media:manage`     | Edit tags                                                     |
| DELETE | `/api/media/:id`                    | `media:manage`     | Delete media row (file untouched; disabled if it has history) |
| GET    | `/api/media/:id/artwork`            | `public`           | Artwork bytes (public, placeholder when absent)               |
| PUT    | `/api/media/:id/artwork`            | `media:manage`     | Replace artwork (multipart image)                             |
| GET    | `/api/media/:id/preview`            | `media:view`       | Stream the audio file (cue/next-track preview, M8.6)          |
| POST   | `/api/media/:id/analyze`            | `media:manage`     | Re-run loudness analysis                                      |
| POST   | `/api/media/:id/lookup`             | `media:manage`     | MusicBrainz lookup → suggestions                              |
| GET    | `/api/playlists`                    | `media:view`       | List playlists                                                |
| POST   | `/api/playlists`                    | `playlists:manage` | Create playlist                                               |
| GET    | `/api/playlists/:id`                | `media:view`       | Playlist with items                                           |
| PATCH  | `/api/playlists/:id`                | `playlists:manage` | Update playlist                                               |
| DELETE | `/api/playlists/:id`                | `playlists:manage` | Delete playlist                                               |
| PUT    | `/api/playlists/:id/items`          | `playlists:manage` | Replace items (ordered)                                       |
| POST   | `/api/playlists/:id/items`          | `playlists:manage` | Append media to a playlist                                    |
| DELETE | `/api/playlists/:id/items/:mediaId` | `playlists:manage` | Remove one media from a playlist                              |
| POST   | `/api/playlists/:id/items/reorder`  | `playlists:manage` | Reorder items                                                 |

### Schedule and plans

| Method | Path                                | Permission        | Purpose                                        |
| ------ | ----------------------------------- | ----------------- | ---------------------------------------------- |
| GET    | `/api/schedule`                     | `schedule:view`   | 24h grid + overrides + plan status             |
| PATCH  | `/api/schedule/:hour`               | `schedule:manage` | Update hour override/lock/live or its playlist |
| POST   | `/api/schedule/fallback-mode`       | `schedule:manage` | Toggle fallback (decades + news) mode          |
| POST   | `/api/schedule/generate`            | `schedule:manage` | Generate plans (or dry-run preview)            |
| GET    | `/api/schedule/template`            | `schedule:view`   | Hour template + generator settings             |
| PATCH  | `/api/schedule/template`            | `schedule:manage` | Update hour template / generator settings      |
| GET    | `/api/schedule/runs`                | `schedule:view`   | Generator runs                                 |
| GET    | `/api/schedule/boundary-log`        | `schedule:view`   | Boundary decisions (default: last 24 h)        |
| GET    | `/api/plans`                        | `schedule:view`   | Plans for a date                               |
| GET    | `/api/plans/:date/:hour`            | `schedule:view`   | One hour plan with items                       |
| POST   | `/api/plans/:date/:hour/regenerate` | `schedule:manage` | Regenerate one hour                            |

### Requests, alerts, stats, settings, backups

| Method | Path                          | Permission          | Purpose                                     |
| ------ | ----------------------------- | ------------------- | ------------------------------------------- |
| GET    | `/api/requests`               | `requests:moderate` | Moderation queue                            |
| POST   | `/api/requests/:id/approve`   | `requests:moderate` | Approve (inserted into the next hour)       |
| POST   | `/api/requests/:id/play-next` | `requests:moderate` | Approve and play next                       |
| POST   | `/api/requests/:id/reject`    | `requests:moderate` | Reject                                      |
| POST   | `/api/requests/:id/link`      | `requests:moderate` | Link a free-text request to a library track |
| GET    | `/api/requests/blacklist`     | `requests:moderate` | Request blacklist                           |
| POST   | `/api/requests/blacklist`     | `requests:moderate` | Add blacklist pattern                       |
| DELETE | `/api/requests/blacklist/:id` | `requests:moderate` | Remove blacklist pattern                    |
| GET    | `/api/alerts`                 | `alerts:view`       | Alerts (active/history)                     |
| POST   | `/api/alerts/:id/ack`         | `alerts:ack`        | Acknowledge                                 |
| POST   | `/api/alerts/test`            | `settings:manage`   | Send a test alert through every channel     |
| GET    | `/api/stats/listeners`        | `stats:view`        | Listener series + per-mount breakdown       |
| GET    | `/api/stats/history`          | `stats:view`        | Played history                              |
| GET    | `/api/stats/airplay`          | `stats:view`        | Airplay analytics                           |
| GET    | `/api/stats/export`           | `stats:view`        | CSV export (history                         | listeners | airplay | shifts) |
| GET    | `/api/settings`               | `settings:view`     | Station + typed settings                    |
| PATCH  | `/api/settings`               | `settings:manage`   | Update settings and/or station branding     |
| GET    | `/api/settings/audio`         | `settings:view`     | audio settings                              |
| GET    | `/api/settings/live`          | `settings:view`     | live settings                               |
| GET    | `/api/settings/requests`      | `settings:view`     | requests settings                           |
| GET    | `/api/settings/retention`     | `settings:view`     | retention settings                          |
| GET    | `/api/settings/backups`       | `settings:view`     | backups settings                            |
| GET    | `/api/settings/alerts`        | `settings:view`     | alerts settings                             |
| PATCH  | `/api/settings/audio`         | `settings:manage`   | Update audio settings                       |
| PATCH  | `/api/settings/live`          | `settings:manage`   | Update live settings                        |
| PATCH  | `/api/settings/requests`      | `settings:manage`   | Update requests settings                    |
| PATCH  | `/api/settings/retention`     | `settings:manage`   | Update retention settings                   |
| PATCH  | `/api/settings/backups`       | `settings:manage`   | Update backups settings                     |
| PATCH  | `/api/settings/alerts`        | `settings:manage`   | Update alerts settings                      |
| GET    | `/api/settings/stereotool`    | `settings:view`     | Stereo Tool configuration + status          |
| GET    | `/api/settings/icecast`       | `settings:view`     | Icecast mounts + status                     |
| GET    | `/api/admin/backups`          | `settings:manage`   | List backups                                |
| POST   | `/api/admin/backups`          | `settings:manage`   | Run a backup now                            |
