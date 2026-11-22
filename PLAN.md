# Online Radio Station — Execution Plan

**Version:** 1.0  
**Date:** 2026-11-21  
**Status:** Approved for execution  
**Target deployment:** Debian 13 LXC on Proxmox (small: 2 vCPU / 4 GB RAM)  
**Station type:** Single station, future-proof schema for more stations later  
**Core design:** Custom Node.js + TypeScript playout engine (FFmpeg-based), Thimeo Stereo Tool 10, Icecast 2.5/2.6, React control panel  
**Replaces:** the earlier draft of this `PLAN.md`

---

## 0. How to read this plan

- This is an execution plan, not a specification of every line of code. Each milestone has a clear goal, concrete tasks, files to create, and acceptance checks.
- Tasks are numbered (`M4.2`, `M7.3`, …) so they can be tracked in `PROGRESS.md`, GitHub issues, or by an AI agent.
- **Do not start the next milestone until the current milestone's acceptance criteria pass.**
- Every task should follow the template in [Appendix E](#appendix-e--task-execution-template).
- "Verify" means a command, test, or manual check that proves the task is done. Do not mark a task complete without running its verify step.

---

## 1. Executive summary

Build a self-contained online radio station that can run 24 hours of automated programming from **24 fixed one-hour playlists**, with an **interactive playout system** that an operator or DJ can control in real time. The audio chain is:

```
Media library (local path tree)
        │
        ▼
Playout engine (Node/TypeScript + FFmpeg decks + JS mixer)
        │  PCM 48 kHz / 16-bit stereo
        ▼
Thimeo Stereo Tool 10 (fixed preset, audio processing)
        │  processed PCM
        ▼
FFmpeg encoders (HQ MP3, mobile MP3, Opus, AAC)
        │
        ▼
Icecast 2.5/2.6 (mounts + native HLS)
        │
        ├──► Public listeners (/listen, HLS, MP3/Opus)
        └──► Public JSON API
```

The system is **not AzuraCast**. It is a custom application that borrows AzuraCast's proven ideas (scheduler, playlists, mounts, listener stats) but uses its own Node.js playout engine, its own database, and its own interactive controls. It is also compatible with the **playlist_maker** generator logic: that generator is ported to TypeScript and its 24-hour plans drive this playout engine.

### What makes this project different

1. **Interactive playout:** skip, jump, reorder, pause/resume, play-now stingers, voice-over/sweeper, live DJ takeover with ducking, listener request moderation, priority events, live console, MIDI/Stream Deck triggers.
2. **Clock-driven 24×1h schedule:** fixed hour grid with news locked at :00 and :30, music blocks, separation rules, overrun tolerance, and per-hour overrides.
3. **Real audio processing:** Thimeo Stereo Tool in the chain, with FFmpeg encoding after processing.
4. **Self-hosted and operator-friendly:** browser live studio, dark broadcast-console UI, public listen page, public API, alerts, metrics, backups.

---

## 2. Goals and non-goals

### 2.1 Goals

- Run 24/7 automation from 24 hourly playlists, with news at :00 and :30.
- Let an operator control playout instantly and safely from a web UI.
- Let a DJ go live from a browser with low latency and mic ducking.
- Process audio through Thimeo Stereo Tool 10 with a fixed, validated preset.
- Publish MP3 HQ, MP3 mobile, Opus, and HLS outputs through Icecast.
- Provide a public listener page, public API, song requests with moderation, and dedications.
- Provide roles, optional 2FA, audit trails, alerts, metrics, backups, and retention.
- Deploy cleanly to a Debian 13 LXC with systemd, nginx, and optional Certbot.
- Be executable step by step by a human or an AI agent, with tests at every layer.

### 2.2 Non-goals for v1

- No dependency on AzuraCast or Liquidsoap at runtime.
- No multi-station UI in v1; the schema keeps `station_id` for later.
- No listener accounts; public requests are anonymous, rate-limited, and moderated.
- No crossfade as the default transition; **per-track fade/cue points** are used. (Crossfade may be added later as an optional transition mode.)
- No phone-in / SIP / caller queue.
- No chat or message board.
- No native mobile app; the web UI is responsive.
- No S3/object-storage media management; local/NAS paths are read directly.
- No in-UI Stereo Tool preset editing; the preset is a fixed file, validated at install/startup.
- No SMS or voice alerts.
- No custom AAC/HLS packaging beyond Icecast native HLS.

---

## 3. Decisions log

These decisions come from the planning Q&A and are binding for execution.

| Area                | Decision                                                                          | Notes                                              |
| ------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| Deployment          | Proxmox LXC / Debian 13, systemd                                                  | Small container: 2 vCPU / 4 GB / 100 GB SSD target |
| Backend             | Node.js + TypeScript                                                              | Fastify API, separate playout worker               |
| Playout engine      | Custom Node/FFmpeg pipeline                                                       | No Liquidsoap, no AzuraCast                        |
| Frontend            | React + TS + Tailwind + shadcn/ui                                                 | Dark broadcast console                             |
| Database            | SQLite with WAL                                                                   | Single-writer API; worker reads plans read-only    |
| Schedule source     | Port playlist_maker generator to Node/TS                                          | Keep `[PM]` naming and logic                       |
| Library naming      | Keep playlist_maker conventions                                                   | `00s`–`90s`, `General`, `Nieuws/`                  |
| Hour boundary       | Tolerant cut with logging; news may start slightly early                          | Tolerance default 45 s, configurable               |
| Transitions         | Per-track fade/cue points                                                         | No crossfade in v1                                 |
| Dead-air / failure  | User-provided emergency loop file                                                 | Validated at startup                               |
| Stereo Tool         | Thimeo Stereo Tool 10, edition detected at install                                | Binary/preset/license paths configurable           |
| Stereo Tool chain   | FFmpeg encodes after Stereo Tool                                                  | ST outputs PCM; FFmpeg makes the mounts            |
| Stereo Tool control | Single fixed preset                                                               | No UI preset switching in v1                       |
| Outputs             | MP3 320k HQ, MP3 128k mobile, Opus 96k, AAC 96k, HLS                              | Icecast native HLS (2.5/2.6)                       |
| Icecast version     | Let the plan decide: **Icecast 2.5/2.6**                                          | Native HLS; verify in M0 spike                     |
| Server size         | Small LXC (2 vCPU / 4 GB)                                                         | Encoder CPU must stay < 50%                        |
| Timezone            | Europe/Amsterdam                                                                  | DST handled by Luxon; stored as UTC                |
| Media               | Local path tree + NAS/SMB/NFS read paths                                          | Full ingestion features in M2                      |
| Requests            | Moderated queue + MusicBrainz lookup + library-only + auto-approve with blacklist | Dedications and profanity filter included          |
| Users               | Local accounts, 3 roles, optional TOTP, email reset, audit trail                  | Admin / DJ / Operator                              |
| Alerts              | In-app, email, webhook, structured logs/syslog, Prometheus                        | All channels                                       |
| UI language         | English, dark console; i18n-ready for later languages                             | Public page in English                             |
| Stats               | Listeners, played history, airplay analytics + CSV, DJ shift reports              |                                                    |
| Live studio         | Single DJ, WebRTC/low-latency, browser-based                                      | Target < 500 ms glass-to-air; fallback documented  |
| Live recordings     | Keep 30 days                                                                      |                                                    |
| Public site         | `/listen` public, `/admin` control panel                                          | Same domain                                        |
| Public API          | Read-only + request POST + API keys                                               | OpenAPI documented                                 |
| Delivery            | AI-executable micro-steps, MVP first                                              | See §8 phase map                                   |
| Repo                | GitHub private, license TBD (recommend MIT)                                       | Do not redistribute Thimeo binaries                |
| Multi-station       | Single station, future-proof schema                                               | `station_id` on all relevant tables                |

---

## 4. Architecture

### 4.1 Process topology

| Process              | Responsibility                                                                   | User                        |
| -------------------- | -------------------------------------------------------------------------------- | --------------------------- |
| `radio-api`          | Fastify REST + WebSocket, auth, RBAC, DB writer, static UI, public API, triggers | `radio`                     |
| `radio-playout`      | Audio clock, decks, mixer, scheduler, Stereo Tool link, encoder hub, live bus    | `radio`                     |
| `radio-icecast`      | Icecast 2.5/2.6, mounts, HLS, stats                                              | `icecast` (package default) |
| `radio-stereotool`   | Thimeo Stereo Tool 10 processing                                                 | `radio`                     |
| `nginx`              | TLS, reverse proxy, static assets, HLS cache                                     | `www-data`                  |
| `radio-backup.timer` | Daily SQLite backup + retention                                                  | `radio`                     |

### 4.2 Data flow

```
Browser DJ ──WebRTC/Opus──► radio-playout (live bus) ──┐
Media files ──FFmpeg decode──► Decks ──► Mixer ────────┤
                                                        ▼
                                             Thimeo Stereo Tool
                                                        │ PCM
                                                        ▼
                                       Encoder Hub (FFmpeg x N mounts)
                                                        │ HTTP PUT
                                                        ▼
                                                    Icecast
                                                        │
                                        ┌───────────────┼───────────────┐
                                        ▼               ▼               ▼
                                  MP3 HQ          MP3 mobile      Opus / AAC / HLS
                                        │
                                        └──► Public listeners + /listen + public API
```

Control plane:

```
React /admin ──HTTPS/WSS──► nginx ──► radio-api ──Unix socket──► radio-playout
                                   │
                                   ├── SQLite (single writer)
                                   ├── SMTP (alerts/reset)
                                   ├── Webhooks (alerts)
                                   └── Icecast stats (read-only)
```

### 4.3 Why a separate playout process

- Audio must not be killed by an API restart or a web request.
- The API can restart independently while the station stays on air.
- The worker can be restarted with backoff and report its state to the API.
- SQLite remains single-writer: only `radio-api` writes; `radio-playout` reads plans/media read-only and sends events back to the API.

---

## 5. Functional requirements

### 5.1 24×1-hour automation

- 24 fixed hourly playlists (`[PM] 00:00` … `[PM] 23:00`), each with a schedule slot covering one hour, every day.
- Each hour contains:
  - **News at :00** (locked block, default 3 minutes).
  - **Music block 1** (default :03–:30).
  - **News at :30** (locked block, default 3 minutes).
  - **Music block 2** (default :33–:60).
- Per-hour overrides can change blocks, disable an hour, or mark it **live**.
- Track separation: no repeat of the same track within **4 hours**; no repeat of the same artist within **1 hour** (defaults, configurable).
- Hour target length: **3540–3720 seconds** (59–62 minutes).
- Tail window: last **300 seconds** of a music block; tail overrun allowed up to **45 seconds**; general candidate overrun up to **90 seconds**.
- Generator runs:
  - **23:00** station time: generate hour 0 for the next day.
  - **00:05** station time: generate hours 1–23 for today.
- Guards:
  - Never rewrite the **current on-air hour**.
  - Never rewrite hours already past today (except the special hour-0/tomorrow flow).
  - Live hours are skipped by the generator; the scheduler expects a live source.
- Fallback mode: a single switch flips between normal PM mode and legacy decades+news mode.
- News reprocessing every 5 minutes; playlist integrity check every 5 minutes.

### 5.2 Interactive playout

Required controls:

- Skip current track.
- Jump to a specific queued/planned item.
- Reorder the upcoming queue (drag-and-drop and API).
- Remove an item from the queue.
- Pause/resume output with silence detection.
- Interrupt / play-now: push a stinger, ad, jingle, news bulletin, or emergency track to the front; return to the previous queue afterward.
- Live DJ takeover with mic ducking (and optional full takeover).
- Voice-over / sweeper over a track (ducked).
- Listener request queue with moderation.
- Event / priority override slots (scheduled or manual).
- Live console: master fader, meters, monitor, instant replay of the last track.
- Hardware/MIDI/Stream Deck triggers via a local trigger endpoint.
- Emergency stop / emergency loop.

### 5.3 Live studio

- Single live DJ at a time.
- Browser-based studio with microphone permission, device selection, input gain, mute, and input meter.
- Low-latency transport (target < 500 ms glass-to-air).
- Music ducking while the mic is open, with configurable depth/attack/release.
- Cue/monitor and next-track preview before going live.
- Record the live session (mixed output) and keep it for 30 days.
- External encoder support (Icecast source) as an alternative input.
- Server line-in / USB audio interface as an optional input (requires device passthrough in the LXC).
- No-show handling for scheduled live hours (grace period, then fallback playlist + alert).

### 5.4 Media library

- Recursive folder scan of a local media root (and read-only NAS/SMB/NFS mounts).
- Import ID3/Vorbis tags, duration, sample rate, channels, bitrate, codec, artwork.
- Watch folder auto-import (debounced).
- Web upload with progress, MIME/size validation, and tag editing.
- Duplicate detection by file hash and near-duplicate metadata.
- Loudness analysis (EBU R128 / ReplayGain), store `loudness_lufs` and `peak_db`; playback applies gain (originals untouched by default).
- Metadata/artwork lookup via MusicBrainz/Last.fm with a review queue.
- Search/filter by artist, title, album, duration, loudness, status, duplicates.

### 5.5 Requests

- Public request form: artist + title (library search), optional message, optional dedication/shout-out.
- Optional display name/contact.
- Profanity filter and per-IP cooldown (default 60 minutes).
- Rate limit: 3 requests/hour/IP (configurable).
- Moderation queue: approve, reject, play next, or insert into a specific hour.
- Auto-approve with blacklist option.
- Library-only requests with free-text fallback into moderation.
- Listener can see request status (pending/approved/played/rejected).

### 5.6 Users, roles, audit

- Local accounts with **Admin**, **DJ**, **Operator** roles.
- Admin: everything, including users, settings, API keys.
- DJ: live studio, playout controls, own shift reports; no global settings/users.
- Operator: playout control, requests, media/playlist management; no users/settings.
- Argon2id password hashing; opaque session tokens in HttpOnly/Secure/SameSite cookies.
- Optional TOTP 2FA for Admin/DJ.
- Email password reset (SMTP configurable).
- Append-only audit log for every control action and settings change.
- API keys with scopes for partners/triggers.

### 5.7 Stats and history

- Listener counts over time, current/peak listeners, per-mount breakdown (from Icecast stats).
- Played-track history with timestamps and artwork.
- Airplay analytics: plays per hour/day, unique artists, request counts, CSV export.
- DJ shift reports: who was live, when, duration, peak listeners.

### 5.8 Public site and API

- `/listen`: dark, branded listener page with player, now-playing, schedule, recently played, request form.
- `/listen/schedule`: public 24h schedule.
- Public JSON API:
  - `GET /api/public/now-playing`
  - `GET /api/public/schedule`
  - `GET /api/public/history`
  - `POST /api/public/requests`
  - `GET /api/public/stats` (API key required)
- OpenAPI document served at `/api/docs`.
- Embeddable player: not in v1.

### 5.9 Alerts and operations

- In-app notification bell + dashboard banner.
- Email alerts (SMTP).
- Webhook alerts (JSON POST; Discord/Telegram/Slack/n8n/Home Assistant compatible).
- Structured logs to stdout/journald/syslog.
- Prometheus metrics endpoint.
- Alert types: dead air, encoder failure, Stereo Tool failure, Icecast source loss, live no-show, request abuse, backup failure, disk low, generator gap.
- Health/readiness endpoints for monitoring.

---

## 6. Technical design

### 6.1 Repository layout

```text
online-radio-player/
├─ package.json                     # pnpm workspace root
├─ pnpm-workspace.yaml
├─ pnpm-lock.yaml
├─ tsconfig.base.json
├─ eslint.config.mjs
├─ .env.example
├─ .gitignore
├─ README.md
├─ PLAN.md
├─ PROGRESS.md
├─ apps/
│  ├─ api/                          # Fastify control API + public API
│  │  ├─ src/
│  │  │  ├─ server.ts
│  │  │  ├─ routes/
│  │  │  ├─ services/
│  │  │  ├─ ws/
│  │  │  └─ worker-client.ts
│  │  └─ package.json
│  ├─ playout/                      # Node audio worker
│  │  ├─ src/
│  │  │  ├─ index.ts
│  │  │  ├─ audio/
│  │  │  ├─ scheduler/
│  │  │  ├─ stereotool/
│  │  │  ├─ encoders/
│  │  │  ├─ live/
│  │  │  └─ protocol/
│  │  └─ package.json
│  └─ web/                          # React + Vite control panel + /listen
│     ├─ src/
│     │  ├─ pages/admin/
│     │  ├─ pages/listen/
│     │  ├─ components/
│     │  ├─ hooks/
│     │  └─ lib/
│     └─ package.json
├─ packages/
│  ├─ core/                         # domain types, generator, scheduler rules
│  ├─ db/                           # Drizzle schema, migrations, repositories
│  └─ shared/                       # Zod schemas, API types, constants
├─ config/
│  ├─ station.example.json
│  ├─ icecast.xml.example
│  └─ nginx.example.conf
├─ scripts/
│  ├─ install.sh
│  ├─ backup.sh
│  ├─ restore.sh
│  ├─ dev.sh
│  └─ smoke-test.sh
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  └─ e2e/
├─ docs/
│  ├─ adr/
│  ├─ api.md
│  ├─ admin-guide.md
│  └─ runbook.md
└─ .github/workflows/ci.yml
```

### 6.2 Backend modules

| Module            | Responsibility                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| `packages/shared` | Zod schemas for config, API payloads, WS events, plan items, media                                  |
| `packages/db`     | Drizzle schema, migrations, typed repositories, backup helpers                                      |
| `packages/core`   | Pure domain logic: generator, separation, boundary rules, queue rules, loudness math                |
| `apps/api`        | Fastify server, auth, RBAC, REST, WS, static serving, worker socket client, alerts, metrics         |
| `apps/playout`    | Audio clock, decks, mixer, scheduler, Stereo Tool link, encoder hub, live bus, worker socket server |

### 6.3 Database schema (SQLite)

All tables include `id INTEGER PRIMARY KEY AUTOINCREMENT`, `created_at`, `updated_at` where useful. All station-owned tables include `station_id` (default 1).

#### Core station and auth

```text
stations(id, name, timezone, locale, logo_url, colors_json, created_at, updated_at)

users(
  id, station_id, username UNIQUE, email UNIQUE, password_hash,
  role CHECK(role IN ('admin','dj','operator')),
  totp_secret, totp_enabled, is_active, last_login_at, created_at, updated_at
)

sessions(
  id, user_id, token_hash UNIQUE, ip, user_agent,
  expires_at, created_at, revoked_at
)

password_resets(
  id, user_id, token_hash UNIQUE, expires_at, used_at, created_at
)

api_keys(
  id, station_id, name, key_prefix, key_hash UNIQUE,
  scopes_json, created_by, last_used_at, revoked_at, created_at
)

audit_log(
  id, station_id, user_id, action, entity_type, entity_id,
  metadata_json, ip, created_at
)  -- append-only; no update/delete API
```

#### Media and playlists

```text
media(
  id, station_id, path UNIQUE, relative_path,
  title, artist, artist_sort, album, album_artist, genre, year,
  duration, sample_rate, channels, bitrate, codec,
  loudness_lufs, peak_db, gain_db,
  cue_in, cue_out, fade_in, fade_out,
  artwork_path, hash, size, mtime,
  status CHECK(status IN ('ok','missing','processing','error','disabled')),
  tags_json, created_at, updated_at
)

playlists(
  id, station_id, name UNIQUE, role CHECK(role IN ('music','news','jingle','general','decade')),
  prefix, rotation, weight, is_jingle, enabled, sort_order, created_at, updated_at
)

playlist_items(
  id, playlist_id, media_id, weight, position,
  UNIQUE(playlist_id, media_id)
)

metadata_suggestions(
  id, media_id, source, payload_json, status, created_at, applied_at
)
```

#### Schedule and plans

```text
schedule_slots(
  id, station_id, hour, playlist_id,
  start_time, end_time, days_json, start_date, end_date,
  loop_once, priority, enabled, created_at, updated_at,
  UNIQUE(station_id, hour, start_date)
)

hourly_plans(
  id, station_id, plan_date, hour, status CHECK(status IN ('draft','ready','on_air','done','failed')),
  generated_at, total_seconds, warnings_json, snapshot_json,
  UNIQUE(station_id, plan_date, hour)
)

plan_items(
  id, plan_id, position, media_id, kind CHECK(kind IN ('music','news','jingle','live')),
  start_seconds, length, playlist_id, artist, title, is_locked
)

boundary_events(
  id, station_id, plan_id, occurred_at, boundary_at,
  action CHECK(action IN ('cut','let_finish','early_news','late_news','none')),
  deviation_ms, details_json
)

schedule_settings(
  id, station_id, key, value_json, updated_at,
  UNIQUE(station_id, key)
)
```

#### Live, events, requests

```text
live_sessions(
  id, station_id, user_id, mode CHECK(mode IN ('duck','takeover')),
  started_at, ended_at, duration, recorded_path, recorded_size,
  peak_listeners, notes, created_at
)

events(
  id, station_id, title, type CHECK(type IN ('playlist','live','stinger')),
  start_at, end_at, priority, playlist_id, status,
  created_by, created_at, ended_at
)

requests(
  id, station_id, listener_ip, display_name, contact,
  artist, title, message, dedication,
  media_id, status CHECK(status IN ('pending','approved','rejected','played','expired')),
  moderated_by, moderated_at, play_after, created_at, played_at
)

request_rate_limits(
  id, station_id, ip, window_start, count,
  UNIQUE(station_id, ip, window_start)
)

request_blacklist(
  id, station_id, pattern, match_type, created_by, created_at
)
```

#### History, stats, alerts, settings

```text
play_history(
  id, station_id, media_id, plan_id, started_at, ended_at,
  source CHECK(source IN ('automation','live','event','request','manual')),
  listeners_peak, created_at
)

listener_stats(
  id, station_id, ts, mount, listeners
)

alerts(
  id, station_id, type, severity, message, details_json,
  created_at, acknowledged_at, acknowledged_by, resolved_at
)

settings(
  id, station_id, key UNIQUE, value_json, updated_at
)

backups(
  id, path, type, size, created_at, verified_at
)
```

Indexes to add: `media(station_id, artist)`, `media(station_id, title)`, `play_history(station_id, started_at)`, `listener_stats(station_id, ts, mount)`, `requests(station_id, status, created_at)`, `plan_items(plan_id, position)`.

### 6.4 Playout engine

#### 6.4.1 Audio clock and PCM format

- Internal format: **48 kHz, 16-bit signed little-endian, stereo** (`s16le`).
- Frame size: 64 samples (1.333 ms) for mixing; 480 samples (10 ms) for meter/WS updates.
- Audio clock: monotonic `process.hrtime.bigint()` derived sample counter; never use wall clock for sample timing.
- Ring buffer per deck; backpressure-aware writes to Stereo Tool and encoders.
- Gain/fade applied in JS on `Int16Array` frames; soft limiter at the master bus to prevent clipping.

#### 6.4.2 Deck

A `Deck` is one FFmpeg process decoding one media file to PCM:

```text
ffmpeg -v error -nostdin -ss <cue_in> -t <play_duration>
       -i <path>
       -af "atrim=start=0:end=<duration>,asetpts=PTS-STARTPTS"
       -f s16le -ar 48000 -ac 2 pipe:1
```

Responsibilities:

- Start, stop, pause, resume, seek, replay.
- Track `playedSamples`, `durationSamples`, `endTime`.
- Report EOF, error, and decode stats.
- Apply per-track `fade_in`, `fade_out`, `cue_in`, `cue_out` metadata.
- Expose peak/RMS for the console meters.
- On pause: stop reading and remember position; on resume: restart FFmpeg with `-ss` at the remembered position. This is sample-accurate enough for broadcast and avoids unbounded buffers.
- On seek/skip: kill the process group, spawn a new deck.

#### 6.4.3 Mixer

The `Mixer` is the single audio brain:

- Active decks: automation deck, next deck (preloaded), live bus, voice-over bus, event bus, emergency bus.
- Per-bus gain and mute.
- Master fader.
- Ducking envelope: when live/voice-over is active, automation gain follows an attack/release envelope to `duck_db`.
- Soft limiter (look-ahead 5 ms, threshold -1 dBFS).
- Produces one PCM stream for Stereo Tool.
- If Stereo Tool is bypassed, produces the same PCM stream for the encoder hub.
- Meters: per-bus peak/RMS and master peak/RMS, published over WS at 10 Hz.

#### 6.4.4 Scheduler runtime

State machine:

```text
IDLE → AUTOPLAY → (LIVE | EVENT | INTERRUPT | EMERGENCY) → AUTOPLAY
```

- `AUTOPLAY`: load the current hour's plan; maintain `queue` of upcoming items; start items at their planned offsets where possible.
- On hour change: load the new plan; apply boundary rules; log `boundary_events`.
- `LIVE`: automation is paused or ducked depending on mode; on end, resume at the correct plan position.
- `EVENT`: a higher-priority event takes over; on end, resume.
- `INTERRUPT`: a play-now item is inserted at the front; after it ends, resume the previous queue.
- `EMERGENCY`: emergency loop is the only source; alerts are raised; recovery is manual or automatic after the fault clears.

Scheduler ticks every 100 ms; it uses `luxon` with the station timezone for hour boundaries and DST.

#### 6.4.5 Hour boundary rules (precise)

Definitions:

- `B` = next hour boundary (e.g. 14:00:00.000).
- `T` = now.
- `tol` = `boundaryToleranceSeconds` (default **45 s**).
- `current` = currently playing item.
- `next` = next planned item.

Rules:

1. **News and locked blocks always win at the boundary.** If the next item is news (or a locked block), it starts at `B`, or earlier if the current track ends early and `B - end <= tol`.
2. **Current track ends before B:**
   - If `B - end <= tol`: let it finish; start news **early** (up to `tol`). This is explicitly allowed.
   - Otherwise: normal transition to the next planned item.
3. **Current track overruns B:**
   - If `overrun <= tol`: let it finish; news starts **late** by `overrun` (up to `tol`). Log `late_news`.
   - If `overrun > tol`: fade out over 50–250 ms and **cut at B**; start news at `B`. Log `cut`.
4. **Do not start a new music track if it would leave less than `tol` before B.** If the current track has ended and the next item is music, wait for `B` (or start news early if the next block is news). Log `early_news` / `none`.
5. **At exactly B:** force the boundary transition if it has not happened. If a music track is still playing and `overrun > tol`, cut it. If `overrun <= tol`, allow it to finish (rule 3).
6. **Every boundary decision is logged** in `boundary_events` with `action`, `deviation_ms`, and details. The UI shows a "Boundary log" for the current hour.
7. **Live/event override:** if a live session or event is active at B, the scheduler does not force the news transition; it records that the boundary was overridden and resumes automation at the correct point after the live/event ends.

#### 6.4.6 Live, voice-over, events, interrupts

- **Live (duck mode):** automation continues at `duck_db`; live mic is added to the mix. On end, restore gain with a release envelope.
- **Live (takeover mode):** automation is paused at the current sample position. On end:
  - If the live session ended before the next planned item, resume the paused track from its position.
  - If the live session crossed an hour boundary, skip to the new hour's plan (do not resume a stale track).
- **Voice-over:** upload/select a voice file; mix it with music ducked by `duck_db`; return to normal after it ends. Optional "record now" from the operator's mic.
- **Events:** scheduled events with priority 1–10. A higher-priority event preempts automation; a lower-priority event waits. Manual event start/stop from the UI.
- **Interrupts:** `play_now` items (stinger, ad, jingle, news) are inserted at the front of the queue; the previous queue is preserved and restored after the item ends.
- **Requests:** approved requests are inserted either "play next" (front of queue) or "next hour" (first music slot after news). The worker receives an `insert_request` command with the target position.

#### 6.4.7 Emergency and fallback

- Silence detector: monitor master PCM RMS before Stereo Tool. If RMS < -60 dBFS for **10 s** (configurable), trigger emergency.
- Encoder failure: if all encoders fail or Icecast rejects the source for **15 s**, trigger emergency.
- Stereo Tool failure: restart with backoff; if it fails `maxAttempts`, bypass Stereo Tool and raise a critical alert (config `bypassOnFailure`).
- Emergency source: user-provided loop file (`/srv/radio/media/Emergency/emergency-loop.mp3` by default), validated at startup and daily.
- Emergency mode: loop the file, keep encoders running, raise an in-app/email/webhook alert, and show a red banner in the UI.
- Recovery: automatic when the fault clears (if no operator action is needed), otherwise manual "Resume automation" button.

#### 6.4.8 Worker protocol

- Transport: Unix domain socket at `/run/radio/playout.sock` (fallback TCP `127.0.0.1:8765` for Windows dev).
- Message format: newline-delimited JSON with `v`, `id`, `type`, `payload`, `ts`.
- API → worker commands:
  - `play`, `pause`, `resume`, `stop`, `skip`, `seek`
  - `queue:list`, `queue:remove`, `queue:move`, `queue:insert`
  - `play_now`, `voice_over`, `replay_last`
  - `live:start`, `live:stop`, `live:set_gain`, `live:set_mode`
  - `event:start`, `event:stop`
  - `emergency:trigger`, `emergency:clear`
  - `fader:set`, `monitor:set`
  - `trigger:fire`
- Worker → API events:
  - `state`, `now_playing`, `queue`, `meter`, `live:status`
  - `track_started`, `track_ended`, `boundary`
  - `encoder:status`, `stereotool:status`, `icecast:status`
  - `alert`, `error`
- Every command is validated with Zod; every command is written to `audit_log` by the API.
- Worker sends heartbeats every 5 s; API reconnects with exponential backoff.

### 6.5 Audio output chain

#### 6.5.1 Thimeo Stereo Tool adapter

The adapter isolates the exact Thimeo CLI/streaming method so the rest of the system does not care.

Interface:

```ts
interface StereoToolAdapter {
  start(): Promise<void>;
  writePcm(chunk: Buffer): Promise<void>;
  readPcm(): AsyncIterable<Buffer>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  status(): { running: boolean; edition?: string; preset?: string; error?: string };
}
```

Implementations to evaluate in the M0 spike, in order of preference:

1. **Stdio PCM**: `stereotool_cmd` reads raw PCM from stdin and writes raw PCM to stdout.
2. **FIFO/WAV**: named pipes with WAV headers, if stdio raw PCM is unsupported.
3. **TCP**: Stereo Tool listens/connects on a local TCP port for PCM.
4. **ALSA loopback**: only if pipes/TCP are impossible (requires kernel module and privileged LXC; document as a last resort).
5. **Passthrough**: dev/staging mode with no Stereo Tool.

Configuration:

```json
{
  "stereotool": {
    "enabled": true,
    "binary": "/opt/stereotool/stereotool_cmd",
    "preset": "/etc/radio/stereotool.sds",
    "license": "/opt/stereotool/stereotool.lic",
    "inputMode": "stdio-pcm",
    "restart": { "maxAttempts": 5, "backoffMs": 2000 },
    "bypassOnFailure": true
  }
}
```

Install-time detection: read the binary version/edition, validate the license, validate the preset file exists, and log the detected edition. The installer must not assume Standard vs Professional.

#### 6.5.2 Encoder hub

One FFmpeg process per public mount. All read the same processed PCM from the mixer via a fan-out writer.

Example HQ MP3:

```text
ffmpeg -v error -nostdin
  -f s16le -ar 48000 -ac 2 -i pipe:0
  -c:a libmp3lame -b:a 320k
  -f mp3 -content_type audio/mpeg
  "icecast://source:<pass>@127.0.0.1:8000/hq.mp3"
```

Example mobile MP3:

```text
... -c:a libmp3lame -b:a 128k -f mp3 -content_type audio/mpeg
    "icecast://source:<pass>@127.0.0.1:8000/mobile.mp3"
```

Example Opus:

```text
... -c:a libopus -b:a 96k -f opus -content_type audio/ogg
    "icecast://source:<pass>@127.0.0.1:8000/opus.ogg"
```

Example AAC:

```text
... -c:a aac -b:a 96k -f adts -content_type audio/aac
    "icecast://source:<pass>@127.0.0.1:8000/aac.aac"
```

Encoder hub responsibilities:

- Spawn/restart per-mount FFmpeg with exponential backoff.
- Fan-out PCM with per-encoder bounded queues (default 10 s).
- Never drop audio silently; if a queue is full, pause the mixer output and alert.
- Parse FFmpeg stderr; expose bitrate, uptime, restart count.
- Validate each mount with a short test tone at startup.
- Report per-mount status over WS and Prometheus.

#### 6.5.3 Icecast

- Version target: **Icecast 2.5/2.6** (native HLS). Verify exact package availability on Debian 13; if 2.6 is unavailable, use the latest 2.5.x.
- Listen on `127.0.0.1:8000` only; nginx proxies public streams.
- Mounts: `/hq.mp3`, `/mobile.mp3`, `/opus.ogg`, `/aac.aac`, `/hls`.
- Source password and admin password from environment/secret file, never committed.
- Stats enabled; poll `/admin/stats` (or `/status-json.xsl`) every 10 s.
- Public mount fallback: if a listener requests a mount that is down, nginx returns a friendly error or redirects to the working mount.
- CORS headers for HLS/JSON where needed.
- Access/error logs to `/var/log/icecast/`.

#### 6.5.4 HLS

- Use Icecast native HLS if the installed version supports it; configure the HLS mount and verify in a browser.
- Fallback if native HLS is unstable: FFmpeg segmenter reading the processed PCM and writing HLS to `/srv/radio/hls`, served by nginx. This fallback is a documented spike result, not the default.
- HLS latency target: 6–10 s; document actual.

#### 6.5.5 nginx

- TLS termination with Certbot (optional; `--domain` flag).
- Routes:
  - `/api/` and `/ws/` → `radio-api`
  - `/admin/` → React SPA
  - `/listen/` → React public page
  - `/stream/` → Icecast mounts
  - `/hls/` → Icecast HLS
- WebSocket upgrade headers for `/ws/`.
- Security headers: HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy.
- Client body limit for uploads (e.g. 500 MB).
- Static asset caching.

### 6.6 Live studio transport

M0 spike compares:

1. **LiveKit self-hosted** + `livekit-client` in the browser + `livekit-server-sdk` in Node. Best if the Node SDK exposes decoded PCM `AudioStream` frames; gives sub-500 ms latency.
2. **WebSocket + Opus** (browser `AudioWorklet` + `opus-recorder`/`libopus.js`; Node `opusscript`/`node-opus` or FFmpeg decode). Simpler, no SFU, ~300–700 ms; fallback if LiveKit PCM access is not available.
3. **External Icecast source** (BUTT/Mixxx/RadioDJ): FFmpeg pulls `/live` from a local Icecast ingest mount, outputs PCM to the mixer. Higher latency (2–5 s), but works with existing broadcast tools.
4. **Line-in/USB**: FFmpeg ALSA capture (`-f alsa -i hw:1`) into the mixer; optional, requires device passthrough.

Decision criteria: glass-to-air latency, CPU/RAM on 2 vCPU, browser support, PCM access, operational complexity. The default is the lowest-latency option that passes the spike; the chosen transport is recorded in an ADR.

Live session flow:

1. DJ authenticates, selects mic/device, sets gain, sees input meter.
2. "Go live" countdown (3 s) with optional bed music.
3. Transport connects; worker adds the live bus to the mixer; ducking starts.
4. DJ talks/plays; meters and listener count visible.
5. "End live" fades the live bus, restores automation, stops recording, writes `live_sessions`.

### 6.7 REST API contract

All `/api/admin/*` endpoints require a session (or API key for triggers). All payloads validated with Zod. Errors use `{ error: { code, message, details } }`.

| Method           | Path                                | Purpose                                          |
| ---------------- | ----------------------------------- | ------------------------------------------------ |
| POST             | `/api/auth/login`                   | Login (username/email + password, optional TOTP) |
| POST             | `/api/auth/logout`                  | Revoke session                                   |
| GET              | `/api/auth/me`                      | Current user                                     |
| POST             | `/api/auth/password/forgot`         | Request reset email                              |
| POST             | `/api/auth/password/reset`          | Reset with token                                 |
| POST             | `/api/auth/2fa/setup`               | Start TOTP setup                                 |
| POST             | `/api/auth/2fa/enable`              | Confirm TOTP                                     |
| POST             | `/api/auth/2fa/disable`             | Disable TOTP                                     |
| GET/POST         | `/api/admin/users`                  | List/create users                                |
| PATCH/DELETE     | `/api/admin/users/:id`              | Update/deactivate                                |
| GET/POST         | `/api/admin/api-keys`               | Manage API keys                                  |
| GET              | `/api/media`                        | Search/filter media                              |
| POST             | `/api/media/import`                 | Start folder scan                                |
| POST             | `/api/media/upload`                 | Multipart upload                                 |
| GET/PATCH/DELETE | `/api/media/:id`                    | Get/edit/delete                                  |
| PATCH            | `/api/media/:id/tags`               | Edit tags                                        |
| GET              | `/api/media/:id/artwork`            | Artwork bytes                                    |
| POST             | `/api/media/:id/analyze`            | Re-run loudness                                  |
| GET              | `/api/media/duplicates`             | Duplicate groups                                 |
| GET/POST         | `/api/playlists`                    | List/create                                      |
| PATCH/DELETE     | `/api/playlists/:id`                | Update/delete                                    |
| PUT              | `/api/playlists/:id/items`          | Replace items (ordered)                          |
| POST             | `/api/playlists/:id/items/reorder`  | Reorder                                          |
| GET              | `/api/schedule`                     | 24h grid + overrides                             |
| PATCH            | `/api/schedule/:hour`               | Update override/lock/live                        |
| POST             | `/api/schedule/fallback-mode`       | Toggle fallback mode                             |
| POST             | `/api/schedule/generate`            | Generate plans                                   |
| GET              | `/api/plans?date=YYYY-MM-DD`        | Plans for a date                                 |
| GET              | `/api/plans/:date/:hour`            | One hour plan                                    |
| POST             | `/api/plans/:date/:hour/regenerate` | Regenerate one hour                              |
| GET              | `/api/playout/state`                | Full playout state                               |
| POST             | `/api/playout/skip`                 | Skip current                                     |
| POST             | `/api/playout/pause`                | Pause                                            |
| POST             | `/api/playout/resume`               | Resume                                           |
| POST             | `/api/playout/stop`                 | Stop output                                      |
| POST             | `/api/playout/seek`                 | Seek current                                     |
| GET              | `/api/playout/queue`                | Upcoming queue                                   |
| POST             | `/api/playout/queue/move`           | Reorder                                          |
| DELETE           | `/api/playout/queue/:id`            | Remove                                           |
| POST             | `/api/playout/play-now`             | Interrupt/play-now                               |
| POST             | `/api/playout/voice-over`           | Play voice-over                                  |
| POST             | `/api/playout/replay-last`          | Replay last track                                |
| PATCH            | `/api/playout/fader`                | Master fader                                     |
| POST             | `/api/playout/emergency`            | Trigger/clear emergency                          |
| POST             | `/api/live/start`                   | Start live session                               |
| POST             | `/api/live/stop`                    | Stop live session                                |
| GET              | `/api/live/status`                  | Live status                                      |
| GET              | `/api/live/recordings`              | List recordings                                  |
| GET/DELETE       | `/api/live/recordings/:id`          | Download/delete                                  |
| GET/POST         | `/api/events`                       | Manage events                                    |
| GET              | `/api/requests`                     | Moderation queue                                 |
| POST             | `/api/requests/:id/approve`         | Approve                                          |
| POST             | `/api/requests/:id/reject`          | Reject                                           |
| POST             | `/api/requests/:id/play-next`       | Insert play-next                                 |
| GET/POST         | `/api/requests/blacklist`           | Blacklist                                        |
| GET              | `/api/alerts`                       | Alerts                                           |
| POST             | `/api/alerts/:id/ack`               | Acknowledge                                      |
| GET              | `/api/stats/listeners`              | Listener stats                                   |
| GET              | `/api/stats/history`                | Played history                                   |
| GET              | `/api/stats/airplay`                | Airplay analytics                                |
| GET              | `/api/stats/export`                 | CSV export                                       |
| GET/PATCH        | `/api/settings`                     | Station settings                                 |
| GET/PATCH        | `/api/settings/audio`               | Audio settings                                   |
| GET/PATCH        | `/api/settings/stereotool`          | Stereo Tool settings                             |
| GET/PATCH        | `/api/settings/icecast`             | Icecast settings                                 |
| GET              | `/api/public/now-playing`           | Public now-playing                               |
| GET              | `/api/public/schedule`              | Public schedule                                  |
| GET              | `/api/public/history`               | Public history                                   |
| POST             | `/api/public/requests`              | Public request                                   |
| GET              | `/api/public/stats`                 | Partner stats (API key)                          |
| POST             | `/api/triggers/:id`                 | Hardware/MIDI/Stream Deck trigger (API key)      |
| GET              | `/api/health`                       | Liveness                                         |
| GET              | `/api/ready`                        | Readiness                                        |

### 6.8 WebSocket contract

Endpoint: `wss://<host>/ws` (nginx upgrades to `ws://127.0.0.1:3001/ws`).

Client → server:

```json
{ "type": "subscribe", "channels": ["playout", "live", "alerts", "requests", "stats"] }
{ "type": "ping" }
```

Server → client events:

```json
{ "type": "playout:state", "data": { ... } }
{ "type": "playout:now-playing", "data": { "mediaId": 1, "title": "...", "artist": "...", "startedAt": "...", "duration": 240, "position": 42 } }
{ "type": "playout:queue", "data": { "items": [ ... ] } }
{ "type": "playout:meter", "data": { "masterPeak": -3.2, "masterRms": -18.1, "decks": [ ... ] } }
{ "type": "live:status", "data": { "active": true, "mode": "duck", "userId": 2, "startedAt": "...", "recording": true } }
{ "type": "encoders:status", "data": { "mounts": [ ... ] } }
{ "type": "alerts:new", "data": { "id": 1, "severity": "critical", "message": "..." } }
{ "type": "requests:new", "data": { "id": 1, "artist": "...", "title": "..." } }
```

### 6.9 Frontend

Stack: React 19, Vite, TypeScript, Tailwind CSS, shadcn/ui, React Router, TanStack Query, Zustand, Recharts, `lucide-react`, `sonner` for toasts.

Routes:

```text
/login
/admin                      Dashboard
/admin/playout              Playout console
/admin/live                 Live studio
/admin/schedule             24h schedule grid
/admin/playlists            Playlist manager + generator preview
/admin/media                Media library
/admin/requests             Request moderation
/admin/events               Event/priority override manager
/admin/stats                Listener/airplay stats
/admin/users                Users, roles, API keys
/admin/settings             Station, audio, Stereo Tool, Icecast, alerts, backups
/admin/alerts               Alert center
/listen                     Public listen page
/listen/schedule            Public schedule
```

Key UI components:

- `NowPlayingCard` — artwork, title/artist, progress, listeners.
- `PlayoutConsole` — transport, queue DnD, play-now, voice-over, fader, meters, emergency.
- `LiveStudio` — mic device, gain, meter, ducking controls, record, cue preview, go-live.
- `ScheduleGrid` — 24 rows, current hour highlighted, override/live/lock/fallback.
- `MediaLibrary` — virtualized table, filters, tag editor, waveform/artwork preview, duplicates.
- `RequestModeration` — approve/reject/play-next, blacklist, auto-approve.
- `StatsDashboard` — listener chart, mount breakdown, airplay table, CSV export.
- `SettingsForms` — typed forms backed by Zod.
- `PublicPlayer` — accessible audio player with volume, artwork, now-playing, schedule, request form.

Design rules:

- Dark broadcast console by default; light mode optional later.
- Dense but readable; keyboard shortcuts for transport (space = play/pause, right arrow = skip, etc.).
- Responsive down to tablet; phone is a secondary control surface.
- All destructive actions require confirmation.
- Toasts for success/failure; persistent alert banner for critical states.
- No layout shift; skeletons while loading.
- Accessibility: focus states, ARIA labels, keyboard navigation, sufficient contrast.

### 6.10 Security

- Argon2id password hashing (OWASP parameters).
- Session tokens: 32 random bytes, hashed in DB, HttpOnly/Secure/SameSite=Lax cookie.
- CSRF: double-submit token for cookie-authenticated mutations.
- RBAC enforced server-side on every route; never trust the UI.
- 2FA: TOTP (`otplib`), recovery codes.
- Rate limiting: `@fastify/rate-limit` on auth, public requests, triggers.
- Input validation: Zod on all bodies/params/queries.
- Uploads: MIME sniffing, extension allowlist, size limit, store outside web root, random filename.
- Secrets: `.env` / `/etc/radio/secrets.env`, chmod 600; never in git.
- Icecast passwords: generated, stored in secrets file, not in DB.
- Thimeo license: 0600, not redistributed.
- nginx: TLS 1.2+, HSTS, security headers.
- Dependency scanning in CI; `npm audit`/`pnpm audit`.
- Audit log append-only; no update/delete endpoints.

### 6.11 Configuration

`config/station.example.json` (full example in Appendix A) covers:

- Station identity/timezone/locale/branding.
- Audio format, buffer, master gain, target LUFS, boundary tolerance.
- Stereo Tool binary/preset/license/mode/restart/bypass.
- Icecast host/port/mounts/HLS.
- Scheduler generator settings, live settings, request settings.
- Retention, backups, email, webhooks, metrics.

Validation:

- `pnpm config:validate` checks required fields, file paths, and permissions.
- Startup fails fast on invalid config; logs a readable error.
- Secrets come from environment variables or `/etc/radio/secrets.env`, not the JSON.

### 6.12 Deployment

Debian 13 LXC, systemd, nginx, optional Certbot. `scripts/install.sh` is idempotent and supports `--domain`, `--skip-certbot`, `--stereotool-bypass`.

Install order:

1. Preflight (OS, CPU, RAM, disk, ports).
2. apt packages: `ffmpeg`, `icecast2`, `sqlite3`, `nginx`, `certbot`, `python3-certbot-nginx`, `curl`, `unzip`, `build-essential`.
3. Node.js 22 LTS via NodeSource; pnpm via corepack.
4. Create `radio` user; create `/srv/radio/{media,recordings,backups,logs,config,hls}`.
5. Copy/symlink media library; validate emergency loop file.
6. Install Thimeo binary/preset/license; detect edition; validate preset.
7. Write Icecast config from template; generate passwords into secrets file.
8. Initialize SQLite DB; run migrations; seed default station/playlists/settings.
9. Install systemd units; enable/start services.
10. Write nginx config; optional Certbot; reload nginx.
11. Run `scripts/smoke-test.sh`: health, Icecast mounts, tone through chain, UI reachable.
12. Print next steps (create admin user, scan media, generate first plans).

---

## 7. Playlist generator port (playlist_maker compatibility)

### 7.1 Mapping

| playlist_maker (PHP/AzuraCast)                | This project (TS/SQLite)                                       |
| --------------------------------------------- | -------------------------------------------------------------- |
| `StationPlaylist` `[PM] HH:00`                | `playlists` row + `schedule_slots` hour                        |
| `StationSchedule` (HHMM, days 1–7, loop_once) | `schedule_slots` (`hour`, `days_json`, `loop_once`)            |
| `StationPlaylistMedia` order                  | `plan_items` (position, media_id)                              |
| `data/state.json` settings                    | `schedule_settings` / `settings`                               |
| `data/state.json` template/overrides          | `schedule_settings` keys `template.base`, `template.overrides` |
| `data/state.json` generated plans             | `hourly_plans` + `plan_items` + `snapshot_json`                |
| `data/state.json` runs                        | `generator_runs` (add table) or `audit_log`                    |
| `news` media info                             | `media` rows + `news_paths` config                             |
| Fallback mode service                         | `schedule_settings` `fallback_mode` + UI toggle                |
| `GenerateTask` every minute                   | internal cron/timer (23:00 + 00:05)                            |
| `NewsReprocessTask` 5 min                     | internal timer                                                 |
| `PlaylistIntegrityTask` 5 min                 | internal timer + alerts                                        |

Add table:

```text
generator_runs(
  id, station_id, run_type, started_at, finished_at,
  mode, hours_json, status, warnings_json, error
)
```

### 7.2 Defaults (from playlist_maker)

```json
{
  "prefix": "[PM]",
  "news_path_hour": "Nieuws/nieuws-heel-uur.mp3",
  "news_path_half": "Nieuws/nieuws-half-uur.mp3",
  "news_reserve_seconds": 180,
  "separation_track_hours": 4,
  "separation_artist_hours": 1,
  "hour_min_seconds": 3540,
  "hour_max_seconds": 3720,
  "generate_hour_00_at": "23:00",
  "generate_rest_at": "00:05",
  "locale": "en",
  "disable_fallback_playlists": true,
  "auto_disable_legacy_news": true,
  "fallback_mode": false,
  "overrun_allowed_seconds": 90,
  "tail_window_seconds": 300,
  "tail_overrun_seconds": 45
}
```

Template blocks (minutes, half-open):

```json
[
  { "id": "news-00", "type": "news", "start": 0, "end": 3, "locked": true },
  { "id": "music-1", "type": "music", "start": 3, "end": 30, "rotation": "default" },
  { "id": "news-30", "type": "news", "start": 30, "end": 33, "locked": true },
  { "id": "music-2", "type": "music", "start": 33, "end": 60, "rotation": "default" }
]
```

### 7.3 Generation algorithm (ported)

1. Resolve air date for the target hour (hour 0 may belong to tomorrow).
2. Check on-air guard and past guard; skip if the hour is live or already past.
3. Build blocks from the template + per-hour overrides.
4. For each block:
   - News: resolve the configured news media; verify duration; reserve `news_reserve_seconds`.
   - Music: pick candidates from rotation playlists by role/weight; apply track/artist separation; use tail/closer/completer logic; allow overrun within limits; fall back to fill candidates; warn if a block cannot be filled.
5. Write `hourly_plans` + `plan_items` in a transaction; store `snapshot_json`.
6. Log `generator_runs`; dispatch alerts on warnings/errors.
7. Never modify the current hour or past hours; hour 0 for tomorrow is the only exception.

### 7.4 Boundary integration

The generator plans hours independently, as in playlist_maker. The **runtime scheduler** enforces the boundary rules in §6.4.5. This means:

- Plans may overrun their hour by up to 45 s (tail).
- The scheduler decides whether to let it finish, cut it, or start news early.
- Every decision is logged in `boundary_events`.
- The public schedule shows planned times, not live deviations; the admin schedule shows deviations.

### 7.5 Tests

- Port `tools/generator-sim.php` scenarios to Vitest.
- Golden tests: same fixture media + settings → same plan as the PHP generator (within documented tolerances).
- Cases: separation, tail/closer/completer, overrun, fill fallback, live hours, on-air guard, past guard, hour 0 at 23:00, DST transitions, fallback mode.
- Property tests: no track/artist violates separation; plan length within `hour_min/max`; news at :00 and :30.

---

## 8. Milestones and micro-steps

> Execution rule: work top to bottom within a milestone; run the verify step after each task; update `PROGRESS.md`; commit with a conventional message (`feat(M4): ...`). Do not move on until the milestone's acceptance criteria pass.

### Phase map (recommended delivery order)

| Phase                              | Milestones                                                 | Shippable outcome                                                                                      |
| ---------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Phase 0 — Walking skeleton**     | M0, M1, M4 (partial), M5 (partial), M13.1–M13.4            | A tone/music file plays through Stereo Tool to Icecast; `/listen` plays it; installable on a clean LXC |
| **Phase 1 — MVP**                  | M2, M3, M4 (complete), M5 (complete), M6, M9.1–M9.3, M11.1 | 24h automation, ST processing, 3 mounts + HLS, playout controls, public listen page                    |
| **Phase 2 — Live & admin**         | M7, M8, M9.4–M9.5, M10, M11.2–M11.5                        | Live studio, schedule/media/request UI, public API, auth/audit                                         |
| **Phase 3 — Production hardening** | M12, M14, M15, M13.5–M13.7                                 | Alerts, metrics, backups, CI, staging, docs, launch                                                    |

---

### M0 — Foundations and technical spikes

**Goal:** prove the risky parts (Thimeo streaming, Icecast HLS, live transport) before building features.

**Depends:** none.

- [ ] **M0.1 Scaffold monorepo**
  - Files: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `.gitignore`, `.env.example`, `PROGRESS.md`.
  - Setup pnpm workspaces, TypeScript project references, ESLint, Prettier, Vitest, Playwright.
  - **Verify:** `pnpm install`, `pnpm lint`, `pnpm typecheck` all pass on an empty skeleton.
- [ ] **M0.2 Repo skeleton**
  - Create `apps/api`, `apps/playout`, `apps/web`, `packages/core`, `packages/db`, `packages/shared`, `config`, `scripts`, `tests`, `docs/adr`.
  - Add README with local dev instructions.
  - **Verify:** `pnpm -r build` succeeds for placeholder packages.
- [ ] **M0.3 Dev environment**
  - Files: `docker-compose.dev.yml`, `scripts/dev.sh`.
  - Local Icecast 2.5 container; FFmpeg installed; a `mock-stereotool` passthrough script.
  - **Verify:** `pnpm dev` starts API + worker + Icecast; `curl localhost:8000/hq.mp3` returns audio after M0.4.
- [ ] **M0.4 Spike: FFmpeg PCM chain**
  - Generate a 1 kHz tone and a 30 s music fixture with FFmpeg.
  - Chain: FFmpeg decode → PCM pipe → mock ST → FFmpeg encode MP3 → Icecast.
  - Measure end-to-end latency and CPU.
  - Write `docs/adr/0001-ffmpeg-pcm-chain.md`.
  - **Verify:** tone is audible on `/hq.mp3`; latency recorded; no xruns over 10 minutes.
- [ ] **M0.5 Spike: Thimeo Stereo Tool CLI**
  - Determine exact `stereotool_cmd` flags for continuous PCM stdin/stdout; test preset load; test license check; detect edition.
  - Try stdio, FIFO, TCP in that order; document results and fallback.
  - Write `docs/adr/0002-stereotool-transport.md`.
  - **Verify:** a reproducible command block in the ADR; processed audio differs from input (spectrum/measurement); restart behavior documented.
- [ ] **M0.6 Spike: Icecast HLS**
  - Configure an Icecast 2.5/2.6 HLS mount; publish a test stream; play in Chrome/Firefox/Safari.
  - Measure latency; test nginx proxying.
  - Write `docs/adr/0003-icecast-hls.md`.
  - **Verify:** HLS plays in all target browsers; latency recorded; fallback plan documented.
  - **Result (2026-11-22):** upstream Icecast 2.5.0 has **no HLS** (release notes,
    docs and the 2.6 milestone confirm). Implemented and measured the fallback:
    FFmpeg HLS segmenter (AAC 96k, 2 s segments) + nginx; Chrome plays it,
    latency 2-14 s by player tuning (ADR 0003). Firefox/Safari still need a
    staging smoke test.
- [ ] **M0.7 Spike: live transport**
  - Evaluate LiveKit vs WebSocket Opus vs external Icecast ingest.
  - Measure glass-to-air latency and CPU on a 2 vCPU VM/container.
  - Write `docs/adr/0004-live-transport.md`.
  - **Verify:** a decision with measured numbers; a working demo of the chosen transport.
  - **Result (2026-11-22):** browser studio = **WebSocket PCM** (measured 0.89 ms avg
    arrival, 2 ms jitter, 0 gaps, ~773 kbps mono), external DJs = **Icecast ingest**
    (measured 47 ms median source->listener). LiveKit deferred (extra SFU on a
    2 vCPU host). ADR 0004.
- [ ] **M0.8 Spike: SQLite concurrency**
  - Test WAL + `better-sqlite3`/Drizzle with one writer (API) and one reader (worker) under load.
  - Write `docs/adr/0005-sqlite-wal.md`.
  - **Verify:** no `SQLITE_BUSY` under 50 writes/s + continuous reads; backup `.backup` works while reading.
- [ ] **M0.9 ADRs complete**
  - All ADRs have context, decision, consequences, and links.
  - **Verify:** `docs/adr/README.md` index exists; each ADR has a status.
- [x] **M0.10 Walking skeleton**
  - Minimal API `/api/health`, minimal worker that writes PCM to a mock ST, minimal web page that plays the stream.
  - **Verify:** `pnpm dev` → `/listen` plays tone; `curl /api/health` returns ok.
  - **Result (2026-11-22):** passed end to end. `pnpm dev` starts API (3001), playout worker
    and Vite (5173); `GET /api/health` → `{status: ok, boundaryToleranceSeconds: 45}`. The worker
    streams `data/fixtures/tone.wav` → FFmpeg decode (48 kHz/16-bit/stereo) → mock Stereo Tool
    → long-lived FFmpeg MP3 320k encoder → `icecast://…/hq.mp3`, using the ADR 0001 flags.
    Chrome clicked "Play live" on `/listen` (audio element on the Vite-proxied
    `/stream/hq.mp3`), `readyState` = have-metadata, `currentTime` advanced to 2.94 s, Stop
    button paused it, zero console errors. Out-of-band decode of the raw mount: 320 kb/s,
    48 kHz stereo, `mean_volume -24.1 dB / max_volume -21.0 dB`.
  - **New finding applied here:** FFmpeg's `icecast://` muxer warns "It seems you are streaming
    an unsupported format" for **MP3** too, because it only sniffs Ogg/WebM/Opus magic and
    defaults `content_type` to `audio/mpeg` without setting it. Passing `-content_type audio/mpeg`
    explicitly silences it (ADR 0001, "Second dev-host finding"); the engine must pass the
    content type on every mount — MP3 `audio/mpeg`, Opus `audio/ogg`, AAC `audio/aac`.

**M0 acceptance:**

- All spikes have ADRs with reproducible commands and measurements.
- A tone is audible through the real chain (with mock ST).
- CI skeleton runs lint/typecheck/build.

---

### M1 — Data model, configuration, and persistence

**Goal:** a solid foundation for all features.

**Depends:** M0.

- [x] **M1.1 Configuration schema**
  - Files: `packages/shared/src/config.ts`, `config/station.example.json`.
  - Zod schema for station, audio, stereotool, icecast, scheduler, live, requests, retention, backups, email, webhooks.
  - `config:validate` CLI.
  - **Verify:** valid config passes; each invalid field produces a precise error.
  - **Result (2026-11-22):** implemented and passing. `stationConfigSchema` (zod 3, pinned `^3.24.0`) covers
    station / audio / stereotool / icecast(+mounts+hls) / media / scheduler(generator, news, live) / requests /
    retention / backups / email / webhooks / alerts / metrics / users / web / worker / db, with
    `.strict()` objects and defaults for every optional key. `parseStationConfig` returns
    `{ok:true, config}` or `{ok:false, errors[]}`; `formatConfigErrors` prints `config.path.to.key: message (rule)`.
    Cross-field rules that zod 3 cannot express run after structural parsing:
    exactly one `primary` mount, `contentType` ↔ codec per ADR 0001 (`mp3→audio/mpeg`, `opus→audio/ogg`,
    `aac→audio/aac`), mount extension ↔ codec, unique mount/nas/webhook ids, `backups.dir == db.backupDir`,
    `icecast.port != worker.protocolPort`, `hourMinSeconds <= hourMaxSeconds`.
    Secrets stay out of the JSON: every `*Env` key is validated as an env-var NAME
    (`^[A-Z][A-Z0-9_]{2,}$`), and the CLI lists them plus a warning when they are not in the shell.
    HLS defaults **off** (ADR 0003 owner confirmation). Verified: example config OK (exit 0); a
    deliberately broken config produced 7 precise structural errors; a structurally valid config
    produced 6 cross-field problems; 5 new vitest cases in `packages/shared/src/config.test.ts`.
- [ ] **M1.2 Database schema**
  - Files: `packages/db/src/schema.ts`, `packages/db/drizzle/`.
  - All tables from §6.3; indexes; constraints; `generator_runs`.
  - **Verify:** `pnpm db:migrate` on an empty SQLite file creates all tables; `PRAGMA integrity_check` = ok.
- [ ] **M1.3 Seed**
  - Create default station, 24 playlists (`[PM] 00:00`…`[PM] 23:00`), schedule slots, decade playlists (`00s`–`90s`), `General`, `Nieuws`, default settings/template, emergency playlist placeholder.
  - Bootstrap admin user from `ADMIN_USERNAME`/`ADMIN_PASSWORD` env (or CLI).
  - **Verify:** fresh DB has 24 schedule slots; login as admin works.
- [ ] **M1.4 Repositories**
  - Typed repositories for media, playlists, plans, users, sessions, requests, alerts, audit, stats, settings.
  - All queries parameterized; station scoping enforced.
  - **Verify:** repository unit tests with an in-memory/temp DB.
- [ ] **M1.5 Settings service**
  - Typed getters/setters; change history via `audit_log`; hot-reload for playout settings via worker `settings:reload`.
  - **Verify:** changing a setting writes an audit entry; worker receives the update.
- [ ] **M1.6 CLI**
  - `pnpm db:migrate`, `db:seed`, `db:backup`, `db:restore`, `config:validate`, `user:create`, `media:scan`.
  - **Verify:** `db:backup` then `db:restore` round-trip preserves users/plans.
- [ ] **M1.7 Tests**
  - Unit tests for schema constraints, repositories, config validation, backup/restore.
  - **Verify:** `pnpm test` green.

**M1 acceptance:**

- Fresh install creates a complete DB.
- Config validation and backup/restore work.
- Admin can log in.

---

### M2 — Media library and ingestion

**Goal:** get audio files into the system with tags, loudness, artwork, duplicates, and uploads.

**Depends:** M1.

- [ ] **M2.1 Folder scanner**
  - Recursive scan of media root and configured NAS paths; ignore `.git`, `@eaDir`, temp files.
  - Supported extensions: `.mp3`, `.flac`, `.m4a`, `.aac`, `.ogg`, `.opus`, `.wav`.
  - Extract tags/duration via `music-metadata`; fallback to `ffprobe`.
  - **Verify:** scan a fixture tree of 100 files; all rows created; missing tags flagged.
- [ ] **M2.2 Artwork**
  - Extract embedded artwork to `/srv/radio/artwork/<hash>.<ext>`; serve via API.
  - **Verify:** artwork URL returns an image; fallback placeholder when absent.
- [ ] **M2.3 Hash and duplicates**
  - Hash first 5 MB + size + duration; near-duplicate check by normalized title/artist/duration.
  - Duplicate groups API; merge/ignore actions.
  - **Verify:** duplicate fixture is detected; false-positive test passes.
- [ ] **M2.4 Loudness**
  - FFmpeg `ebur128` or `loudnorm` two-pass; store `loudness_lufs`, `peak_db`, `gain_db` to target `-16 LUFS`.
  - Do not modify originals by default.
  - **Verify:** known test file measures within ±0.5 LU; gain applied at playback in M4 test.
- [ ] **M2.5 Watch folder**
  - `chokidar` watcher with 2 s debounce; queue imports; status in UI.
  - **Verify:** dropping a file auto-imports within 5 s.
- [ ] **M2.6 Web upload**
  - Fastify multipart; size/type validation; store under `media/Inbox`; trigger scan/import.
  - **Verify:** upload a 10 MB MP3; progress shown; media appears in library.
- [ ] **M2.7 Tag editor and metadata lookup**
  - PATCH tags; artwork replace; MusicBrainz/Last.fm lookup; suggestion review queue.
  - **Verify:** edit title/artist; artwork updates; suggestion can be applied/rejected.
- [ ] **M2.8 Search/query API**
  - Filters: artist, title, album, duration, loudness, status, duplicates; pagination.
  - **Verify:** query returns correct results under 100 ms on 10k rows.
- [ ] **M2.9 Tests**
  - Fixture-based tests for scanner, tags, loudness, duplicates, upload validation.
  - **Verify:** `pnpm test` green; coverage for media services > 80%.

**M2 acceptance:**

- Scan 1,000 files in < 60 s.
- Upload + tag edit + artwork works.
- Loudness values stored and used by playback.
- Duplicates detected.

---

### M3 — Port the 24×1h generator

**Goal:** reproduce playlist_maker behavior in TypeScript and store plans.

**Depends:** M1, M2.

- [ ] **M3.1 Types and settings**
  - Port `StateStore`, `StationContext`, `Template`, `Overrides`, settings defaults.
  - **Verify:** loading defaults matches playlist_maker defaults.
- [ ] **M3.2 Separation tracker**
  - Port `SeparationTracker` with track 4h / artist 1h; timezone-aware.
  - **Verify:** unit tests for boundary cases (exactly 4h, DST).
- [ ] **M3.3 Generator**
  - Port `Generator`: blocks, tail candidates, closer, completer, fill candidates, overrun constants, playcount penalties, warnings.
  - **Verify:** same fixture input produces equivalent plan to PHP generator (golden tests).
- [ ] **M3.4 Plan persistence**
  - Write `hourly_plans` + `plan_items`; snapshot JSON; transaction.
  - **Verify:** reload plan returns identical items/order.
- [ ] **M3.5 Triggers and guards**
  - Internal timer: 23:00 generate hour 0 tomorrow; 00:05 generate hours 1–23 today.
  - On-air guard; past guard; live hour skip; missed-trigger catch-up.
  - **Verify:** simulate clock at 22:59/23:00/00:04/00:05; correct plans created; current hour untouched.
- [ ] **M3.6 News and integrity**
  - News reprocess every 5 min; update media length; regenerate future plans if changed.
  - Integrity check every 5 min: 24 slots, next 24h coverage, missing plans; alerts.
  - **Verify:** change news file length; next plans regenerate; missing plan raises alert.
- [ ] **M3.7 CLI and preview**
  - `pnpm generate --date ... --dry-run`, `preview --hours 0,1`.
  - API `POST /api/schedule/generate`, `GET /api/plans/:date/:hour`.
  - **Verify:** dry-run prints track-by-track plan; no DB writes in dry-run.
- [ ] **M3.8 Tests**
  - Port generator simulation scenarios; add boundary, fallback, live, DST, separation, overrun tests.
  - **Verify:** `pnpm test` green; golden plan diff documented.

**M3 acceptance:**

- 24 hours of plans generated for a full day.
- Separation and overrun rules match playlist_maker.
- On-air/past guards work.
- Fallback mode toggles correctly.
- Generator is deterministic for the same inputs.

---

### M4 — Playout core: decks, mixer, scheduler

**Goal:** the heart of the system — play audio, mix it, and follow the plan with boundary rules.

**Depends:** M1, M3.

- [ ] **M4.1 Audio utilities**
  - PCM ring buffer, int16↔float conversion, gain/fade envelopes, soft limiter, RMS/peak meters.
  - **Verify:** unit tests for gain, fade curves, clipping, meter accuracy.
- [ ] **M4.2 Deck**
  - FFmpeg decode to PCM; cue in/out; duration; pause/resume/seek/stop; EOF/error handling.
  - **Verify:** play a fixture track; skip; pause at 10 s; resume; position accurate ±50 ms.
- [ ] **M4.3 Mixer**
  - Decks + live/voice-over/event/emergency buses; gains; ducking envelope; master fader; limiter; output callback.
  - **Verify:** mix two tones at -6 dB each; no clipping; ducking depth matches config.
- [ ] **M4.4 Scheduler runtime**
  - Load current plan; queue; start items; handle hour change; live/event/interrupt states; request insertion.
  - **Verify:** simulated clock crosses hour boundaries; correct plans/items; queue transitions.
- [ ] **M4.5 Boundary rules**
  - Implement §6.4.5 exactly; log `boundary_events`.
  - **Verify:** table-driven tests for every case: early end, overrun within tolerance, overrun beyond tolerance, no new track within tolerance, exact boundary, live override.
- [ ] **M4.6 Emergency and fallback**
  - Silence detector; ST/encoder failure handling; emergency loop; alert; recovery.
  - **Verify:** mute input → emergency within 10 s; restore → auto-recover; kill ST → bypass/restart.
- [ ] **M4.7 Worker protocol**
  - Unix socket server; command validation; event broadcast; heartbeat; reconnect.
  - **Verify:** API client connects; commands round-trip; malformed JSON rejected.
- [ ] **M4.8 Integration test**
  - Worker + mock ST + Icecast + FFmpeg; assert audio at mount; test skip/pause/live duck.
  - **Verify:** `pnpm test:integration` green.

**M4 acceptance:**

- Audio plays continuously with no gaps.
- Skip/pause/resume/seek work from API.
- Boundary rules pass all cases.
- Silence triggers emergency.
- Worker restarts without corrupting state.

---

### M5 — Audio output chain: Stereo Tool, encoders, Icecast

**Goal:** real processed audio on all public mounts, with resilience.

**Depends:** M4.

- [ ] **M5.1 Stereo Tool adapter**
  - Implement the chosen transport from M0.5; start/stop/restart; health; edition detection; license check; bypass.
  - **Verify:** processed audio on all mounts; kill ST → restart; repeated failure → bypass + alert.
- [ ] **M5.2 Encoder hub**
  - Per-mount FFmpeg; fan-out; restart; backpressure; stats; startup validation tone.
  - **Verify:** all mounts audible; kill one encoder → restart; queue never overflows.
- [ ] **M5.3 Icecast configuration**
  - Template generator; mounts; passwords; stats; source auth; CORS.
  - **Verify:** Icecast starts; all mounts appear in status; stats JSON parses.
- [ ] **M5.4 HLS**
  - Native HLS (or documented fallback); nginx route; browser playback.
  - **Verify:** HLS plays in Chrome/Firefox/Safari; latency within target.
- [ ] **M5.5 Benchmark and tuning**
  - 24h soak on 2 vCPU; measure CPU/RAM per process; tune buffers.
  - **Verify:** CPU < 50%; no xruns; no memory growth over 24h.
- [ ] **M5.6 Failover**
  - Mount fallback; source reconnect; alert thresholds.
  - **Verify:** kill Icecast → encoders reconnect when it returns; alerts fire.

**M5 acceptance:**

- HQ MP3, mobile MP3, Opus, AAC, HLS all playable.
- Stereo Tool processing is active and observable.
- Encoder/ST failures auto-recover or bypass with alerts.
- CPU headroom on a small LXC.

---

### M6 — Interactive control API and worker commands

**Goal:** expose every playout control safely and in real time.

**Depends:** M4.

- [ ] **M6.1 REST control endpoints**
  - Skip, pause, resume, stop, seek, queue list/move/remove/insert, play-now, voice-over, replay-last, fader, emergency.
  - **Verify:** each endpoint changes worker state; response includes new state.
- [ ] **M6.2 WebSocket events**
  - Publish `playout:state`, `now_playing`, `queue`, `meter`, `live:status`, `encoders:status`, `alerts:new`, `requests:new`.
  - **Verify:** client receives updates < 200 ms after an action.
- [ ] **M6.3 Command safety and audit**
  - Validate commands; serialize conflicting commands; rate-limit; audit every action.
  - **Verify:** rapid skip commands do not corrupt queue; audit entries correct.
- [ ] **M6.4 Request integration**
  - Approved request → `insert_request` command; play-next vs next-hour.
  - **Verify:** approved request plays at the right position; status updates to played.
- [ ] **M6.5 Events**
  - Create/start/stop scheduled events; priority preemption; resume after.
  - **Verify:** high-priority event interrupts; lower-priority waits; automation resumes.
- [ ] **M6.6 Triggers (MIDI/Stream Deck)**
  - `POST /api/triggers/:id` with API key; maps to configured action.
  - Optional local MIDI listener (note/CC) and Stream Deck URL buttons.
  - **Verify:** trigger fires skip/play-now/live; unauthorized request rejected.
- [ ] **M6.7 Tests**
  - API tests for all endpoints; worker protocol tests; WS tests.
  - **Verify:** `pnpm test` green; OpenAPI validates.

**M6 acceptance:**

- All controls work via REST and WS.
- Every control action is audited.
- Requests and events integrate with the playout queue.
- Triggers work and are secured.

---

### M7 — Authentication, RBAC, 2FA, audit

**Goal:** secure multi-user operation.

**Depends:** M1, M6.

- [ ] **M7.1 Users and passwords**
  - Argon2id; user CRUD; deactivate; role assignment.
  - **Verify:** login with correct/wrong password; deactivated user denied.
- [ ] **M7.2 Sessions and CSRF**
  - Opaque tokens; HttpOnly/Secure/SameSite cookies; rotation; logout everywhere.
  - CSRF double-submit for mutations.
  - **Verify:** stolen token revoked; CSRF request rejected.
- [ ] **M7.3 RBAC**
  - Permission matrix; server-side enforcement; API key scopes.
  - **Verify:** DJ cannot access users/settings; operator cannot access users; admin can.
- [ ] **M7.4 TOTP 2FA**
  - Setup, enable, disable, recovery codes.
  - **Verify:** login requires TOTP when enabled; recovery code works once.
- [ ] **M7.5 Password reset**
  - SMTP send; token expiry; one-time use.
  - **Verify:** reset email arrives; token expires; reuse rejected.
- [ ] **M7.6 Audit log**
  - Append-only; filter API; UI viewer.
  - **Verify:** control/settings actions appear with user/IP/time.
- [ ] **M7.7 API keys**
  - Create/revoke; scopes; last-used.
  - **Verify:** valid key works; revoked key 401; scope enforced.
- [ ] **M7.8 Tests**
  - Auth/RBAC integration tests.
  - **Verify:** `pnpm test` green.

**M7 acceptance:**

- Three roles enforced.
- 2FA and password reset work.
- Audit trail complete.
- No secrets in logs.

---

### M8 — Live studio

**Goal:** a DJ can go live from a browser with low latency and recording.

**Depends:** M4, M7.

- [ ] **M8.1 Transport implementation**
  - Implement the chosen transport from M0.7; server-side session management.
  - **Verify:** DJ audio reaches the mixer; latency measured < 500 ms (or documented target).
- [ ] **M8.2 Browser studio**
  - Mic permission, device selection, gain, mute, input meter, network status.
  - **Verify:** Chrome/Edge/Firefox/Safari can connect; no feedback.
- [ ] **M8.3 Mixer live integration**
  - Live bus; ducking/takeover; go-live countdown; end-live fade; resume automation.
  - **Verify:** ducking depth and release match config; takeover resumes correctly.
- [ ] **M8.4 External encoder and line-in**
  - Icecast `/live` ingest; FFmpeg pull; ALSA capture optional.
  - **Verify:** BUTT/Mixxx can connect; audio reaches output; line-in works if device available.
- [ ] **M8.5 Recording**
  - Mix live + bed to FLAC/WAV; metadata; 30-day retention.
  - **Verify:** recording plays back; file size sane; retention job deletes old files.
- [ ] **M8.6 Cue and next-track preview**
  - Preview next track in the browser (30 s) without affecting output.
  - **Verify:** preview audio plays; output unaffected.
- [ ] **M8.7 DJ shift reports**
  - Store `live_sessions`; report per DJ.
  - **Verify:** report lists sessions, duration, peak listeners.
- [ ] **M8.8 Tests**
  - Live transport tests; fake mic E2E; recording tests.
  - **Verify:** `pnpm test:e2e` live flow green.

**M8 acceptance:**

- Single DJ can go live and be heard with low latency.
- Music ducks and restores correctly.
- Recording works and expires after 30 days.
- External encoder fallback works.
- No audio feedback.

---

### M9 — Admin UI shell and playout console

**Goal:** operators can run the station from the browser.

**Depends:** M6, M7.

- [ ] **M9.1 UI scaffold**
  - Vite + React + TS + Tailwind + shadcn/ui; router; auth guard; dark theme; i18n scaffold; error/empty states.
  - **Verify:** `/admin` loads; unauthenticated redirects to `/login`.
- [ ] **M9.2 Dashboard**
  - Now playing, station status, listener count, alerts, quick stats, quick actions.
  - **Verify:** dashboard reflects live state within 200 ms.
- [ ] **M9.3 Playout console**
  - Transport, queue DnD, play-now, voice-over, fader, meters, emergency, boundary log, keyboard shortcuts.
  - **Verify:** operator can run a full hour; all controls work; state survives refresh.
- [ ] **M9.4 Live studio page**
  - Mic controls, meters, ducking, record, cue preview, go-live.
  - **Verify:** DJ flow works end-to-end; mobile layout usable.
- [ ] **M9.5 Settings shell**
  - Station, audio, Stereo Tool, Icecast, requests, retention, backups, email/webhooks.
  - **Verify:** settings save; worker reloads audio settings.
- [ ] **M9.6 Accessibility and responsiveness**
  - Keyboard navigation, ARIA, focus states, contrast; tablet layout.
  - **Verify:** axe/Lighthouse a11y > 90; no console errors.

**M9 acceptance:**

- An operator can run a show entirely from the UI.
- Controls are fast, safe, and recover from errors.
- UI is accessible and responsive.

---

### M10 — Schedule, playlist, media, requests, events UI

**Goal:** complete the admin workflows.

**Depends:** M9.

- [ ] **M10.1 Schedule grid**
  - 24 rows; current hour highlighted; per-hour override; live toggle; lock; fallback mode; boundary log.
  - **Verify:** edit hour 14; reload; correct playlist/live state.
- [ ] **M10.2 Playlists and generator**
  - Playlist CRUD; item ordering; generator preview; generate; warnings.
  - **Verify:** preview shows track-by-track plan; generate writes plans; warnings visible.
- [ ] **M10.3 Media library**
  - Virtualized table; filters; upload; tag editor; artwork; duplicates; loudness.
  - **Verify:** search/filter; edit tags; upload; duplicate review.
- [ ] **M10.4 Request moderation**
  - Queue; approve/reject/play-next; blacklist; auto-approve toggle; listener status.
  - **Verify:** approve → plays; reject → status; blacklist blocks.
- [ ] **M10.5 Events**
  - Create/start/stop events; priority; schedule.
  - **Verify:** event preempts; ends; resumes.
- [ ] **M10.6 Alerts center**
  - Active/history; acknowledge; severity filters.
  - **Verify:** test alert appears; ack persists.
- [ ] **M10.7 E2E tests**
  - Playwright flows for schedule, media, requests, events.
  - **Verify:** E2E suite green.

**M10 acceptance:**

- All admin workflows are usable without the API.
- Data persists across reloads.
- E2E tests cover the main paths.

---

### M11 — Public listen site and public API

**Goal:** listeners can listen, see the schedule, and request songs.

**Depends:** M5, M6, M7.

- [ ] **M11.1 `/listen` page**
  - Dark branded player; now-playing; artwork; volume; listeners; links to schedule/requests.
  - **Verify:** plays HQ/mobile/Opus; falls back to HLS if needed; mobile works.
- [ ] **M11.2 Schedule and history**
  - Public 24h schedule; recently played.
  - **Verify:** schedule matches plans; history updates after tracks.
- [ ] **M11.3 Request form**
  - Artist/title search; optional message/dedication; name/contact; profanity filter; cooldown; status.
  - **Verify:** submit → pending; blacklisted word rejected; cooldown enforced; status visible.
- [ ] **M11.4 Public API**
  - `now-playing`, `schedule`, `history`, `POST requests`; rate limits; CORS.
  - OpenAPI at `/api/docs`.
  - **Verify:** curl examples work; rate limit returns 429; OpenAPI validates.
- [ ] **M11.5 API keys for partners**
  - Create/read/revoke; stats endpoint.
  - **Verify:** key auth works; stats JSON correct.
- [ ] **M11.6 Public docs**
  - `docs/api.md` with examples.
  - **Verify:** examples run against staging.

**M11 acceptance:**

- Public page plays and looks good on mobile.
- Requests work and are moderated.
- Public API is documented and rate-limited.

---

### M12 — Alerts, metrics, backups, retention

**Goal:** production operations.

**Depends:** M6, M7.

- [ ] **M12.1 Alerts**
  - In-app, email, webhook, syslog; severity; throttling; acknowledgement.
  - **Verify:** each channel receives a test alert; duplicates throttled.
- [ ] **M12.2 Prometheus metrics**
  - `/metrics`: listeners, uptime, encoder restarts, ST status, boundary deviations, request counts, queue depth.
  - **Verify:** `promtool`/curl parses; Grafana dashboard JSON included.
- [ ] **M12.3 Stats**
  - Listener polling; mount breakdown; play history; airplay analytics; CSV export; DJ shift reports.
  - **Verify:** charts match Icecast stats; CSV opens correctly.
- [ ] **M12.4 Backups**
  - Daily SQLite `.backup`; 14 daily / 8 weekly; verify; restore drill.
  - **Verify:** backup file valid; restore into a temp DB; station data intact.
- [ ] **M12.5 Retention**
  - History 90 days, logs 30 days, requests 30 days, recordings 30 days; configurable.
  - **Verify:** seeded old rows are deleted; recent rows remain.
- [ ] **M12.6 Health/readiness**
  - `/api/health`, `/api/ready`; checks DB, worker socket, Icecast, ST, encoders.
  - **Verify:** readiness fails when worker down; recovers when up.

**M12 acceptance:**

- Alerts reach all configured channels.
- Metrics scrape cleanly.
- Backup/restore works.
- Retention jobs run and log.

---

### M13 — Deployment automation

**Goal:** one-command install on a clean Debian 13 LXC.

**Depends:** M5, M7 (can start earlier for Phase 0).

- [ ] **M13.1 `install.sh`**
  - Preflight, packages, user/dirs, Node/pnpm, DB init, media config, ST install/detect, Icecast config, systemd, nginx, optional Certbot, smoke test.
  - **Verify:** run twice; second run is idempotent; no errors.
- [ ] **M13.2 systemd units**
  - `radio-api`, `radio-playout`, `radio-icecast`, `radio-stereotool`, `radio-backup.timer`, `radio-backup.service`.
  - Restart policies; dependency ordering; logs to journald.
  - **Verify:** `systemctl --failed` empty; reboot → all services start.
- [ ] **M13.3 nginx + TLS**
  - Proxy API/WS/UI/streams/HLS; Certbot optional; security headers.
  - **Verify:** HTTPS works; WebSocket upgrades; HLS plays through nginx.
- [ ] **M13.4 Icecast config**
  - Template with mounts/passwords/HLS; permissions.
  - **Verify:** fresh install starts Icecast; all mounts listed.
- [ ] **M13.5 LXC specifics**
  - Unprivileged container notes; no ALSA required for core path; optional line-in passthrough; resource limits.
  - **Verify:** install on a clean Debian 13 LXC template.
- [ ] **M13.6 Upgrade/uninstall**
  - `upgrade.sh` preserves DB/media/config; migrations; rollback notes.
  - `uninstall.sh` stops services; optional purge.
  - **Verify:** upgrade from previous version preserves data; uninstall leaves no processes.
- [ ] **M13.7 Smoke test**
  - `scripts/smoke-test.sh`: health, mounts, tone, UI, API, HLS.
  - **Verify:** script exits 0 on a fresh install.

**M13 acceptance:**

- Clean install in < 30 minutes.
- Reboot survives.
- Upgrade preserves data.
- Smoke test passes.

---

### M14 — Testing, CI, staging

**Goal:** confidence to change the system safely.

**Depends:** all feature milestones.

- [ ] **M14.1 Unit tests**
  - Generator, boundary rules, queue, mixer math, auth, config, repositories.
  - **Verify:** coverage thresholds met (e.g. 80% lines on `packages/*`).
- [ ] **M14.2 Audio integration tests**
  - Real FFmpeg + Icecast + mock ST in Docker; assert audio at mounts; skip/pause/duck; ST failure.
  - **Verify:** `pnpm test:integration` green on Linux CI.
- [ ] **M14.3 E2E tests**
  - Playwright: login, playout, schedule, media, requests, live studio (fake mic).
  - **Verify:** E2E suite green; screenshots/videos on failure.
- [ ] **M14.4 CI pipeline**
  - GitHub Actions: lint, typecheck, unit, build, integration, E2E (staging), dependency audit.
  - **Verify:** CI green on PR; branch protection.
- [ ] **M14.5 Staging environment**
  - Separate ports/DB/ Icecast mounts; `NODE_ENV=staging`; ST bypass allowed.
  - **Verify:** staging deploy from CI; no impact on production data.
- [ ] **M14.6 Load test**
  - Simulated listeners/requests; check API/WS/DB under load.
  - **Verify:** p95 API < 200 ms; no errors at target listener count.

**M14 acceptance:**

- CI is green and required.
- Staging deploy is one click.
- Integration/E2E cover the critical flows.

---

### M15 — Hardening, documentation, launch

**Goal:** production-ready and maintainable.

**Depends:** M14.

- [ ] **M15.1 Security review**
  - Dependency audit; secrets scan; headers; RBAC review; upload review; Icecast exposure.
  - **Verify:** no high/critical findings; exceptions documented.
- [ ] **M15.2 Performance pass**
  - 24h soak; CPU/RAM; disk I/O; latency; restart behavior.
  - **Verify:** within budgets; no leaks; recovery times documented.
- [ ] **M15.3 Documentation**
  - `README.md`, `docs/admin-guide.md`, `docs/api.md`, `docs/runbook.md`, ADR index, install/upgrade guide.
  - **Verify:** a new operator can follow the guide to run a show.
- [ ] **M15.4 Backup/restore drill**
  - Simulate DB loss; restore; verify station resumes.
  - **Verify:** RTO/RPO recorded; drill passes.
- [ ] **M15.5 Licensing and notices**
  - `NOTICE` for third-party components; Thimeo is commercial and not redistributed; GPL/LGPL obligations for FFmpeg/Icecast reviewed.
  - **Verify:** legal review checklist complete.
- [ ] **M15.6 Launch checklist**
  - Domain, TLS, Icecast passwords, admin account, media scan, first 24h plans, emergency loop, monitoring, backup schedule.
  - **Verify:** checklist signed off; smoke test passes.

**M15 acceptance:**

- Security/performance/docs complete.
- Restore drill passes.
- Launch checklist signed.

---

## 9. Testing strategy

### 9.1 Unit tests (Vitest)

- `packages/core`: generator, separation, boundary rules, queue transitions, loudness math.
- `packages/db`: repositories, migrations, backup/restore.
- `apps/api`: route validation, RBAC, rate limits.
- `apps/playout`: mixer math, deck state machine, ST adapter with a fake process.

### 9.2 Audio integration tests

- Docker Compose: Icecast + FFmpeg + mock ST + worker.
- Generate fixtures: 1 kHz tone, silence, music with known LUFS, corrupt file.
- Assertions:
  - Audio reaches each mount (HTTP range read, decode with FFmpeg, check RMS).
  - Skip/pause/resume change output within tolerance.
  - Silence triggers emergency within configured time.
  - ST kill → bypass/restart.
  - Encoder kill → restart.

### 9.3 E2E tests (Playwright)

- Login as admin/dj/operator.
- Skip/pause/play-now/voice-over.
- Create a schedule override; reload; verify.
- Upload media; edit tags; search.
- Submit a request; approve; verify it plays.
- Live studio with fake mic (`--use-fake-device-for-media-stream`).
- Public listen page plays.

### 9.4 CI

GitHub Actions jobs:

1. `lint` — ESLint, Prettier.
2. `typecheck` — `tsc --noEmit`.
3. `unit` — Vitest.
4. `build` — all packages.
5. `integration` — Linux, FFmpeg/Icecast, audio tests.
6. `e2e` — Playwright against staging build.
7. `audit` — `pnpm audit`, secret scan.

Branch protection: required checks, no direct pushes to `main`.

### 9.5 Staging

- Separate ports: API 3002, Icecast 8002, nginx 8443.
- Separate DB file and media root.
- ST bypass by default; enable only for ST-specific tests.
- Deploy from CI on `main` to staging; production manual with approval.

---

## 10. Operations runbook

### 10.1 Service commands

```bash
systemctl status radio-api radio-playout radio-icecast radio-stereotool
journalctl -u radio-playout -f
journalctl -u radio-api -f
curl -s localhost:3001/api/health | jq
curl -s localhost:3001/api/ready | jq
```

### 10.2 Common incidents

| Symptom          | Check                                           | Action                                                        |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| Dead air         | `boundary_events`, mixer meters, encoder status | Check emergency mode; restore automation; check ST/encoder    |
| Stereo Tool down | `journalctl -u radio-stereotool`                | Restart; if repeated, bypass + alert; validate license/preset |
| Encoder down     | `journalctl -u radio-playout`                   | Check Icecast; restart encoder; check password                |
| Icecast down     | `systemctl status radio-icecast`                | Restart; check config; check port                             |
| Live no-show     | Live schedule; alerts                           | Grace period; fallback playlist; alert DJ                     |
| Listener drop    | Icecast stats; nginx logs                       | Check mount; check bandwidth; restart encoder                 |
| Disk full        | `df -h`                                         | Clean recordings/logs; expand disk; check backups             |

### 10.3 Backup/restore

```bash
pnpm db:backup
pnpm db:restore --file /srv/radio/backups/radio-YYYY-MM-DD.sqlite3
systemctl restart radio-api radio-playout
```

### 10.4 Upgrades

```bash
git pull
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
systemctl restart radio-api radio-playout
scripts/smoke-test.sh
```

Rollback: restore DB backup, redeploy previous git tag, restart services.

---

## 11. Risk register

| Risk                                      | Impact                 | Likelihood | Mitigation                                                                     |
| ----------------------------------------- | ---------------------- | ---------- | ------------------------------------------------------------------------------ |
| Thimeo CLI cannot stream PCM continuously | Blocks ST integration  | Medium     | M0.5 spike; FIFO/TCP/ALSA fallbacks; bypass mode                               |
| Thimeo license/edition mismatch           | ST won't start         | Low        | Detect at install; validate license; clear error                               |
| LiveKit Node PCM API unavailable          | Higher live latency    | Medium     | M0.7 spike; WebSocket Opus fallback; document trade-off                        |
| FFmpeg per-track process overhead         | CPU/glitches           | Medium     | 48 kHz, 64-sample mixing, 2 vCPU budget; benchmark; reuse decks                |
| SQLite write contention                   | Errors under load      | Low        | Single writer API; WAL; busy timeout; queue writes                             |
| Icecast HLS version/config issues         | HLS unavailable        | Medium     | Verify 2.5/2.6; FFmpeg HLS fallback                                            |
| LXC lacks ALSA/device access              | Line-in unavailable    | Medium     | Core path uses pipes only; line-in optional; document passthrough              |
| DST/timezone bug                          | Wrong hour/news timing | Medium     | Luxon; DST tests; store UTC; display station time                              |
| News timing drift                         | Missed news            | Medium     | Boundary rules; tolerance; `boundary_events` logging; alerts                   |
| Request spam/abuse                        | Moderation load        | High       | Rate limit, profanity filter, blacklist, cooldown, auto-approve off by default |
| Scope creep                               | Delayed MVP            | High       | Phase map; MVP cut line; feature flags for non-MVP items                       |
| Thimeo redistribution/licensing           | Legal issue            | Low        | Do not ship binary/preset; NOTICE; user installs with license                  |
| Secrets leakage                           | Security incident      | Low        | Secrets file 0600; no secrets in git; audit; CI secret scan                    |
| 2 vCPU overload with 4 encoders + ST      | Audio dropouts         | Medium     | Measure; reduce to 3 mounts if needed; HLS from same mount; CPU limits         |

---

## 12. Open questions / decisions to confirm during execution

These are not blockers for starting, but must be resolved before the related milestone:

1. **Exact Thimeo Stereo Tool edition and build** (Standard/Professional) — detect at install; record in config.
2. **Exact Thimeo streaming method** — M0.5 decides stdio/FIFO/TCP; ADR records it.
3. **Icecast exact package version on Debian 13** — install the newest 2.5.x/2.6; verify HLS.
4. **Live transport** — M0.7 decides LiveKit vs WebSocket Opus; record latency/CPU.
5. **Domain name** — placeholder `radio.example.com` until provided; Certbot optional.
6. **SMTP and webhook endpoints** — placeholders in config; fill at deployment.
7. **Station branding** — name, logo, colors; placeholders until provided.
8. **Emergency loop file** — user-provided path; validate at install/startup.
9. **Live no-show behavior** — default: 2-minute grace, then fallback playlist + alert; configurable.
10. **Request auto-approve default** — off (moderation required); blacklist applies when on.
11. **Recording format** — FLAC default (lossless, moderate size); configurable to WAV/MP3.
12. **Public API rate limits** — default 60 req/min per IP; tune after load test.
13. **Listener concurrent target** — small LXC assumes up to ~500; load test to confirm.
14. **License choice** — GitHub private, license TBD; recommend MIT for our code, with third-party notices.
15. **Crossfade** — explicitly out of v1; revisit only if per-track fades prove insufficient.

---

## Appendix A — Configuration example

```json
{
  "station": {
    "id": 1,
    "name": "STATION_NAME",
    "timezone": "Europe/Amsterdam",
    "locale": "en",
    "logoUrl": "/branding/logo.png",
    "colors": { "primary": "#22c55e", "background": "#0b0f0e" }
  },
  "audio": {
    "sampleRate": 48000,
    "channels": 2,
    "format": "s16le",
    "mixFrames": 64,
    "bufferMs": 100,
    "masterGain": 1.0,
    "targetLufs": -16,
    "boundaryToleranceSeconds": 45,
    "silenceThresholdDb": -60,
    "silenceSeconds": 10,
    "emergencyFile": "/srv/radio/media/Emergency/emergency-loop.mp3"
  },
  "stereotool": {
    "enabled": true,
    "binary": "/opt/stereotool/stereotool_cmd",
    "preset": "/etc/radio/stereotool.sds",
    "license": "/opt/stereotool/stereotool.lic",
    "inputMode": "stdio-pcm",
    "restart": { "maxAttempts": 5, "backoffMs": 2000 },
    "bypassOnFailure": true
  },
  "icecast": {
    "host": "127.0.0.1",
    "port": 8000,
    "sourcePasswordEnv": "ICECAST_SOURCE_PASSWORD",
    "adminUser": "admin",
    "adminPasswordEnv": "ICECAST_ADMIN_PASSWORD",
    "mounts": [
      { "name": "hq.mp3", "codec": "mp3", "bitrate": "320k", "public": true },
      { "name": "mobile.mp3", "codec": "mp3", "bitrate": "128k", "public": true },
      { "name": "opus.ogg", "codec": "opus", "bitrate": "96k", "public": true },
      { "name": "aac.aac", "codec": "aac", "bitrate": "96k", "public": true }
    ],
    "hls": { "enabled": true, "mount": "/hls" }
  },
  "scheduler": {
    "generator": {
      "generateHour00At": "23:00",
      "generateRestAt": "00:05",
      "separationTrackHours": 4,
      "separationArtistHours": 1,
      "hourMinSeconds": 3540,
      "hourMaxSeconds": 3720,
      "overrunAllowedSeconds": 90,
      "tailWindowSeconds": 300,
      "tailOverrunSeconds": 45,
      "newsReserveSeconds": 180
    },
    "news": {
      "hour": "Nieuws/nieuws-heel-uur.mp3",
      "half": "Nieuws/nieuws-half-uur.mp3"
    },
    "live": {
      "maxConcurrent": 1,
      "duckDb": -12,
      "duckAttackMs": 50,
      "duckReleaseMs": 500,
      "noShowGraceSeconds": 120,
      "noShowFallbackPlaylistId": null
    }
  },
  "requests": {
    "autoApprove": false,
    "cooldownMinutes": 60,
    "maxPerHour": 3,
    "profanityFilter": true,
    "dedications": true
  },
  "retention": {
    "historyDays": 90,
    "logsDays": 30,
    "requestsDays": 30,
    "recordingsDays": 30
  },
  "backups": {
    "dir": "/srv/radio/backups",
    "dailyKeep": 14,
    "weeklyKeep": 8
  },
  "email": {
    "smtpHost": "smtp.example.com",
    "smtpPort": 587,
    "from": "radio@example.com"
  },
  "webhooks": {
    "alerts": []
  },
  "metrics": {
    "enabled": true,
    "path": "/metrics"
  }
}
```

Secrets (`/etc/radio/secrets.env`, chmod 600):

```bash
ICECAST_SOURCE_PASSWORD=...
ICECAST_ADMIN_PASSWORD=...
ADMIN_USERNAME=admin
ADMIN_PASSWORD=...
SESSION_SECRET=...
SMTP_PASSWORD=...
```

---

## Appendix B — systemd units (sketch)

`/etc/systemd/system/radio-api.service`:

```ini
[Unit]
Description=Radio API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=radio
Group=radio
WorkingDirectory=/srv/radio/app
EnvironmentFile=/etc/radio/secrets.env
ExecStart=/usr/bin/pnpm --filter @radio/api start
Restart=always
RestartSec=3
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/radio-playout.service`:

```ini
[Unit]
Description=Radio Playout Engine
After=network-online.target radio-icecast.service
Wants=radio-icecast.service

[Service]
Type=simple
User=radio
Group=radio
WorkingDirectory=/srv/radio/app
EnvironmentFile=/etc/radio/secrets.env
ExecStart=/usr/bin/pnpm --filter @radio/playout start
Restart=always
RestartSec=3
LimitNOFILE=65535
CPUQuota=150%

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/radio-stereotool.service`:

```ini
[Unit]
Description=Thimeo Stereo Tool
After=network-online.target

[Service]
Type=simple
User=radio
Group=radio
ExecStart=/opt/stereotool/stereotool_cmd -p /etc/radio/stereotool.sds
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

`/etc/systemd/system/radio-backup.service` + `.timer`:

```ini
[Unit]
Description=Radio DB backup

[Service]
Type=oneshot
User=radio
ExecStart=/srv/radio/app/scripts/backup.sh
```

```ini
[Unit]
Description=Daily radio backup

[Timer]
OnCalendar=*-*-* 03:15:00
Persistent=true

[Install]
WantedBy=timers.target
```

> Exact Thimeo command line must come from the M0.5 spike; do not ship the sketch above as the final unit.

---

## Appendix C — Icecast XML sketch

```xml
<icecast>
  <limits>
    <clients>2000</clients>
    <sources>10</sources>
    <queue-size>524288</queue-size>
    <client-timeout>30</client-timeout>
    <source-timeout>10</source-timeout>
  </limits>

  <authentication>
    <source-password>CHANGE_ME</source-password>
    <relay-password>CHANGE_ME</relay-password>
    <admin-user>admin</admin-user>
    <admin-password>CHANGE_ME</admin-password>
  </authentication>

  <hostname>radio.example.com</hostname>
  <location>Station location</location>

  <listen-socket>
    <port>8000</port>
    <bind-address>127.0.0.1</bind-address>
  </listen-socket>

  <mount>
    <mount-name>/hq.mp3</mount-name>
    <public>1</public>
    <charset>UTF-8</charset>
    <stream-name>Station HQ</stream-name>
  </mount>
  <mount>
    <mount-name>/mobile.mp3</mount-name>
    <public>1</public>
  </mount>
  <mount>
    <mount-name>/opus.ogg</mount-name>
    <public>1</public>
  </mount>
  <mount>
    <mount-name>/aac.aac</mount-name>
    <public>1</public>
  </mount>
  <mount>
    <mount-name>/hls</mount-name>
    <public>1</public>
    <!-- HLS options depend on the installed Icecast version; verify in M0.6 -->
  </mount>

  <paths>
    <basedir>/usr/share/icecast</basedir>
    <webroot>/usr/share/icecast/web</webroot>
    <logdir>/var/log/icecast</logdir>
    <pidfile>/run/icecast/icecast.pid</pidfile>
  </paths>

  <logging>
    <accesslog>access.log</accesslog>
    <errorlog>error.log</errorlog>
    <loglevel>3</loglevel>
  </logging>
</icecast>
```

---

## Appendix D — FFmpeg command sketches

**Decode to PCM (deck):**

```bash
ffmpeg -v error -nostdin -ss 0 -t 240 -i track.mp3 \
  -af "atrim=start=0:end=240,asetpts=PTS-STARTPTS" \
  -f s16le -ar 48000 -ac 2 pipe:1
```

**Encode HQ MP3 to Icecast:**

```bash
ffmpeg -v error -nostdin \
  -f s16le -ar 48000 -ac 2 -i pipe:0 \
  -c:a libmp3lame -b:a 320k \
  -f mp3 -content_type audio/mpeg \
  "icecast://source:${ICECAST_SOURCE_PASSWORD}@127.0.0.1:8000/hq.mp3"
```

**Encode Opus to Icecast:**

```bash
ffmpeg -v error -nostdin \
  -f s16le -ar 48000 -ac 2 -i pipe:0 \
  -c:a libopus -b:a 96k \
  -f opus -content_type audio/ogg \
  "icecast://source:${ICECAST_SOURCE_PASSWORD}@127.0.0.1:8000/opus.ogg"
```

**Loudness analysis:**

```bash
ffmpeg -hide_banner -nostats -i track.mp3 \
  -af ebur128=peak=true -f null - 2>&1 | tail -n 20
```

**Loudness normalization (optional copy):**

```bash
ffmpeg -i track.mp3 -af loudnorm=I=-16:TP=-1.5:LRA=11 \
  -ar 48000 -c:a libmp3lame -b:a 320k normalized.mp3
```

**External encoder ingest (Icecast pull):**

```bash
ffmpeg -v error -nostdin \
  -i "http://127.0.0.1:8000/live" \
  -f s16le -ar 48000 -ac 2 pipe:1
```

**ALSA line-in (optional):**

```bash
ffmpeg -v error -nostdin \
  -f alsa -i hw:1 \
  -f s16le -ar 48000 -ac 2 pipe:1
```

---

## Appendix E — Task execution template

Copy this for every task and store it in `PROGRESS.md` or an issue:

````markdown
### M4.2 — Deck

**Goal:** One sentence.
**Depends:** M4.1.
**Files to create/modify:**

- `apps/playout/src/audio/deck.ts`
- `apps/playout/src/audio/deck.test.ts`

**Steps:**

1. ...
2. ...
3. ...

**Verify:**

```bash
pnpm --filter @radio/playout test deck
```
````

**Definition of done:**

- [ ] Code implemented
- [ ] Unit tests pass
- [ ] No type/lint errors
- [ ] Manual smoke test recorded
- [ ] Docs/ADR updated if behavior changed
- [ ] `PROGRESS.md` updated

**Rollback:** revert the commit; no DB migration or restore the previous migration.

```

### Global definition of done

- `pnpm lint` passes.
- `pnpm typecheck` passes.
- `pnpm test` passes.
- `pnpm build` succeeds.
- No secrets or large binaries committed.
- New behavior has tests.
- Docs/ADRs updated when architecture changes.
- Manual verification recorded in the task/PR.

---

## Appendix F — MVP cut line

If time or scope pressure requires a reduced release, ship this first:

1. M0–M6 (walking skeleton through interactive controls).
2. M9.1–M9.3 (admin shell, dashboard, playout console).
3. M11.1 (public listen page).
4. M13.1–M13.4 (install, systemd, nginx, Icecast).

**MVP acceptance:**

- 24 hours of automation generated and played.
- Stereo Tool processing active.
- HQ MP3, mobile MP3, Opus, and HLS playable.
- Operator can skip/pause/play-now/voice-over from the UI.
- Public listener page plays the stream.
- Clean LXC install + smoke test pass.

Everything else (live studio, requests, stats, alerts, full admin UI) is Phase 2/3.

---

*End of plan.*
```
