# ADR 0002 — Thimeo Stereo Tool integration

- **Status:** Accepted — generic plugin library (libStereoTool), verified with SDK 11.08
- **Date:** 2026-11-22 (revised from the stdin/stdout CLI decision the same day)
- **Related:** M0.5, M5.1, M5.6

## Context

Thimeo Stereo Tool must process the station's continuous output on Linux, headless, inside an
unprivileged LXC with no sound hardware. Thimeo ships two Linux integrations:

1. `stereotool_cmd`, a command-line binary that filters audio between pipes.
2. The **generic plugin**: `Stereo_Tool_Generic_plugin.zip` with `libStereoTool_*.so` and a C API
   (`libStereoTool.h`). This is what **Liquidsoap's `stereotool` operator** (since 2.2) and
   therefore **AzuraCast** use. Liquidsoap's docs call out its much lower latency than the binary,
   and that it runs synchronously.

## Options considered

1. **Plugin library in-process** (Liquidsoap's way): dlopen + FFI inside the playout worker. Lowest
   overhead, but a crash or hang in proprietary native code would take the whole station off air.
2. **Plugin library in a small host process** (chosen): a child process loads the library via FFI and
   filters raw PCM between pipes.
3. CLI binary over stdin/stdout (the earlier decision; kept as a fallback).
4. ALSA loopback / network transports: need devices or edition-specific features; ruled out.

## Decision

**Option 2.** `apps/playout/bin/stereotool-host.mjs` loads the library with
[koffi](https://koffi.dev) (MIT, prebuilt binaries, no compiler needed) and follows the same call
sequence as Liquidsoap (`src/modules/stereotool/stereotool.ml`):

1. `stereoTool_global_setBindIp("127.0.0.1", "127.0.0.1")`: a preset that enables Stereo Tool's web
   or UECP server can never expose it beyond the host.
2. `stereoTool_Create3(has_gui = false, key, "radio-player", <data>/var/stereotool, load_ini = false)`
   (falls back to `stereoTool_Create(key)`). The key comes from the env var named by
   `stereotool.licenseKeyEnv`, never from the command line.
3. `stereoTool_LoadPreset(preset, loadType)`. The `ID_SAVE_*` enum **differs between SDK versions**:
   11.08 uses `20387` for TOTALINIT, older libraries (as hard-coded in Liquidsoap) `10387`. The host
   tries the current numbering, then the older one, and reports which worked; a number in
   `stereotool.presetLoadType` overrides this. The default load type is `totalinit` (as in
   Liquidsoap and AzuraCast).
4. `stereoTool_GetLatency2(48000, feed_silence = true)` (also primes the chain), then
   `CheckLicenseValid` / `GetUnlicensedUsedFeatures`, checked again after 10 s of real audio.
   An unlicensed library does not fail: it mixes beeps or voice into the audio. So a problem raises
   the `stereotool_unlicensed` alert (error) and the status shows `licensed`/`unlicensed`.
5. `stereoTool_Process` on interleaved float32 frames, in place, per chunk received.

The worker side is the existing adapter (`apps/playout/src/stereotool/adapter.ts`, mode `plugin`),
so the failure policy applies unchanged:

- Restart with exponential backoff.
- Kill after 5 s without output.
- Bypass (or hold silence) while it is down; give up after `restart.maxAttempts`
  (`stereotool_failed`); `stereotool_missing` when the library file is absent.

New for the plugin: until the host reports `ready`, audio is bypassed instead of queued, so library
start-up (or a restart) never adds permanent delay to the on-air signal.

Configuration (`station.json` → `stereotool`): `inputMode: "plugin"` (default) | `"stdio-pcm"`,
`library` (default `/opt/stereotool/libStereoTool_intel64.so`), `preset` (`.sts`),
`presetLoadType`, `licenseKeyEnv`. `install.sh --stereotool Stereo_Tool_Generic_plugin.zip` extracts
the headless (non-X11) library for the CPU (`intel64` / `arm64` / `intel32` / `arm32`, the same
selection as AzuraCast), records the SDK version and probes it.

### Findings from testing the real library (Windows + Linux builds)

- **The library prints to stdout itself.** For example, `stereoTool_Delete` writes
  `Waining for instance 1 to enter Disabled state...` (typo theirs) on Windows. On a stdout
  audio pipe that is 51 bytes of text in the PCM, which misaligns every following 4-byte frame
  (loud noise on air). So the worker always takes the processed PCM from a **dedicated pipe
  (fd 3, `STEREOTOOL_HOST_PCM_FD`)**, and the host's stdout is just logged. For manual tests,
  `--out FILE` writes the PCM to a file.
- **`stereoTool_Delete` must run before exit.** Without it, process exit deadlocks on the
  library's threads; with the Windows build the process could not even be killed (stuck in
  teardown until reboot). The host flushes the audio, then calls `Delete`, then exits.
- **Memory:** about **675 MB resident per instance** (38 threads) with default settings, on both
  Linux (`VmHWM` 690 920 kB) and Windows. Budget the host for it (see install.md sizing).

## Consequences

- No privileged container, no sound devices, no extra ports. The library needs the ALSA
  _userspace_ library (`libasound2t64` on Debian 13) to load. It probes ALSA/JACK at start and
  prints harmless messages, which the adapter filters out.
- A library crash costs a short bypass (the host restarts), not a station outage. This is
  verified with a deliberately crashing fake library.
- Latency: the library reports 85 ms (4096 samples at 48 kHz) with default settings. Pipe overhead
  is negligible.
- Memory: about 675 MB for the Stereo Tool instance, on top of the worker and API.
- The CLI path remains for stations that only have `stereotool_cmd`.

## Verification

| Check                                                                | Result                                                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Real library 11.08 (`libStereoTool_intel64.so`) in Debian 12 / 13    | Loads headless; software 11080, API 256; latency 85 ms; no listening ports with loopback bind        |
| C probe, 30 s of audio at default settings                           | 0.23 s CPU (0.8 % of one core); output level = input level (default preset is transparent)           |
| Host, 10 s tone through stdin/stdout                                 | Same byte count out; −18.1 dBFS in/out; 0.56 s CPU incl. start-up; licence re-check after 10 s       |
| `tests/integration/stereotool-plugin.test.ts` (real library, opt-in) | Adapter in plugin mode: 5 s in → 5 s out, −23.0 dBFS, status `plugin` running                        |
| Unit tests with a compiled fake library (CI)                         | PCM through koffi (×0.5), version/latency events, load-type fallback, licence alert, crash isolation |
| `install.sh --stereotool Stereo_Tool_Generic_plugin.zip` (Debian 13) | Extracts the arch's library, writes `.currentversion` (1108), sets `inputMode: plugin`, probe OK     |

**Still to do on the production host:** load the station's own `.sts` preset with the purchased
key, confirm `licensed` and no unlicensed features, and measure CPU with the real processing chain
on 2 vCPU (launch checklist).
