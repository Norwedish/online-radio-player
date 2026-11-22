# ADR 0003 — HLS output via FFmpeg + nginx (not Icecast-native)

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Norwedish
- **Related:** M0.6, M5.4 (output chain), M13 (deployment)

## Context

The original plan assumed "HLS (Icecast native)". The M0.6 spike tested that
assumption before building on it.

Findings:

- The dev container runs **Icecast 2.4.4** (`icecast2 -v`).
- Upstream **Icecast 2.5.0** (released 2025-12-31) has **no HLS support**: the
  release notes list only web UI, events, X-Forwarded-For, TLS handling and API
  changes, and the latest config documentation has no `hls` element.
- The **Icecast 2.6** milestone contains no HLS work item.
- HLS in the Icecast ecosystem exists only in third-party derivatives (for
  example the commercial Rocket Streaming Audio Server, which adds `<hls>` config
  and serves `/mount/hls.m3u8`), not in Xiph's Icecast.

So "Icecast native HLS" is not available. HLS needs a separate packaging step.

## Options considered

1. **FFmpeg HLS segmenter + nginx static serving** (chosen)
   - Pros: no new runtime service beyond nginx (already wanted for TLS/proxy);
     reuses the existing AAC 96k encode; segments are plain files, easy to cache
     and to serve from a CDN later; works in Safari/iOS natively and everywhere
     via hls.js.
   - Cons: adds 2-14 s latency; nginx becomes a required component; segment
     directory needs cleanup and disk/memory planning.
2. **Icecast-native HLS** — not available upstream; would require a commercial
   derivative. Rejected.
3. **No HLS in v1** — simplest, but loses iOS lock-screen/background playback
   and the CDN-friendly delivery path. Kept as a configuration switch, not the
   default.
4. **Liquidsoap HLS output** — would work but violates the "no Liquidsoap
   runtime" constraint. Rejected.

## Decision

Ship HLS as an **FFmpeg-packaged, nginx-served** output alongside the ICY mounts:

- FFmpeg encodes AAC 96k, 48 kHz stereo and writes HLS: `-f hls -hls_time 2
-hls_list_size 6 -hls_flags delete_segments+omit_endlist+independent_segments`
  with MPEG-TS segments (`seg%05d.ts`) and `stream.m3u8`.
- Production wiring: one AAC encode feeds both the progressive AAC mount and the
  HLS segmenter (`-f tee` with `[f=adts]icecast://...` + `[f=hls]...`, codec
  copy), so HLS costs no extra encoding CPU. Confirm in M5.4.
- nginx serves `/hls/stream.m3u8` with `Cache-Control: no-store` and
  `/hls/*.ts` with `Cache-Control: public, max-age=60` plus CORS. Dev config:
  `config/nginx.hls.dev.conf`, service `nginx-hls` in `docker-compose.dev.yml`.
- Player: hls.js on Chrome/Firefox/Edge, native HLS on Safari/iOS. Start with
  `liveSyncDurationCount: 2` (~4 s measured); raise to 3 if mobile listeners
  stall, lower to 1 only for special low-latency use (~2 s, less buffer).
- HLS is optional (config flag). The primary listening path stays the
  progressive MP3/Opus mounts; HLS is for Apple/background and CDN scenarios.
- **Owner confirmation (2026-11-22):** after learning that upstream Icecast has no HLS,
  the decision is confirmed — HLS stays in v1 **behind a config flag**, off by default,
  with MP3/Opus as the primary path.

## Consequences

- nginx is now part of the deployment (also terminates TLS and proxies the API in
  M13); it is not an extra daemon class we did not already need.
- HLS latency is inherently 2-14 s depending on player tuning; do not use HLS
  for the interactive DJ console or the low-latency experience.
- The segment directory must be cleaned by FFmpeg (`delete_segments`) and should
  live on local disk or tmpfs; plan ~6 segments x ~26 KB ≈ 160 KB steady state
  per rendition.
- iOS Safari may require HTTPS for reliable HLS playback; TLS in M13 covers it.
- Firefox and Safari were not available on this Windows dev host; Chrome was
  verified, the others are expected to work via hls.js/native HLS and must be
  smoke-tested on the staging host.

## Verification

Reproduce (dev Icecast + nginx containers, then a 30 s stream):

```bash
docker compose -f docker-compose.dev.yml up -d icecast nginx-hls
pnpm spike:hls data/fixtures/music.wav 30
```

Measured (Windows dev host, FFmpeg 7.0.1):

| Metric                                      | Value                                             |
| ------------------------------------------- | ------------------------------------------------- |
| Playlist first available                    | **1.55-1.81 s** after FFmpeg start                |
| Segment duration                            | 2.005 s (one 1.984 s at a boundary)               |
| Playlist window                             | 6 segments, `#EXT-X-MEDIA-SEQUENCE` advancing     |
| Segment size                                | ~26 KB each (AAC 96k), 752 B for the partial tail |
| nginx playlist                              | 200, `application/vnd.apple.mpegurl`, `no-store`  |
| nginx segment                               | 200, `video/mp2t`, `max-age=60`                   |
| Chrome + hls.js, `liveSyncDurationCount: 1` | playback ok, **latency 2.1 s**                    |
| Chrome + hls.js, `liveSyncDurationCount: 2` | playback ok, **latency 4.1 s**                    |
| Chrome + hls.js, default (3)                | playback ok, latency 8-14 s (buffer-dependent)    |
| Console errors                              | none                                              |

Evidence: `data/spike/hls/spike-result.json`, `data/spike/hls/player.html`
(git-ignored; both are regenerated by `pnpm spike:hls`).

Icecast evidence: container reports `Icecast 2.4.4`; upstream 2.5.0 release notes
and latest config docs contain no HLS; the 2.6 milestone lists no HLS work.
