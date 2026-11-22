# ADR 0004 — Live DJ transport: WebSocket PCM studio + Icecast ingest

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Norwedish
- **Related:** M0.7, M8 (live studio), M4 (mixer), M5 (output chain)

## Context

The station needs a live DJ path with two entry points:

- **Browser studio** (M8): a DJ opens `/studio`, grants mic access, and their voice
  is mixed into the playout with ducking. Low latency matters here because the DJ
  hears the program through a monitor.
- **External encoder** (required for guest DJs and hardware): someone points BUTT,
  Mixxx, or an Icecast source client at the station.

Constraints: one DJ at a time, 2 vCPU / 4 GB LXC, no heavy extra services, and a
mixer that consumes PCM (48 kHz / 16-bit / stereo, see ADR 0001).

The spike measured the two realistic transport choices on the dev host:
WebSocket PCM from a browser page, and MP3 128k through Icecast ingest.

## Options considered

1. **WebSocket PCM (browser studio)** — measured
   - Pros: no new service; WebAudio + WebSocket work in every target browser; the
     server receives raw PCM and can hand it straight to the mixer; ~1 ms arrival
     latency locally; trivially debuggable (binary frames, timestamps).
   - Cons: uncompressed bandwidth (~1.5 Mbps stereo, 0.77 Mbps mono); TCP
     head-of-line blocking (needs a jitter buffer and late-frame dropping); no
     packet-loss concealment.
2. **WebRTC via LiveKit** — evaluated, not deployed
   - Pros: jitter buffer, FEC/PLC, NAT traversal via SFU, best under lossy WAN.
   - Cons: an extra Go SFU (memory + UDP ports/TURN) on a 2 vCPU host for a
     single DJ; heavier SDK and deployment surface; no measured benefit locally.
   - Kept as the documented upgrade path if multi-DJ/remote guests or poor
     networks demand it.
3. **MediaRecorder (Opus/WebM) over WebSocket** — rejected
   - Browsers buffer WebM chunks (~0.5-2 s) before emitting them, and the server
     would need to demux/decode before mixing. Too much latency and complexity
     for the studio path.
4. **Icecast ingest (external encoder)** — measured, kept for external DJs
   - Pros: works with every existing encoder; the source password can be issued
     per DJ session; one mount (`/live`) is enough for one DJ at a time.
   - Cons: no browser studio integration, encoder buffers add 100-500 ms, and the
     worker must decode the incoming stream to PCM before mixing.

## Decision

- **Browser studio = WebSocket PCM** (48 kHz, 16-bit; stereo preferred, mono
  fallback when uplink is constrained) with a 150-250 ms jitter buffer in the
  mixer. The API enforces one active DJ and issues a short-lived token for the WS
  connection. Late frames are dropped, not queued indefinitely.
- **External DJs = Icecast `/live` ingest** with a per-session source password;
  the playout worker decodes that mount to PCM when live and mixes it like any
  other live source.
- Both transports land on the same mixer input contract (`LiveSource` producing
  PCM frames), so ducking, monitoring and recording work identically.
- LiveKit is deferred. Revisit if multi-DJ sessions, remote co-hosts, or lossy
  WAN links become requirements.

## Consequences

- Uplink bandwidth per studio DJ is ~1.5 Mbps stereo / ~0.77 Mbps mono; document
  this in the studio preflight check and fall back to mono automatically.
- TCP head-of-line blocking is mitigated by the jitter buffer and frame dropping;
  heavy packet loss will be audible as gaps. Acceptable for v1; LiveKit is the
  escalation path.
- The Icecast ingest path adds the encoder's own buffer (100-500 ms) on top of
  the measured server transit; external DJs should be told their local buffer
  setting is the dominant latency term.
- Recording (M8) taps the same PCM stream, so recordings exist regardless of the
  transport used.
- The WS server must validate origin, token and sample rate; reject a second
  concurrent DJ with a clear error.

## Verification

Reproduce:

```bash
# WebSocket PCM uplink: serve http://127.0.0.1:8090/ and click "Start uplink"
pnpm spike:live-ws 20

# Icecast ingest: publishes a 1 kHz marker burst every 2 s to /live-test
pnpm spike:live-icecast 30
```

Results (`data/spike/live/*.json`, git-ignored):

| WebSocket PCM (mono 48k) | Value                                              |
| ------------------------ | -------------------------------------------------- |
| Frames over 20 s         | 936                                                |
| Arrival latency          | avg **0.89 ms**, p50 0.5 ms, p95 1.7 ms, max 25 ms |
| Jitter                   | 2.03 ms                                            |
| Sequence gaps            | **0**                                              |
| Throughput               | 772.9 kbps (mono 16-bit; stereo ≈ 1.55 Mbps)       |
| Server CPU               | 0.124 s for the 20 s run                           |

| Icecast ingest (MP3 128k, `/live-test`) | Value                                      |
| --------------------------------------- | ------------------------------------------ |
| Marker bursts matched                   | 15 / 15                                    |
| Source -> listener latency              | avg **76.9 ms**, p50 **47 ms**, p95 124 ms |
| Startup burst                           | 672 ms (first listener burst buffer)       |
| Measurement resolution                  | ~55 ms (`-progress` samples)               |

Caveats: both runs were on localhost, so they exclude WAN round-trip time. Add
the DJ's RTT plus the mixer jitter buffer (150-250 ms) for a realistic
glass-to-air estimate: ~0.3-0.5 s for the browser studio on a good connection,
~0.5-1.5 s for an external encoder depending on its buffer settings. CPU numbers
are from the Windows dev host and must be re-measured on the Debian 13 target.
