# ADR 0001 — FFmpeg PCM chain

- **Status:** Proposed
- **Date:** TBD (M0.4)
- **Related:** M0.4, M4, M5

## Context

The playout engine needs a low-latency, sample-accurate path from decoded media to Stereo Tool and the encoders.

## Options considered

1. FFmpeg per-track decode to raw PCM, JS mixer, FFmpeg encoders.
2. FFmpeg concat/filtergraph for the whole queue.
3. Liquidsoap.

## Decision

TBD after M0.4 spike.

## Consequences

TBD.

## Verification

TBD: latency, CPU, xruns, 10-minute stability run.
