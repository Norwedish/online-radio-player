# ADR 0001 — FFmpeg PCM chain

- **Status:** Accepted (M0.4 spike, 2026-11-21)
- **Date:** 2026-11-21
- **Deciders:** AI pair + self (solo)
- **Related:** M0.4, M4 (playout engine), M5 (encoders), ADR 0002 (Stereo Tool transport)

## Context

The playout engine must move audio from library files to listeners with:

- **sample-accurate, fixed-format** intermediate audio (48 kHz / 16-bit stereo, per ADR-less plan decision in `PLAN.md`),
- **low latency** to the mount, because interactive controls (skip, play-now, DJ takeover) must not wait for a new process tree to warm up,
- **a single hand-off to Thimeo Stereo Tool**, which is a standalone commercial CLI, not a library,
- **bounded CPU on a 2 vCPU / 4 GB Debian 13 host.**

Constraints that matter: Stereo Tool reads/writes raw audio; the encoders must be able to
run continuously (a per-track encoder spawn would insert a gap and a reconnect); and pipe
buffering decides how fast the first byte reaches Icecast.

## Options considered

1. **Per-track FFmpeg decode → raw PCM pipes → (Stereo Tool) → continuous FFmpeg encoders → Icecast.**
   Pros: no transcode step per track, sample-accurate framing via `-re`, encoders stay alive so the
   stream never reconnects, trivially debuggable. Cons: three process trees, pipe plumbing in JS.
2. **One FFmpeg filtergraph per hour/queue** (`concat` + `filtergraph`).
   Pros: one process. Cons: no interactive controls after the graph is built, unusable for
   skip/takeover, memory grows with the queue.
3. **Liquidsoap / AzuraCast-style decoder pipeline.**
   Cons: the plan explicitly requires a custom Node/TS engine with no Liquidsoap runtime;
   the decode/encode plumbing would still be FFmpeg underneath.

## Decision

**Option 1**, with these exact constraints, all of which were measured in M0.4:

1. **PCM contract:** `s16le`, **48 000 Hz**, **2 channels**, real-time framing (`-re` on every
   FFmpeg process). This is the wire format between decoder → Stereo Tool → encoders.
2. **Encoders are long-lived**, spawned once per mount and fed by PCM pipes; they are **never**
   spawned per track.
3. **`-analyzeduration 0` and `-probesize 32768` are required on every pipe-fed FFmpeg input.**
   This is the single biggest finding of the spike (see Verification).
4. **Mock Stereo Tool** (`scripts/mock-stereotool.mjs`) is a passthrough used only on
   Windows/macOS development hosts; on the Linux target the real Thimeo CLI replaces it in
   the same pipe position (ADR 0002).
5. MP3 mount is encoded with `libmp3lame -b:a 320k`, `-f mp3`,
   `-content_type audio/mpeg`, delivered over `icecast://` (PUT) directly to Icecast.

## Consequences

**Easier**

- Interactive controls are possible: the encoder holds the mount, so a skip is just more
  PCM downstream, not a new connection.
- Sample-accurate cuts: framing is deterministic in the JS mixer, not inside FFmpeg's graph.
- Each stage is independently replaceable (mock ST ↔ real ST, `icecast://` ↔ file for testing).

**Harder / required**

- JS must own pipe plumbing: backpressure, `EPIPE` handling, and clean shutdown of a 3-stage
  process tree (implemented in `scripts/spike-ffmpeg-chain.mjs` and reused in M4).
- **Pipe buffering sets a floor on latency:** decoder → Node (64 KB high-water mark) →
  encoder (32 KB `probesize`) means the first byte is not free; with tuning it measured
  ~120–180 ms, without it, ~4 s. Latency budget must be designed around this, not 0 ms.
- **CPU must be measured on Linux**, not Windows (see Verification, "CPU caveat").
- Three long-lived processes must be supervised by the worker (restart on exit,
  log ring buffer, and a watchdog) — otherwise a silent encoder death kills the stream.

**Must revisit**

- Whether Stereo Tool can sit at the head of the chain (one encoder set) or must be
  duplicated per output bitrate — decided in ADR 0002.
- Whether HLS (`/hls`) shares the same PCM or re-encodes from the mount — ADR 0003.

## Verification

Spike script: **`scripts/spike-ffmpeg-chain.mjs`** (reproducible; args
`[input] [seconds] [mount]`).

### Environment

- FFmpeg **7.0.1** (`ffmpeg 7.0.1-full_build`), Node **v26.12.1**, host **win32** (dev host, not the deploy target).
- Icecast **2.4.4** via `docker-compose.dev.yml` (`moul/icecast`), mount `/hq.mp3`, port 8000.
  The deploy target pins Icecast 2.5/2.6; the 2.4.4 delta is tracked in M0.6.

### Commands (reproducible)

Fixtures:

```bash
ffmpeg -y -v error -f lavfi -i "sine=frequency=1000:sample_rate=48000:duration=60" -ac 2 -c:a pcm_s16le data/fixtures/tone.wav
ffmpeg -y -v error -f lavfi -i "aevalsrc=0.18*sin(2*PI*220*t)+0.12*sin(2*PI*277.18*t)+0.08*sin(2*PI*329.63*t):s=48000:d=90" -af "tremolo=f=3:d=0.35,volume=0.8" -ac 2 -c:a pcm_s16le data/fixtures/music.wav
```

Chain (as encoded in the spike script):

```bash
ffmpeg -hide_banner -nostats -benchmark -re -i data/fixtures/music.wav -t 20 -f s16le -ar 48000 -ac 2 pipe:1 \
  | node scripts/mock-stereotool.mjs \
  | ffmpeg -hide_banner -nostats -benchmark -probesize 32768 -analyzeduration 0 \
      -f s16le -ar 48000 -ac 2 -i pipe:0 -c:a libmp3lame -b:a 320k -f mp3 \
      -content_type audio/mpeg "icecast://source:<pw>@127.0.0.1:8000/hq.mp3"
```

Run the spike: `node scripts/spike-ffmpeg-chain.mjs data/fixtures/music.wav 20 hq.mp3`

### Measured

| Metric                                                        | Tuned (`-analyzeduration 0 -probesize 32768`)         | Untuned (FFmpeg defaults) |
| ------------------------------------------------------------- | ----------------------------------------------------- | ------------------------- |
| Encoder opens Icecast connection                              | **102 ms**                                            | 3 761 ms                  |
| Mount visible in `status-json.xsl`                            | **267–464 ms**                                        | 3 814–4 037 ms            |
| Listener first byte after mount                               | **117–177 ms** (min 12 ms when data already buffered) | same order                |
| Delivered bitrate (`ffprobe` on capture)                      | **320 053–320 975 bps** (nominal 320 k)               | same                      |
| Capture length decoded from a 256 KB window                   | **6.57–6.60 s**, format `mp3`                         | same                      |
| Independent decode of capture (`ffmpeg -i capture -f null -`) | **exit 0**                                            | same                      |

**Key finding:** with FFmpeg's default `analyzeduration` (5 s) / `probesize` (5 MB), an
encoder reading a **real-time PCM pipe** spends **~3.7 s** probing before it even opens the
Icecast connection — FFmpeg cannot know the raw stream bounds, so it analyzes until it has
enough. Forcing `-analyzeduration 0 -probesize 32768` (safe because `-f s16le -ar -ac` fully
describe the input) cut this to **~100 ms**. Cold-start therefore is a **tuning** matter,
not a hard cost.

**Stability soak (passed):** `node scripts/spike-ffmpeg-chain.mjs data/fixtures/music.wav 600 hq.mp3`
→ `data/fixtures/spike-soak-600.json`. The fixture is 90 s, so the spike added
`-stream_loop -1` when the requested duration exceeds the input length (otherwise `-t 600`
on a 90 s file silently ends after 90 s — that is exactly what an earlier attempt did, so
**always check `wallSeconds` ≈ `requestedSeconds`**).

| Soak metric             | Value                                       |
| ----------------------- | ------------------------------------------- |
| Wall clock              | 600.2 s (`streamLoop: true`)                |
| Mount polls (every 5 s) | 118                                         |
| **Mount missing**       | **0**                                       |
| Startup / first byte    | 372 ms / 111 ms                             |
| Decoder CPU             | 1.89 s (0.32 %)                             |
| Mock ST CPU             | 1.33 s (0.22 %)                             |
| MP3 encoder CPU         | 8.20 s (1.37 %)                             |
| Combined                | 11.42 s = **0.019 cores of 2 vCPU (≈ 1 %)** |
| Exit codes              | decoder 0, mock 0, encoder 0                |

### CPU caveat (must re-measure on target)

FFmpeg's `-benchmark` on this Windows host reports **implausibly low** `utime`/`stime`
(0.000–0.063 s over a 20 s run) and the decoder reported `utime=0 stime=0`. Separately,
Windows per-process CPU counters are unreliable because FFmpeg here is a **Scoop shim**
(`C:\Users\Norwedish\scoop\shims\ffmpeg.exe`) that launches the real binary as a child
process. **Conclusion: CPU numbers must come from the Linux target** (Debian 13, 2 vCPU),
where `utime`/`stime` from `-benchmark` and `time`/`top` are meaningful. Do not size the
2-vCPU budget off anything measured here. The mock Stereo Tool measured 0.03–0.11 s CPU
over 20 s wall (negligible), which only bounds the _Node_ passthrough, not real ST.

### Dev-host gotcha: FFmpeg exit codes are unreliable on Windows

On this dev host FFmpeg resolves to a **Scoop shim**, and `spawnSync` returns
`exitCode: undefined` even when the command **succeeded** (verified: `probe.wav` was
written correctly). Consequences for `scripts/make-fixtures.mjs`: it treats an
unavailable exit code as unknown and **validates the produced artifact with `ffprobe`**
(codec `pcm_s16le`, 48 000 Hz, 2 channels, expected duration) instead of trusting the
exit code. On the Linux target, exit codes are reliable and this path is a no-op.

**Rule for the engine:** never treat an FFmpeg spawn as failed/succeeded by exit code
alone on Windows dev hosts — probe the output. Keep that behaviour for the dev
tooling; production playout runs only on Linux.

### Second dev-host finding: always set `-content_type` on `icecast://` outputs

FFmpeg's icecast muxer sniffs the **first 8 bytes** of the outgoing stream and only
recognises Ogg (`OggS`), WebM and Opus (`OpusHead`) magic. MP3 (ID3 or `0xFF 0xFB` frame
sync) therefore falls through to:

```
[icecast @ …] It seems you are streaming an unsupported format.
[icecast @ …] It might work, but is not officially supported in Icecast!
```

The check is skipped entirely when `content_type` is set (`libavformat/icecast.c`,
`icecast_write()`), so passing `-content_type audio/mpeg` silences it. Verified on this
repo's dev Icecast 2.4.4 mount `/mobile.mp3`: without the flag the warning prints, with it
the run is clean and `status-json.xsl` reports `server_type: audio/mpeg`, tone
`mean_volume -24.1 dB / max_volume -21.0 dB` at 320 k.

**Rule for the engine:** every mount passes its content type explicitly —
MP3 `audio/mpeg`, Opus `audio/ogg`, AAC `audio/aac` — because FFmpeg's default is
`audio/mpeg` and would otherwise mislabel the non-MP3 mounts.

## Third finding (2026-11-22, M11): browser start-up time per codec

Measured in Chrome (Linux) against the live chain (`pnpm demo`), time from `audio.play()` to
the first `timeupdate`:

| Mount                 | Start-up |
| --------------------- | -------- |
| `/hq.mp3` (320k)      | 5.3 s    |
| `/mobile.mp3` (128k)  | 4.7 s    |
| `/aac.aac` (96k ADTS) | 0.6 s    |
| `/opus.ogg` (96k)     | 1.0 s    |

The MP3 delay is Chrome's own probing of a headerless live MP3 stream: it is identical with a
bare `ffmpeg -f lavfi … -f mp3 icecast://` source, with `-write_xing 0 -id3v2_version 0`, at
128k, and with or without the nginx/API proxy. It is not caused by Icecast burst size or by
this chain. The listener page therefore keeps the station's `primary` mount as the default
(stations that care about instant start can mark the AAC mount primary) and shows a
"connecting" state while the browser buffers.
