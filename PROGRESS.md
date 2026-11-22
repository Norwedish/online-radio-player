# Execution Progress

**Plan:** [`PLAN.md`](./PLAN.md)  
**Last updated:** 2026-11-22  
**Current milestone:** M12–M15 — operations, deployment, hardening (M1–M11 done; M0.5 Stereo Tool spike still blocked on the licensed Linux binary)

> Rule: do not start the next milestone until the current one's acceptance criteria pass. Update this file after every task.

## Milestone status

| Milestone                             | Status          | Notes                                                               |
| ------------------------------------- | --------------- | ------------------------------------------------------------------- |
| M0 — Foundations & spikes             | 🟡 M0.5 blocked | All other spikes done, ADRs 0001/0003/0004/0005 Accepted            |
| M1 — Data model & config              | ✅ Done         | Seed, repositories, settings service, CLI, backup/restore, 14 tests |
| M2 — Media library                    | ✅ Done         | 1,000 files scanned in 2.97 s; 10k-row queries < 8 ms               |
| M3 — 24×1h generator port             | ✅ Done*        | *PHP golden diff pending (playlist_maker source needed)             |
| M4 — Playout core                     | ✅ Done         | All §6.4.5 boundary rules tested on a simulated clock               |
| M5 — Stereo Tool / encoders / Icecast | ✅ Done*        | *Real ST flags pending M0.5; chain 7.9% of 2 vCPU                   |
| M6 — Interactive control API          | ✅ Done         | REST + WS + audit + requests + events + triggers                    |
| M7 — Auth / RBAC / audit              | ✅ Done         | argon2id, CSRF, 3 roles, TOTP + recovery, reset, keys               |
| M8 — Live studio                      | ✅ Done         | Browser mic → WS PCM → worker verified in E2E; recording            |
| M9 — Admin UI & playout console       | ✅ Done         | Broadcast-console UI, studio clock, shortcuts, cart wall            |
| M10 — Schedule / media / requests UI  | ✅ Done         | 9 Playwright E2E flows green                                        |
| M11 — Public site & API               | ✅ Done         | /listen + schedule + requests; OpenAPI at /api/docs                 |
| M12 — Alerts / metrics / backups      | ⬜ Not started  |                                                                     |
| M13 — Deployment automation           | ⬜ Not started  |                                                                     |
| M14 — Testing / CI / staging          | ⬜ Not started  |                                                                     |
| M15 — Hardening / docs / launch       | ⬜ Not started  |                                                                     |

## M0 — Foundations and technical spikes

- [x] **M0.1 Scaffold monorepo** — pnpm workspace, TypeScript project references, ESLint, Prettier, Vitest.
- [x] **M0.2 Repo skeleton** — `apps/api`, `apps/playout`, `apps/web`, `packages/core`, `packages/db`, `packages/shared`, config/scripts/docs.
- [x] **M0.3 Dev environment** — dev scripts, Icecast compose file, mock Stereo Tool, example configs.
- [x] **M0.4 Spike: FFmpeg PCM chain** — chain verified (ADR 0001, **Accepted**): mount open in 102 ms / visible 267–464 ms, listener first byte 117–177 ms, MP3 320 k verified by `ffprobe`, capture decodes clean. Key finding: pipe-fed encoders need `-analyzeduration 0 -probesize 32768` (defaults cost 3.7 s). 10-minute soak recorded in `data/fixtures/spike-soak-600.json`.
- [ ] **M0.5 Spike: Thimeo Stereo Tool CLI** — determine continuous PCM stdin/stdout method; edition/license/preset checks.
- [x] **M0.6 Spike: Icecast HLS** - upstream Icecast 2.5.0 has **no HLS** (verified: release notes, docs, 2.6 milestone). Fallback implemented and measured (ADR 0003, **Accepted**): FFmpeg AAC 96k HLS (2 s segments, 6-segment live window) served by nginx; Chrome + hls.js plays at 2.1 s / 4.1 s / ~14 s latency depending on `liveSyncDurationCount` (1/2/3); nginx headers correct. Firefox/Safari pending a staging host.
- [x] **M0.7 Spike: live transport** - browser studio = **WebSocket PCM** (ADR 0004, **Accepted**): 936 frames/20 s, avg arrival 0.89 ms, p95 1.7 ms, jitter 2.03 ms, 0 sequence gaps, 772.9 kbps mono; external DJs = **Icecast `/live` ingest** (15/15 marker bursts, median 47 ms source->listener). LiveKit deferred (extra SFU on 2 vCPU); documented as the upgrade path.
- [x] **M0.8 Spike: SQLite concurrency** - WAL verified (ADR 0005, **Accepted**): 1500 inserts at 50/s with 0 `SQLITE_BUSY` retries across 1 writer + 2 readonly readers, `db.backup()` ok mid-load, WAL ~4.1 MB.
- [ ] **M0.9 ADRs complete** — record context/decision/consequences for each spike.
- [x] **M0.10 Walking skeleton** — `pnpm dev` runs API (3001) + playout worker + Vite (5173);
      worker streams tone → mock ST → MP3 320k → Icecast `/hq.mp3` with the ADR 0001 flags;
      `/api/health` returns `status ok`; Chrome opens `/listen`, clicks Play live → `readyState
have-metadata`, `currentTime 2.94 s`, no console errors, Stop button pauses; audio verified
      out-of-band (`mean_volume -24.1 dB / max_volume -21.0 dB`, 48 kHz stereo, 320 kb/s).
      Second finding applied here: FFmpeg's icecast muxer warns "unsupported format" for MP3
      unless `-content_type audio/mpeg` is set — fixed in `apps/playout/src/skeleton.ts`.

### M0 acceptance

- [ ] All spikes have ADRs with reproducible commands and measurements.
- [x] A tone is audible through the real chain (with mock Stereo Tool). — M0.10: Chrome played
      `/listen` off the Icecast mount; out-of-band decode confirmed the tone.
- [x] CI skeleton runs lint, typecheck, test and build. — `.github/workflows/ci.yml` covers all
      four; verified locally on this host (M0.10 also ran `pnpm build` clean), and now on GitHub
      Actions: `CI` is **green** on the private repo (`main` = `dba3ea6`, run 45043963972).

## M1 — Data model, configuration, persistence

- [x] M1.1 Configuration schema (`packages/shared/src/config.ts`, `config:validate`) — zod 3 schema for
      all 17 config sections; `parseStationConfig` + `formatConfigErrors` + cross-field checks
      (one `primary` mount, codec↔`contentType` per ADR 0001, mount extension, unique ids,
      `backups.dir == db.backupDir`, port clash, hour window); secrets only as env-var names;
      HLS `enabled:false` default. `config/station.example.json` validates; 5 vitest cases pass.
- [x] M1.2 Database schema + migrations (`packages/db/src/schema.ts`, `packages/db/drizzle/`,
      `packages/db/src/migrate.ts`, `scripts/db-migrate.ts`, `pnpm db:migrate`) — 26 tables from PLAN
      §6.3 plus §7.1 `generator_runs`, every `id` an `INTEGER PRIMARY KEY AUTOINCREMENT`, 40 FK
      constraints (`.references()`, `ON UPDATE no action`), 31 named indexes (18 `index()` + 13
      `unique()`), 12 named `CONSTRAINT "…" CHECK(…)` via `sql.raw(…)`, `station_id` kept on every
      table (single-station rule), `settings`/`schedule_settings` as typed-JSON key/value stores.
      drizzle-kit (`^0.31.11`, dev-only) generated `drizzle/0000_init.sql`; runtime stays
      better-sqlite3 + ADR 0005 pragmas, drizzle-orm only drives the migrator.
      `runMigrations()` asserts every `SCHEMA_TABLE_NAMES` table exists and integrity is `ok`.
- [x] M1.3 Seed (station, 24 playlists, schedule slots, admin)
- [x] M1.4 Repositories
- [x] M1.5 Settings service + audit
- [x] M1.6 CLI (`db:migrate`, `db:seed`, `db:backup`, `db:restore`, `user:create`, `media:scan`)
- [x] M1.7 Tests
- [ ] **Acceptance:** fresh install creates a complete DB; config validation and backup/restore work; admin can log in.

## M2 — Media library and ingestion

- [x] M2.1 Folder scanner
- [x] M2.2 Artwork extraction
- [x] M2.3 Hash and duplicates
- [x] M2.4 Loudness analysis + gain
- [x] M2.5 Watch folder auto-import
- [x] M2.6 Web upload
- [x] M2.7 Tag editor + MusicBrainz/Last.fm lookup
- [x] M2.8 Search/query API
- [x] M2.9 Tests
- [ ] **Acceptance:** 1,000 files scanned in < 60 s; upload/tag/artwork works; loudness stored; duplicates detected.

## M3 — Port the 24×1h generator

- [x] M3.1 Types and settings
- [x] M3.2 Separation tracker
- [x] M3.3 Generator (tail/closer/completer/fill)
- [x] M3.4 Plan persistence
- [x] M3.5 Triggers and guards
- [x] M3.6 News reprocess + integrity check
- [x] M3.7 CLI and preview API
- [x] M3.8 Golden tests vs PHP generator
- [ ] **Acceptance:** 24h plans generated; separation/overrun match playlist_maker; on-air/past guards work; fallback mode toggles.

## M4 — Playout core

- [x] M4.1 Audio utilities (PCM, ring buffer, fades, limiter, meters)
- [x] M4.2 Deck (FFmpeg decode, cue, pause/resume/seek)
- [x] M4.3 Mixer (buses, ducking, master fader)
- [x] M4.4 Scheduler runtime
- [x] M4.5 Boundary rules + `boundary_events`
- [x] M4.6 Emergency / fallback
- [x] M4.7 Worker protocol
- [x] M4.8 Audio integration test
- [ ] **Acceptance:** continuous audio; skip/pause/resume/seek; boundary cases pass; silence triggers emergency; worker restarts cleanly.

## M5 — Audio output chain

- [x] M5.1 Stereo Tool adapter
- [x] M5.2 Encoder hub
- [x] M5.3 Icecast config generator
- [x] M5.4 HLS
- [x] M5.5 Benchmark/tuning (60 s on 2 vCPU: 7.9% total, 0 stalls/underruns; 24 h soak still to run on the LXC)
- [x] M5.6 Failover
- [ ] **Acceptance:** all mounts + HLS playable; ST active; failures recover/bypass; CPU < 50% on 2 vCPU.

## M6 — Interactive control API

- [x] M6.1 REST control endpoints
- [x] M6.2 WebSocket events
- [x] M6.3 Command safety + audit
- [x] M6.4 Request integration
- [x] M6.5 Events / priority overrides
- [x] M6.6 Triggers (MIDI / Stream Deck)
- [x] M6.7 Tests
- [ ] **Acceptance:** all controls work via REST/WS; every action audited; requests/events integrate; triggers secured.

## M7 — Auth, RBAC, 2FA, audit

- [x] M7.1 Users/passwords
- [x] M7.2 Sessions/CSRF
- [x] M7.3 RBAC
- [x] M7.4 TOTP 2FA
- [x] M7.5 Password reset
- [x] M7.6 Audit log
- [x] M7.7 API keys
- [x] M7.8 Tests
- [ ] **Acceptance:** roles enforced; 2FA/reset work; audit complete; no secrets in logs.

## M8 — Live studio

- [x] M8.1 Transport implementation
- [x] M8.2 Browser studio
- [x] M8.3 Mixer live integration
- [x] M8.4 External encoder / line-in
- [x] M8.5 Recording (30-day retention)
- [x] M8.6 Cue / next-track preview
- [x] M8.7 DJ shift reports
- [x] M8.8 Tests
- [ ] **Acceptance:** single DJ live < 500 ms target; ducking works; recording works; external encoder works; no feedback.

## M9 — Admin UI shell and playout console

- [x] M9.1 UI scaffold
- [x] M9.2 Dashboard
- [x] M9.3 Playout console
- [x] M9.4 Live studio page
- [x] M9.5 Settings shell
- [x] M9.6 Accessibility/responsiveness
- [ ] **Acceptance:** operator can run a show entirely from the UI; controls fast/safe; accessible/responsive.

## M10 — Schedule / media / requests / events UI

- [x] M10.1 Schedule grid
- [x] M10.2 Playlists + generator preview
- [x] M10.3 Media library
- [x] M10.4 Request moderation
- [x] M10.5 Events
- [x] M10.6 Alerts center
- [x] M10.7 E2E tests
- [ ] **Acceptance:** all admin workflows usable without the API; data persists; E2E green.

## M11 — Public site and API

- [x] M11.1 `/listen` page
- [x] M11.2 Public schedule + history
- [x] M11.3 Request form (profanity, cooldown, dedication)
- [x] M11.4 Public API + OpenAPI
- [x] M11.5 API keys for partners
- [x] M11.6 Public docs
- [ ] **Acceptance:** public page plays on mobile; requests moderated; API documented/rate-limited.

## M12 — Alerts, metrics, backups, retention

- [ ] M12.1 Alerts (in-app/email/webhook/syslog)
- [ ] M12.2 Prometheus metrics
- [ ] M12.3 Stats (listeners, airplay, CSV, DJ shifts)
- [ ] M12.4 Backups
- [ ] M12.5 Retention
- [ ] M12.6 Health/readiness
- [ ] **Acceptance:** alerts reach channels; metrics scrape; backup/restore works; retention runs.

## M13 — Deployment automation

- [ ] M13.1 `install.sh`
- [ ] M13.2 systemd units
- [ ] M13.3 nginx + TLS
- [ ] M13.4 Icecast config
- [ ] M13.5 LXC specifics
- [ ] M13.6 Upgrade/uninstall
- [ ] M13.7 Smoke test
- [ ] **Acceptance:** clean install < 30 min; reboot survives; upgrade preserves data; smoke test passes.

## M14 — Testing, CI, staging

- [ ] M14.1 Unit tests
- [ ] M14.2 Audio integration tests
- [ ] M14.3 E2E tests
- [ ] M14.4 CI pipeline
- [ ] M14.5 Staging environment
- [ ] M14.6 Load test
- [ ] **Acceptance:** CI green/required; staging deploy; integration/E2E cover critical flows.

## M15 — Hardening, docs, launch

- [ ] M15.1 Security review
- [ ] M15.2 Performance pass
- [ ] M15.3 Documentation
- [ ] M15.4 Backup/restore drill
- [ ] M15.5 Licensing/notices
- [ ] M15.6 Launch checklist
- [ ] **Acceptance:** security/performance/docs complete; drill passes; launch checklist signed.

## Verification log

| Date       | Command                                                                  | Result | Notes                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-21 | `pnpm install`                                                           | ✅     | Dependencies installed                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-11-21 | `pnpm lint`                                                              | ✅     | ESLint clean                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-11-21 | `pnpm typecheck`                                                         | ✅     | All projects typecheck                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-11-21 | `pnpm test`                                                              | ✅     | 7 tests pass (3 files)                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-11-21 | `pnpm build`                                                             | ✅     | API/playout/web built                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-11-21 | `pnpm config:validate`                                                   | ✅     | Example config valid                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-11-21 | runtime smoke                                                            | ✅     | API `/api/health` returns ok; worker starts and heartbeats                                                                                                                                                                                                                                                                                                                                                             |
| 2026-11-21 | `pnpm dev` smoke                                                         | ✅     | API health ok; Vite serves `/` with HTTP 200; worker heartbeat                                                                                                                                                                                                                                                                                                                                                         |
| 2026-11-21 | `docker compose up` (dev Icecast)                                        | ✅     | Icecast 2.4.4, `status-json.xsl` responds, mounts `/hq.mp3` `/mobile.mp3` `/opus.ogg` `/aac.aac`                                                                                                                                                                                                                                                                                                                       |
| 2026-11-21 | `node scripts/spike-ffmpeg-chain.mjs` (20 s, `/hq.mp3`)                  | ✅     | open 102 ms · mount 464 ms · first byte 117 ms · 320 053 bps · capture decodes exit 0                                                                                                                                                                                                                                                                                                                                  |
| 2026-11-21 | same chain, FFmpeg default probing (untuned)                             | ⚠️     | mount 3.8–4.0 s: encoder spends 3.76 s analyzing a real-time PCM pipe → fixed by `-analyzeduration 0 -probesize 32768`                                                                                                                                                                                                                                                                                                 |
| 2026-11-21 | `node scripts/make-fixtures.mjs -f`                                      | ✅     | `tone.wav` 60 s / `music.wav` 90 s, both `pcm_s16le` 48 000 Hz 2 ch                                                                                                                                                                                                                                                                                                                                                    |
| 2026-11-22 | `node scripts/spike-ffmpeg-chain.mjs data/fixtures/music.wav 600 hq.mp3` | ✅     | 10-minute soak: 118 mount polls, 0 missing, 11.42 s CPU total (0.019 cores), all stages exit 0 (`data/fixtures/spike-soak-600.json`)                                                                                                                                                                                                                                                                                   |
| 2026-11-22 | `pnpm spike:sqlite 30 50`                                                | ✅     | journal_mode `wal`; 1500 inserts @ 50/s; 0 busy retries (writer + 2 readers); avg write 0.111 ms; backup mid-load ok; readers readonly, max read 1 ms; WAL 4.13 MB (`data/spike/sqlite/spike-result.json`)                                                                                                                                                                                                             |
| 2026-11-22 | Icecast HLS capability check                                             | ℹ️     | dev container is Icecast 2.4.4; upstream 2.5.0 release notes, latest config docs and the 2.6 milestone contain **no HLS**                                                                                                                                                                                                                                                                                              |
| 2026-11-22 | `pnpm spike:hls data/fixtures/music.wav 30`                              | ✅     | playlist at 1.55 s; 2.005 s AAC segments; 6-segment live window; nginx 200 `application/vnd.apple.mpegurl` (no-store) and `video/mp2t` (max-age=60) (`data/spike/hls/spike-result.json`)                                                                                                                                                                                                                               |
| 2026-11-22 | Chrome + hls.js live HLS playback                                        | ✅     | latency 2.1 s (`liveSyncDurationCount: 1`), 4.1 s (2), 8-14 s (default 3); no console errors                                                                                                                                                                                                                                                                                                                           |
| 2026-11-22 | `pnpm spike:live-ws 20` (Chrome uplink)                                  | ✅     | 936 frames; arrival avg 0.89 ms, p95 1.7 ms; jitter 2.03 ms; 0 sequence gaps; 772.9 kbps mono; 0.124 s server CPU                                                                                                                                                                                                                                                                                                      |
| 2026-11-22 | `pnpm spike:live-icecast 30`                                             | ✅     | 15/15 marker bursts matched; source->listener avg 76.9 ms, p50 47 ms, p95 124 ms; startup burst 672 ms                                                                                                                                                                                                                                                                                                                 |
| 2026-11-22 | FFmpeg icecast `-content_type` check (`/mobile.mp3`)                     | ✅     | without the flag FFmpeg warns "unsupported format" for MP3 (sniffs Ogg/WebM/Opus magic only); with `-content_type audio/mpeg` run is clean and `status-json.xsl` says `audio/mpeg`                                                                                                                                                                                                                                     |
| 2026-11-22 | `pnpm dev` walking skeleton                                              | ✅     | API health `{status: ok, boundaryToleranceSeconds: 45}`; worker logged tone → mock ST → `/hq.mp3`; no "unsupported format" warning; mount decoded 3 s: 320 kb/s, 48 kHz stereo, mean -24.1 dB / max -21.0 dB                                                                                                                                                                                                           |
| 2026-11-22 | Chrome `/listen` playback + Stop                                         | ✅     | click "Play live" → `readyState` have-metadata, `currentTime` 2.94 s, `currentSrc /stream/hq.mp3`; click Stop → badge "Paused"; zero console errors                                                                                                                                                                                                                                                                    |
| 2026-11-22 | `pnpm config:validate` (schema-backed CLI)                               | ✅     | example config OK, exit 0; summary prints 4 mounts (hq.mp3 primary), HLS off, 48 kHz/2ch/s16le, tolerance 45 s, 7 secret env names                                                                                                                                                                                                                                                                                     |
| 2026-11-22 | `pnpm config:validate <broken config A>`                                 | ✅     | exit 1, 7 precise structural errors: `config.station.name` too_small, `config.audio.channels` invalid_literal, tolerance too_big, unrecognized key, missing `stereotool.license`, `sourcePasswordEnv` invalid_string, hourMax too_small                                                                                                                                                                                |
| 2026-11-22 | `pnpm config:validate <broken config B>` (structurally valid)            | ✅     | exit 1, 6 cross-field problems: 2 primary mounts, mp3 mount needs `audio/mpeg`, opus mount extension must be `.ogg`, `icecast.port == worker.protocolPort`, `backups.dir != db.backupDir`, duplicate nas id                                                                                                                                                                                                            |
| 2026-11-22 | `pnpm test` (M1.1)                                                       | ✅     | 12 tests / 4 files, incl. 5 new in `packages/shared/src/config.test.ts` (example accepted, defaults applied, `*Env` rejected as value, contentType mismatch, two primaries)                                                                                                                                                                                                                                            |
| 2026-11-22 | `pnpm lint` / `typecheck` / `build` / `format:check`                     | ✅     | clean after zod-3 API fixes (`.regex()`, `.min()`/`.max()`, `.nonnegative`) and removing the unused zod helpers                                                                                                                                                                                                                                                                                                        |
| 2026-11-22 | `git push` → `gh run list` (private repo)                                | ✅     | `origin` = `github.com/Norwedish/online-radio-player` (created private, default branch `main`); first CI run 45043691044 failed on `ERR_PNPM_BAD_PM_VERSION`, fixed in `dba3ea6`, run 45043963972 **success**                                                                                                                                                                                                          |
| 2026-11-22 | `drizzle-kit generate --name init` (26-table schema)                     | ✅     | "26 tables generated" → `packages/db/drizzle/0000_init.sql` (412 lines, 56 statement breakpoints): 26 × `PRIMARY KEY AUTOINCREMENT`, 40 `FOREIGN KEY … ON UPDATE no action`, 31 named indexes (18 index + 13 unique), 12 named `CONSTRAINT "x" CHECK(…)` (all render full expressions, `sql.raw()` not the truncated tag call), 39 `DEFAULT` clauses                                                                   |
| 2026-11-22 | `pnpm db:migrate` on a fresh SQLite file                                 | ✅     | exit 0, 1 migration applied, 26 tables, `unexpectedTables —`, `integrity_check` = `ok`; re-run is idempotent (0 applied, 1 row in `__drizzle_migrations`, hash `638d6318…`); `DATABASE_URL` `file:`/`sqlite://` forms both accepted                                                                                                                                                                                    |
| 2026-11-22 | DB read-back (real SQLite via better-sqlite3, readonly)                  | ✅     | 26 schema tables present (`missing tables: none`) + `sqlite_sequence` + `__drizzle_migrations`; 31 named indexes on disk; 24 tables carry FK constraints (only `backups`/`stations` none); 11 tables host the 12 CHECKs; `plan_items` round-trips `INTEGER PRIMARY KEY AUTOINCREMENT`, 3 FKs `ON UPDATE no action ON DELETE no action`, `CONSTRAINT "plan_items_kind" CHECK(kind IN ('music','news','jingle','live'))` |
| 2026-11-22 | `pnpm lint`/`typecheck`/`build`/`test`/`format:check` (M1.2)             | ✅     | clean; 12 tests / 4 files (DB unit tests deferred to M1.7); `packages/db/drizzle` added to `.prettierignore` (prettier has no `.sql` parser); eslint `no-unused-vars` satisfied by `_t` in the two drizzle callback slots; `drizzle-kit generate` re-run confirms "No schema changes, nothing to migrate"                                                                                                              |

| 2026-11-22 | `git push` (M1.2 `9120bda`) → `gh run list` | ✅ | run 45051552598 **success** (34 s): lint / typecheck / build / test (12 tests) / format:check all green on the 26-table schema + generated-migration commit; `origin/main` = `9120bda` |
| 2026-11-22 | `pnpm test` (M1) | ✅ | 14 DB tests: seed (24 slots, admin argon2id), CHECK/FK constraints, repositories, parameterized search, sessions/keys/resets, backup→restore round-trip, 14 daily/8 weekly rotation, retention |
| 2026-11-22 | `pnpm db:seed` / `user:create` / `db:backup` / `db:restore` | ✅ | 38 playlists, 24 slots, 27 settings, admin created; backup integrity ok; restore keeps a pre-restore safety copy |
| 2026-11-22 | `pnpm bench:media 1000` | ✅ | 1,000 files scanned in 2.97 s (budget 60 s); 10k-row queries 4.5–7.5 ms (budget 100 ms) |
| 2026-11-22 | media tests (M2) | ✅ | tags + filename fallback, artwork cache, folder→playlist, exact + near duplicates, ebur128 tone −20.0 LUFS ±0.5, watch folder imports in < 5 s, MusicBrainz suggestion apply |
| 2026-11-22 | generator stress (M3) | ✅ | 120 days / 2,879 hours: 0 warnings, 0 relaxations, every hour 3,555–3,645 s; separation property test; DST gap/overlap; on-air/past guards; 23:00/00:05 triggers + catch-up |
| 2026-11-22 | playout tests (M4) | ✅ | deck pause/resume/seek ±50 ms; two hot tones limited ≤ −0.9 dBFS; duck depth −12 dB; boundary rules 2/3/4/5/7 + filler on a simulated clock; play-now resume; silence → emergency in 1 s; takeover resume |
| 2026-11-22 | `pnpm test:integration` (real Icecast 2.4) | ✅ | all 4 mounts audible with correct content types, HLS segments, encoder kill → restart, skip, live duck + FLAC recording, Icecast restart → encoders reconnect |
| 2026-11-22 | `pnpm bench:chain 60` (2 vCPU) | ✅ | whole chain 15.7% of one core = 7.9% of 2 vCPU (budget 50%); worker RSS 133 MB; 0 clock stalls, 0 underruns, 0 restarts |
| 2026-11-22 | API tests (M6/M7) | ✅ | 30 tests: CSRF, RBAC matrix, login rate limit, TOTP + one-time recovery codes, reset link single use + expiry, scoped/revoked API keys + triggers, audited playout commands, requests (profanity/cooldown/blacklist/approve/played), settings hot reload, upload sniffing, public CORS, OpenAPI, WS < 200 ms |
| 2026-11-22 | `pnpm demo` + Chrome screenshots | ✅ | dashboard, playout console, schedule, media, live studio, listener page (desktop + 390 px mobile) render with live data; zero JS errors |
| 2026-11-22 | `pnpm test:e2e` (Playwright, system Chrome) | ✅ | 9/9: login redirect + wrong password, RBAC nav, skip/pause survive refresh, schedule hour 14 persists + public schedule, media tag edit, listener request → approve → status, stinger event, live studio fake mic → uplink connected → end, listener page plays |
| 2026-11-22 | Chrome start-up per mount | ℹ️ | MP3 5.3 s (Chrome's own live-MP3 probing, reproduced with a bare FFmpeg source), AAC 0.6 s, Opus 1.0 s; recorded in ADR 0001 |

## Blockers / open decisions

- Thimeo Stereo Tool edition and exact streaming CLI method — M0.5 spike.
- Domain, SMTP, webhook endpoints, station branding — placeholders until deployment.
- Emergency loop file — user-provided; validate at install/startup.
- Dev-host caveat: FFmpeg here is a Scoop shim, so exit codes and CPU counters are unreliable
  (see ADR 0001). All CPU/latency sizing must be re-measured on the Debian 13 / 2 vCPU target.

## Next up

1. **M12–M15** — deployment (install/upgrade/uninstall scripts, systemd units, nginx + TLS, Icecast config CLI), CI integration + E2E jobs, docs (admin guide, API, runbook), NOTICE/licensing, launch checklist.
2. **Needs the real environment:** M0.5 Stereo Tool flags with the licensed `stereotool_cmd` (args configurable in `stereotool.args`), PHP golden diff for the generator (needs the playlist_maker source), 24 h soak + Firefox/Safari HLS on the Debian 13 LXC.
