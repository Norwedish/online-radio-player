# ADR 0004 — Live studio transport

- **Status:** Proposed
- **Date:** TBD (M0.7)
- **Related:** M0.7, M8

## Context

A single DJ must go live from a browser with low latency (< 500 ms target) and the server must receive PCM for mixing and processing.

## Options considered

1. LiveKit self-hosted + browser client + Node PCM frames.
2. WebSocket + Opus (AudioWorklet/opus-recorder) + server decode.
3. External Icecast source (BUTT/Mixxx) pulled by FFmpeg.
4. Line-in/USB via ALSA (optional).

## Decision

TBD after M0.7 spike.

## Consequences

TBD.

## Verification

TBD: glass-to-air latency, CPU/RAM on 2 vCPU, browser support, failure/reconnect behavior.
