#!/usr/bin/env node
/**
 * Stereo Tool plugin host (ADR 0002): loads Thimeo's generic plugin library
 * (libStereoTool_*.so from Stereo_Tool_Generic_plugin.zip) through koffi FFI
 * and processes the playout PCM stream:
 *
 *   stdin  — s16le, 48 kHz, stereo (raw, no header) from the playout worker
 *   stdout — the same format, processed by stereoTool_Process (in place)
 *   stderr — log lines; machine-readable events as `@stereotool {json}`
 *
 * It runs as a child process of radio-playout on purpose: a crash inside the
 * vendor library takes down only this process, and the worker's adapter
 * restarts it (with audio bypassed meanwhile). The same approach as
 * Liquidsoap's `stereotool` operator (dlopen + FFI, Create → LoadPreset →
 * GetLatency2(feed_silence) → license check → Process), out of process.
 *
 * Configuration comes from the STEREOTOOL_HOST environment variable (JSON):
 *   { library, preset?, loadType?, licenseKeyEnv?, home?, rate?, channels? }
 * The licence key itself is read from process.env[licenseKeyEnv] so it never
 * appears on a command line.
 *
 *   node stereotool-host.mjs           run as a filter (stdin → stdout)
 *   node stereotool-host.mjs --probe   load, report version/latency/licence, exit
 */
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Preset load types (ParameterEnum.h). The enum moved between SDK versions:
 * SDK 11.08 (API 256) uses 203xx, older libraries (as hard-coded in
 * Liquidsoap) 103xx. Candidates are tried in order; a number in the config
 * is used as-is.
 */
export const LOAD_TYPES = {
  totalinit: [20387, 10387],
  all_settings: [20386, 10386],
  audiofm: [20385, 10385],
  audio: [20384, 10384],
  processing: [20709, 10709],
};

/** @param {string|number|undefined} loadType */
export function loadTypeCandidates(loadType = "totalinit") {
  if (typeof loadType === "number") return [loadType];
  const c = LOAD_TYPES[loadType];
  if (!c) throw new Error(`unknown preset load type "${loadType}"`);
  return c;
}

/**
 * Binds the C API with koffi. Only the functions this host needs.
 * @param {string} path
 */
export async function bindLibrary(path) {
  const { default: koffi } = await import("koffi");
  const lib = koffi.load(path);
  koffi.opaque("gStereoTool");
  const opt = (proto) => {
    try {
      return lib.func(proto);
    } catch {
      return null; // symbol not exported by this library version
    }
  };
  return {
    softwareVersion: lib.func("int stereoTool_GetSoftwareVersion()"),
    apiVersion: lib.func("int stereoTool_GetApiVersion()"),
    setBindIp: opt("void stereoTool_global_setBindIp(const char *web, const char *uecp)"),
    enableInternalSoundCard: opt("void stereoTool_EnableInternalSoundCard(bool enabled)"),
    create: lib.func("gStereoTool *stereoTool_Create(const char *key)"),
    create3: opt(
      "gStereoTool *stereoTool_Create3(bool has_gui, const char *key, const char *st_name, const char *home_path, bool load_ini)",
    ),
    destroy: lib.func("void stereoTool_Delete(gStereoTool *st)"),
    loadPreset: lib.func(
      "bool stereoTool_LoadPreset(gStereoTool *st, const char *filename, int loadsave_type)",
    ),
    latency: lib.func(
      "int stereoTool_GetLatency2(gStereoTool *st, int32_t samplerate, bool feed_silence)",
    ),
    licenseValid: lib.func("bool stereoTool_CheckLicenseValid(gStereoTool *st)"),
    unlicensedFeatures: lib.func(
      "bool stereoTool_GetUnlicensedUsedFeatures(gStereoTool *st, void *text, int text_maxlen)",
    ),
    process: lib.func(
      "void stereoTool_Process(gStereoTool *st, void *samples, int32_t numsamples, int32_t channels, int32_t samplerate)",
    ),
  };
}

/**
 * Converts s16le byte chunks of any size into whole frames, runs them through
 * `process(float32Interleaved, frames)` and returns s16le bytes.
 */
export class PcmProcessor {
  /**
   * @param {(samples: Float32Array, frames: number) => void} process
   * @param {number} channels
   */
  constructor(process, channels = 2) {
    this.process = process;
    this.channels = channels;
    this.frameBytes = 2 * channels;
    this.rest = Buffer.alloc(0);
    this.floats = new Float32Array(0);
    this.framesProcessed = 0;
  }

  /** @param {Buffer} chunk */
  push(chunk) {
    const data = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const frames = Math.floor(data.length / this.frameBytes);
    const used = frames * this.frameBytes;
    this.rest = Buffer.from(data.subarray(used));
    if (frames === 0) return Buffer.alloc(0);
    const n = frames * this.channels;
    if (this.floats.length < n) this.floats = new Float32Array(n);
    const f = this.floats.subarray(0, n);
    for (let i = 0; i < n; i += 1) f[i] = data.readInt16LE(i * 2) / 32768;
    this.process(f, frames);
    const out = Buffer.allocUnsafe(n * 2);
    for (let i = 0; i < n; i += 1) {
      const v = Math.round(f[i] * 32768);
      out.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i * 2);
    }
    this.framesProcessed += frames;
    return out;
  }
}

/** Reads the NUL-terminated text Stereo Tool wrote into `buf`. */
export function cString(buf) {
  const end = buf.indexOf(0);
  return Buffer.from(buf.subarray(0, end < 0 ? buf.length : end))
    .toString("utf8")
    .trim();
}

/**
 * Creates and configures an instance: Create3 (no GUI) → LoadPreset → GetLatency2(feed_silence).
 * @param {Awaited<ReturnType<typeof bindLibrary>>} st
 */
export function openInstance(st, cfg, env = process.env) {
  const rate = cfg.rate ?? 48_000;
  const key = (cfg.licenseKeyEnv && env[cfg.licenseKeyEnv]) || null;
  // Never expose Stereo Tool's web/UECP servers beyond this host (a preset may enable them).
  st.setBindIp?.("127.0.0.1", "127.0.0.1");
  st.enableInternalSoundCard?.(false);
  let handle = null;
  if (st.create3) {
    const home = cfg.home ?? homedir();
    try {
      mkdirSync(home, { recursive: true });
    } catch {
      // the library falls back to its own default
    }
    handle = st.create3(false, key, "radio-player", home, false);
  }
  if (!handle) handle = st.create(key);
  if (!handle) throw new Error("stereoTool_Create returned NULL");
  let loadType = null;
  if (cfg.preset) {
    for (const t of loadTypeCandidates(cfg.loadType)) {
      if (st.loadPreset(handle, cfg.preset, t)) {
        loadType = t;
        break;
      }
    }
    if (loadType === null) {
      st.destroy(handle);
      throw new Error(`preset could not be loaded: ${cfg.preset}`);
    }
  }
  const latencySamples = st.latency(handle, rate, true);
  return { handle, loadType, latencySamples, rate };
}

export function licenseReport(st, handle) {
  const buf = new Uint8Array(1024);
  const ok = st.unlicensedFeatures(handle, buf, buf.length);
  return { valid: Boolean(st.licenseValid(handle)), unlicensedFeatures: ok ? "" : cString(buf) };
}

const emit = (event) => process.stderr.write(`@stereotool ${JSON.stringify(event)}\n`);

export async function main(argv = process.argv.slice(2), env = process.env) {
  let cfg;
  try {
    cfg = JSON.parse(env.STEREOTOOL_HOST ?? "{}");
  } catch {
    process.stderr.write("error: STEREOTOOL_HOST is not valid JSON\n");
    return 2;
  }
  if (!cfg.library) {
    process.stderr.write("error: STEREOTOOL_HOST.library is required\n");
    return 2;
  }
  let st;
  try {
    st = await bindLibrary(cfg.library);
  } catch (e) {
    process.stderr.write(`error: cannot load ${cfg.library}: ${e.message}\n`);
    return 2;
  }
  let inst;
  try {
    inst = openInstance(st, cfg, env);
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n`);
    return 3;
  }
  const channels = cfg.channels ?? 2;
  const ready = {
    event: "ready",
    softwareVersion: st.softwareVersion(),
    apiVersion: st.apiVersion(),
    latencyMs: Math.round((inst.latencySamples / inst.rate) * 1000),
    loadType: inst.loadType,
    ...licenseReport(st, inst.handle),
  };
  emit(ready);
  if (argv.includes("--probe")) {
    st.destroy(inst.handle);
    return 0;
  }

  const proc = new PcmProcessor(
    (samples, frames) => st.process(inst.handle, samples, frames, channels, inst.rate),
    channels,
  );
  // Licence check again once real audio has gone through (the API wants audio first).
  let licenseCheckedAt = 0;
  const recheckFrames = inst.rate * 10;

  return await new Promise((resolve) => {
    let closing = false;
    const close = (code) => {
      if (closing) return;
      closing = true;
      try {
        st.destroy(inst.handle);
      } catch {
        // exiting anyway
      }
      resolve(code);
    };
    process.stdout.on("error", (e) => close(e.code === "EPIPE" ? 0 : 1));
    process.stdin.on("data", (chunk) => {
      const out = proc.push(chunk);
      if (out.length && !process.stdout.write(out)) {
        process.stdin.pause();
        process.stdout.once("drain", () => process.stdin.resume());
      }
      if (licenseCheckedAt === 0 && proc.framesProcessed >= recheckFrames) {
        licenseCheckedAt = proc.framesProcessed;
        emit({ event: "license", ...licenseReport(st, inst.handle) });
      }
    });
    process.stdin.on("end", () => close(0));
    process.stdin.on("error", () => close(1));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
