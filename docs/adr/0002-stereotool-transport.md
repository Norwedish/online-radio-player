# ADR 0002 — Thimeo Stereo Tool transport

- **Status:** Proposed
- **Date:** TBD (M0.5)
- **Related:** M0.5, M5.1

## Context

Thimeo Stereo Tool 10 must process a continuous live stream on Linux, headless, inside an LXC. The exact `stereotool_cmd` streaming interface must be confirmed with the licensed binary.

## Options considered

1. Raw PCM over stdin/stdout.
2. Named FIFO with WAV headers.
3. Local TCP PCM stream.
4. ALSA loopback (requires kernel module/privileged LXC).
5. Passthrough (dev/staging only).

## Decision

TBD after M0.5 spike.

## Consequences

TBD.

## Verification

TBD: reproducible command, preset validation, license/edition detection, restart behavior, measured latency.
