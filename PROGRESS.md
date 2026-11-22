# Execution Progress

**Plan:** [`PLAN.md`](./PLAN.md)  
**Last updated:** 2026-11-22  
**Current milestone:** M0 — Foundations and technical spikes

> Rule: do not start the next milestone until the current one's acceptance criteria pass. Update this file after every task.

## Milestone status

| Milestone                             | Status         | Notes                                |
| ------------------------------------- | -------------- | ------------------------------------ |
| M0 — Foundations & spikes             | 🟡 In progress | Workspace scaffolded; spikes pending |
| M1 — Data model & config              | ⬜ Not started |                                      |
| M2 — Media library                    | ⬜ Not started |                                      |
| M3 — 24×1h generator port             | ⬜ Not started |                                      |
| M4 — Playout core                     | ⬜ Not started |                                      |
| M5 — Stereo Tool / encoders / Icecast | ⬜ Not started |                                      |
| M6 — Interactive control API          | ⬜ Not started |                                      |
| M7 — Auth / RBAC / audit              | ⬜ Not started |                                      |
| M8 — Live studio                      | ⬜ Not started |                                      |
| M9 — Admin UI & playout console       | ⬜ Not started |                                      |
| M10 — Schedule / media / requests UI  | ⬜ Not started |                                      |
| M11 — Public site & API               | ⬜ Not started |                                      |
| M12 — Alerts / metrics / backups      | ⬜ Not started |                                      |
| M13 — Deployment automation           | ⬜ Not started |                                      |
| M14 — Testing / CI / staging          | ⬜ Not started |                                      |
| M15 — Hardening / docs / launch       | ⬜ Not started |                                      |

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
      four; verified locally on this host (M0.10 also ran `pnpm build` clean).

## M1 — Data model, configuration, persistence

- [ ] M1.1 Configuration schema (`packages/shared/src/config.ts`, `config:validate`)
- [ ] M1.2 Database schema + migrations
- [ ] M1.3 Seed (station, 24 playlists, schedule slots, admin)
- [ ] M1.4 Repositories
- [ ] M1.5 Settings service + audit
- [ ] M1.6 CLI (`db:migrate`, `db:seed`, `db:backup`, `db:restore`, `user:create`, `media:scan`)
- [ ] M1.7 Tests
- [ ] **Acceptance:** fresh install creates a complete DB; config validation and backup/restore work; admin can log in.

## M2 — Media library and ingestion

- [ ] M2.1 Folder scanner
- [ ] M2.2 Artwork extraction
- [ ] M2.3 Hash and duplicates
- [ ] M2.4 Loudness analysis + gain
- [ ] M2.5 Watch folder auto-import
- [ ] M2.6 Web upload
- [ ] M2.7 Tag editor + MusicBrainz/Last.fm lookup
- [ ] M2.8 Search/query API
- [ ] M2.9 Tests
- [ ] **Acceptance:** 1,000 files scanned in < 60 s; upload/tag/artwork works; loudness stored; duplicates detected.

## M3 — Port the 24×1h generator

- [ ] M3.1 Types and settings
- [ ] M3.2 Separation tracker
- [ ] M3.3 Generator (tail/closer/completer/fill)
- [ ] M3.4 Plan persistence
- [ ] M3.5 Triggers and guards
- [ ] M3.6 News reprocess + integrity check
- [ ] M3.7 CLI and preview API
- [ ] M3.8 Golden tests vs PHP generator
- [ ] **Acceptance:** 24h plans generated; separation/overrun match playlist_maker; on-air/past guards work; fallback mode toggles.

## M4 — Playout core

- [ ] M4.1 Audio utilities (PCM, ring buffer, fades, limiter, meters)
- [ ] M4.2 Deck (FFmpeg decode, cue, pause/resume/seek)
- [ ] M4.3 Mixer (buses, ducking, master fader)
- [ ] M4.4 Scheduler runtime
- [ ] M4.5 Boundary rules + `boundary_events`
- [ ] M4.6 Emergency / fallback
- [ ] M4.7 Worker protocol
- [ ] M4.8 Audio integration test
- [ ] **Acceptance:** continuous audio; skip/pause/resume/seek; boundary cases pass; silence triggers emergency; worker restarts cleanly.

## M5 — Audio output chain

- [ ] M5.1 Stereo Tool adapter
- [ ] M5.2 Encoder hub
- [ ] M5.3 Icecast config generator
- [ ] M5.4 HLS
- [ ] M5.5 Benchmark/tuning
- [ ] M5.6 Failover
- [ ] **Acceptance:** all mounts + HLS playable; ST active; failures recover/bypass; CPU < 50% on 2 vCPU.

## M6 — Interactive control API

- [ ] M6.1 REST control endpoints
- [ ] M6.2 WebSocket events
- [ ] M6.3 Command safety + audit
- [ ] M6.4 Request integration
- [ ] M6.5 Events / priority overrides
- [ ] M6.6 Triggers (MIDI / Stream Deck)
- [ ] M6.7 Tests
- [ ] **Acceptance:** all controls work via REST/WS; every action audited; requests/events integrate; triggers secured.

## M7 — Auth, RBAC, 2FA, audit

- [ ] M7.1 Users/passwords
- [ ] M7.2 Sessions/CSRF
- [ ] M7.3 RBAC
- [ ] M7.4 TOTP 2FA
- [ ] M7.5 Password reset
- [ ] M7.6 Audit log
- [ ] M7.7 API keys
- [ ] M7.8 Tests
- [ ] **Acceptance:** roles enforced; 2FA/reset work; audit complete; no secrets in logs.

## M8 — Live studio

- [ ] M8.1 Transport implementation
- [ ] M8.2 Browser studio
- [ ] M8.3 Mixer live integration
- [ ] M8.4 External encoder / line-in
- [ ] M8.5 Recording (30-day retention)
- [ ] M8.6 Cue / next-track preview
- [ ] M8.7 DJ shift reports
- [ ] M8.8 Tests
- [ ] **Acceptance:** single DJ live < 500 ms target; ducking works; recording works; external encoder works; no feedback.

## M9 — Admin UI shell and playout console

- [ ] M9.1 UI scaffold
- [ ] M9.2 Dashboard
- [ ] M9.3 Playout console
- [ ] M9.4 Live studio page
- [ ] M9.5 Settings shell
- [ ] M9.6 Accessibility/responsiveness
- [ ] **Acceptance:** operator can run a show entirely from the UI; controls fast/safe; accessible/responsive.

## M10 — Schedule / media / requests / events UI

- [ ] M10.1 Schedule grid
- [ ] M10.2 Playlists + generator preview
- [ ] M10.3 Media library
- [ ] M10.4 Request moderation
- [ ] M10.5 Events
- [ ] M10.6 Alerts center
- [ ] M10.7 E2E tests
- [ ] **Acceptance:** all admin workflows usable without the API; data persists; E2E green.

## M11 — Public site and API

- [ ] M11.1 `/listen` page
- [ ] M11.2 Public schedule + history
- [ ] M11.3 Request form (profanity, cooldown, dedication)
- [ ] M11.4 Public API + OpenAPI
- [ ] M11.5 API keys for partners
- [ ] M11.6 Public docs
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

| Date       | Command                                                                  | Result | Notes                                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-21 | `pnpm install`                                                           | ✅     | Dependencies installed                                                                                                                                                                                       |
| 2026-11-21 | `pnpm lint`                                                              | ✅     | ESLint clean                                                                                                                                                                                                 |
| 2026-11-21 | `pnpm typecheck`                                                         | ✅     | All projects typecheck                                                                                                                                                                                       |
| 2026-11-21 | `pnpm test`                                                              | ✅     | 7 tests pass (3 files)                                                                                                                                                                                       |
| 2026-11-21 | `pnpm build`                                                             | ✅     | API/playout/web built                                                                                                                                                                                        |
| 2026-11-21 | `pnpm config:validate`                                                   | ✅     | Example config valid                                                                                                                                                                                         |
| 2026-11-21 | runtime smoke                                                            | ✅     | API `/api/health` returns ok; worker starts and heartbeats                                                                                                                                                   |
| 2026-11-21 | `pnpm dev` smoke                                                         | ✅     | API health ok; Vite serves `/` with HTTP 200; worker heartbeat                                                                                                                                               |
| 2026-11-21 | `docker compose up` (dev Icecast)                                        | ✅     | Icecast 2.4.4, `status-json.xsl` responds, mounts `/hq.mp3` `/mobile.mp3` `/opus.ogg` `/aac.aac`                                                                                                             |
| 2026-11-21 | `node scripts/spike-ffmpeg-chain.mjs` (20 s, `/hq.mp3`)                  | ✅     | open 102 ms · mount 464 ms · first byte 117 ms · 320 053 bps · capture decodes exit 0                                                                                                                        |
| 2026-11-21 | same chain, FFmpeg default probing (untuned)                             | ⚠️     | mount 3.8–4.0 s: encoder spends 3.76 s analyzing a real-time PCM pipe → fixed by `-analyzeduration 0 -probesize 32768`                                                                                       |
| 2026-11-21 | `node scripts/make-fixtures.mjs -f`                                      | ✅     | `tone.wav` 60 s / `music.wav` 90 s, both `pcm_s16le` 48 000 Hz 2 ch                                                                                                                                          |
| 2026-11-22 | `node scripts/spike-ffmpeg-chain.mjs data/fixtures/music.wav 600 hq.mp3` | ✅     | 10-minute soak: 118 mount polls, 0 missing, 11.42 s CPU total (0.019 cores), all stages exit 0 (`data/fixtures/spike-soak-600.json`)                                                                         |
| 2026-11-22 | `pnpm spike:sqlite 30 50`                                                | ✅     | journal_mode `wal`; 1500 inserts @ 50/s; 0 busy retries (writer + 2 readers); avg write 0.111 ms; backup mid-load ok; readers readonly, max read 1 ms; WAL 4.13 MB (`data/spike/sqlite/spike-result.json`)   |
| 2026-11-22 | Icecast HLS capability check                                             | ℹ️     | dev container is Icecast 2.4.4; upstream 2.5.0 release notes, latest config docs and the 2.6 milestone contain **no HLS**                                                                                    |
| 2026-11-22 | `pnpm spike:hls data/fixtures/music.wav 30`                              | ✅     | playlist at 1.55 s; 2.005 s AAC segments; 6-segment live window; nginx 200 `application/vnd.apple.mpegurl` (no-store) and `video/mp2t` (max-age=60) (`data/spike/hls/spike-result.json`)                     |
| 2026-11-22 | Chrome + hls.js live HLS playback                                        | ✅     | latency 2.1 s (`liveSyncDurationCount: 1`), 4.1 s (2), 8-14 s (default 3); no console errors                                                                                                                 |
| 2026-11-22 | `pnpm spike:live-ws 20` (Chrome uplink)                                  | ✅     | 936 frames; arrival avg 0.89 ms, p95 1.7 ms; jitter 2.03 ms; 0 sequence gaps; 772.9 kbps mono; 0.124 s server CPU                                                                                            |
| 2026-11-22 | `pnpm spike:live-icecast 30`                                             | ✅     | 15/15 marker bursts matched; source->listener avg 76.9 ms, p50 47 ms, p95 124 ms; startup burst 672 ms                                                                                                       |
| 2026-11-22 | FFmpeg icecast `-content_type` check (`/mobile.mp3`)                     | ✅     | without the flag FFmpeg warns "unsupported format" for MP3 (sniffs Ogg/WebM/Opus magic only); with `-content_type audio/mpeg` run is clean and `status-json.xsl` says `audio/mpeg`                           |
| 2026-11-22 | `pnpm dev` walking skeleton                                              | ✅     | API health `{status: ok, boundaryToleranceSeconds: 45}`; worker logged tone → mock ST → `/hq.mp3`; no "unsupported format" warning; mount decoded 3 s: 320 kb/s, 48 kHz stereo, mean -24.1 dB / max -21.0 dB |
| 2026-11-22 | Chrome `/listen` playback + Stop                                         | ✅     | click "Play live" → `readyState` have-metadata, `currentTime` 2.94 s, `currentSrc /stream/hq.mp3`; click Stop → badge "Paused"; zero console errors                                                          |

## Blockers / open decisions

- Thimeo Stereo Tool edition and exact streaming CLI method — M0.5 spike.
- Icecast exact version/HLS config — M0.6 spike.
- Live transport choice — M0.7 spike.
- Domain, SMTP, webhook endpoints, station branding — placeholders until deployment.
- Emergency loop file — user-provided; validate at install/startup.
- Dev-host caveat: FFmpeg here is a Scoop shim, so exit codes and CPU counters are unreliable
  (see ADR 0001). All CPU/latency sizing must be re-measured on the Debian 13 / 2 vCPU target.

## Next up

1. **M0.5** — Thimeo Stereo Tool CLI spike; **blocked** until the licensed binary/preset/`.lic`
   is available on a Linux host. Blocks ADR 0002 and the last M0 acceptance row.
2. **M0.9** — remaining ADR work: 0002 after M0.5; re-measure CPU on the Debian 13 target
   (ADRs 0001/0003/0004 are Windows-host numbers); Firefox/Safari HLS smoke test on staging.
3. **M1** — data model, configuration schema and persistence (`packages/shared` config +
   `packages/db`), using the accepted SQLite decision from ADR 0005.
