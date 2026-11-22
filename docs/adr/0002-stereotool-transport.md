# ADR 0002 — Thimeo Stereo Tool transport

- **Status:** Accepted (transport) · flags pending confirmation with the licensed binary (M0.5)
- **Date:** 2026-11-22
- **Related:** M0.5, M5.1, M5.6

## Context

Thimeo Stereo Tool 10 must process the station's continuous output on Linux, headless, inside an
unprivileged LXC with no sound hardware. The licensed binary was not available during development,
so the exact `stereotool_cmd` command line could not be measured.

## Options considered

1. **Raw PCM over stdin/stdout** — no devices, no kernel modules, one pipe each way, natural back
   pressure, works in unprivileged containers.
2. Named FIFO with WAV headers — same as 1 with extra filesystem plumbing.
3. Local TCP PCM stream — needs Stereo Tool's network input/output features (edition-dependent).
4. ALSA loopback — needs `snd-aloop` on the host and device passthrough; ruled out for LXC.
5. Passthrough — dev/CI and emergency fallback only.

## Decision

**Option 1, stdin/stdout PCM**, with a streaming WAV header on input and WAV-header stripping on
output (`stereotool.wavIo`, default on), 48 kHz / 16-bit / stereo. The command line is
configuration, not code: `stereotool.args` (default `["-", "-", "-s", "{preset}"]`) with
`{preset} {license} {licenseKey} {rate} {channels}` placeholders, so the M0.5 result is a config
change.

Implemented in `apps/playout/src/stereotool/adapter.ts`:

- `stdio-pcm` mode spawns the binary; `mock` mode (dev/CI) runs `scripts/mock-stereotool.mjs`;
  `stereotool.enabled: false` is an in-process passthrough (`bypass`).
- **Failure policy:** on exit, restart with exponential backoff (`restart.backoffMs`, doubling, max
  60 s); a process that produces no output for 5 s while being fed is treated as hung and killed.
  While it is down, audio passes through unprocessed (`bypassOnFailure`, default) or is held
  silent. After `restart.maxAttempts` consecutive failures it stays bypassed (`stereotool_failed`).
  A missing binary raises `stereotool_missing`. All are critical alerts.
- Input is dropped (not queued without bound) when more than 2 s is buffered in Stereo Tool's
  stdin; the licence key is redacted from logged stderr.

## Consequences

- No privileged container, no sound devices, no extra network ports.
- One extra process hop of latency (pipe buffering + Stereo Tool's own look-ahead); measured
  passthrough cost is negligible, real cost to be measured.
- The station stays on air if Stereo Tool crashes, at the cost of unprocessed audio until it
  recovers.

## Verification

- Unit tests (`apps/playout/src/stereotool/adapter.test.ts`): placeholder expansion, passthrough,
  PCM round-trip through the mock process with the WAV header stripped, bypass + restart + give-up
  sequence and alerts, silent hold without bypass, missing binary, stall detection.
- Integration test (`tests/integration/chain.test.ts`): the mock process is in the real chain and
  every Icecast mount is audible.
- **Pending (M0.5, needs the licensed binary):** confirm `stereotool.args` (does the edition
  accept `-` for stdin/stdout, WAV or raw), preset loading, licence/edition detection, restart
  behaviour, added latency and CPU on 2 vCPU. Command to run:

  ```bash
  ffmpeg -v error -f lavfi -i "sine=f=440:d=10" -ac 2 -ar 48000 -f wav - \
    | /opt/stereotool/stereotool_cmd - - -s /etc/radio/stereotool.sds \
    | ffprobe -v error -show_entries stream=codec_name,sample_rate,channels -
  ```
