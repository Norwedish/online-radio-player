/**
 * Thimeo Stereo Tool adapter (PLAN §6.5 / M5.1, ADR 0002).
 *
 * The mixer's 48 kHz s16le stereo PCM goes to `stereotool_cmd` on stdin and
 * the processed PCM comes back on stdout (optionally wrapped in a streaming
 * WAV header both ways — `stereotool.wavIo`). The exact command line is
 * configuration (`stereotool.args` with `{preset} {license} {licenseKey}
 * {rate} {channels}` placeholders) until the M0.5 spike confirms the flags
 * against the licensed binary.
 *
 * Failure policy (M5.6): a dead or stalled process is restarted with
 * exponential backoff; while it is down, and after `restart.maxAttempts`
 * consecutive failures, audio is passed through unprocessed when
 * `bypassOnFailure` is set so the station stays on air (critical alert),
 * otherwise the output is held silent.
 *
 * Modes:
 * - `plugin`    — default: Thimeo's generic plugin library (libStereoTool_*.so)
 *                 loaded by `apps/playout/bin/stereotool-host.mjs` (koffi FFI) in a
 *                 child process — same API use as Liquidsoap's `stereotool`
 *                 operator, but a crash in the library cannot take the worker down.
 * - `stdio-pcm` — legacy: the `stereotool_cmd` command-line binary.
 * - `mock`      — dev/CI: `scripts/mock-stereotool.mjs` passthrough process.
 * - `bypass`    — Stereo Tool disabled in config: input → output untouched.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BYTES_PER_FRAME, CHANNELS, SAMPLE_RATE } from "@radio/core";
import { secret, type RuntimeConfig, type StereoToolStatus, type WorkerAlert } from "@radio/shared";
import { streamingWavHeader, WavStripper } from "../audio/wav.js";

export type StereoToolConfig = RuntimeConfig["stereotool"];

export interface StereoToolAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Feed one block of mixer PCM (s16le, 48 kHz, stereo). */
  writePcm(pcm: Buffer): void;
  /** Processed (or bypassed) PCM, in order. */
  onOutput(cb: (chunk: Buffer) => void): void;
  status(): StereoToolStatus;
}

export interface StereoToolOptions {
  mock: boolean;
  mockScript: string;
  log: (m: string) => void;
  alert: (a: WorkerAlert) => void;
  /** No output for this long while fed → treat as hung and restart. */
  stallMs?: number;
  /** Max audio buffered in Stereo Tool's stdin before input is dropped. */
  maxBufferSeconds?: number;
  /** Plugin mode: the host script (defaults to apps/playout/bin/stereotool-host.mjs). */
  hostScript?: string;
  /** Plugin mode: Stereo Tool's home directory for its own settings files. */
  homeDir?: string;
  /** Licence key file; when present it wins over `licenseKeyEnv`. */
  keyFile?: string;
}

/** Licence key: the key file (installer/console) first, then the env var. */
export function readLicenseKey(envName: string, keyFile?: string): string {
  if (keyFile && existsSync(keyFile)) {
    const k = readFileSync(keyFile, "utf8").trim();
    if (k) return k;
  }
  return secret(envName) ?? "";
}

/** What the plugin host reported (`@stereotool {json}` lines on stderr). */
export interface PluginInfo {
  softwareVersion: number;
  apiVersion: number;
  latencyMs: number;
  loadType: number | null;
  valid: boolean;
  unlicensedFeatures: string;
}

/** Library chatter (ALSA/JACK probing, realtime priority) that is not an error. */
const NOISE =
  /^(ALSA lib |Cannot connect to server|jack server|JackShm|Jack: |Warning: Cannot set realtime|Cannot lock down|Wai(t)?ning for instance \d+ to enter)/;

export const DEFAULT_HOST_SCRIPT = fileURLToPath(
  new URL("../../bin/stereotool-host.mjs", import.meta.url),
);

/** Expands `{preset}`-style placeholders in the configured argument list. */
export function expandArgs(
  args: readonly string[],
  values: Record<"preset" | "license" | "licenseKey" | "rate" | "channels", string>,
): string[] {
  return args.map((a) =>
    a.replace(/\{(preset|license|licenseKey|rate|channels)\}/g, (_m, k: keyof typeof values) =>
      String(values[k] ?? ""),
    ),
  );
}

class PassthroughStereoTool implements StereoToolAdapter {
  private out: ((chunk: Buffer) => void)[] = [];
  constructor(private readonly enabled: boolean) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  writePcm(pcm: Buffer): void {
    for (const cb of this.out) cb(pcm);
  }
  onOutput(cb: (chunk: Buffer) => void): void {
    this.out.push(cb);
  }
  status(): StereoToolStatus {
    return {
      enabled: this.enabled,
      running: false,
      bypassed: true,
      mode: "bypass",
      edition: null,
      restarts: 0,
      error: null,
    };
  }
}

export class ProcessStereoTool implements StereoToolAdapter {
  private proc: ChildProcess | null = null;
  private out: ((chunk: Buffer) => void)[] = [];
  private stripper: WavStripper | null = null;
  private stopped = true;
  private failures = 0;
  private startedAt = 0;
  private lastOutputAt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private gaveUp = false;
  private droppedBytes = 0;
  restarts = 0;
  error: string | null = null;
  info: PluginInfo | null = null;
  /** False while the plugin host is still initialising (CLI/mock: always true). */
  private ready = true;

  constructor(
    private readonly config: StereoToolConfig,
    private readonly opts: StereoToolOptions,
    readonly mode: "mock" | "stdio-pcm" | "plugin",
    private readonly command: string,
    private readonly args: string[],
    private readonly redactions: string[] = [],
    private readonly env?: NodeJS.ProcessEnv,
  ) {}

  /** Plugin mode passes raw PCM; the CLI may want WAV framing. */
  private get wavIo(): boolean {
    return this.mode !== "plugin" && this.config.wavIo;
  }

  private redact(text: string): string {
    let t = text;
    for (const r of this.redactions) if (r) t = t.split(r).join("***");
    return t;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.gaveUp = false;
    this.failures = 0;
    this.spawnProcess();
  }

  private spawnProcess(): void {
    const required =
      this.mode === "plugin"
        ? { path: this.config.library, what: "Stereo Tool plugin library" }
        : this.mode === "stdio-pcm"
          ? { path: this.command, what: "stereotool_cmd" }
          : null;
    if (required && !existsSync(required.path)) {
      this.error = `${required.what} not found at ${required.path}`;
      this.giveUp("stereotool_missing");
      return;
    }
    // Plugin mode: PCM comes back on its own pipe (fd 3) because the vendor library prints to
    // stdout by itself; stdout is then just more log text.
    const plugin = this.mode === "plugin";
    const proc = spawn(this.command, this.args, {
      windowsHide: true,
      stdio: plugin ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      ...(this.env || plugin
        ? {
            env: {
              ...(this.env ?? process.env),
              ...(plugin ? { STEREOTOOL_HOST_PCM_FD: "3" } : {}),
            },
          }
        : {}),
    });
    this.proc = proc;
    this.startedAt = Date.now();
    this.lastOutputAt = this.startedAt;
    this.ready = !plugin;
    this.stripper = this.wavIo ? new WavStripper() : null;
    proc.stdin!.on("error", () => {
      /* the close handler restarts */
    });
    if (this.wavIo) proc.stdin!.write(streamingWavHeader(SAMPLE_RATE, CHANNELS, 16));
    const pcmOut = (plugin ? proc.stdio[3] : proc.stdout) as NodeJS.ReadableStream;
    pcmOut.on("data", (d: Buffer) => {
      if (this.proc !== proc) return;
      this.lastOutputAt = Date.now();
      const pcm = this.stripper ? this.stripper.push(d) : d;
      if (pcm.length > 0) this.emit(pcm);
    });
    pcmOut.on("error", () => {
      /* the close handler restarts */
    });
    const onText = (d: Buffer) => {
      for (const raw of this.redact(d.toString()).split("\n")) {
        const line = raw.trim();
        if (!line || NOISE.test(line)) continue;
        if (line.startsWith("@stereotool ")) {
          this.onPluginEvent(line.slice(12));
          continue;
        }
        this.opts.log(`stereotool: ${line.slice(0, 500)}`);
        if (/error|invalid|licen[cs]e/i.test(line)) this.error = line.slice(0, 300);
      }
    };
    proc.stderr!.on("data", onText);
    if (plugin) proc.stdout!.on("data", onText);
    proc.on("error", (e) => {
      this.error = this.redact(e.message);
    });
    proc.on("close", (code, signal) => this.onExit(proc, code, signal));
    this.opts.log(`stereotool started (${this.mode}, pid ${proc.pid ?? "?"})`);
  }

  private onPluginEvent(json: string): void {
    let ev: { event?: string } & Partial<PluginInfo>;
    try {
      ev = JSON.parse(json);
    } catch {
      return;
    }
    if (ev.event === "ready") {
      this.ready = true;
      this.lastOutputAt = Date.now();
      this.info = {
        softwareVersion: ev.softwareVersion ?? 0,
        apiVersion: ev.apiVersion ?? 0,
        latencyMs: ev.latencyMs ?? 0,
        loadType: ev.loadType ?? null,
        valid: ev.valid ?? false,
        unlicensedFeatures: ev.unlicensedFeatures ?? "",
      };
      this.opts.log(
        `stereotool plugin ${formatVersion(this.info.softwareVersion)} ready (API ${this.info.apiVersion}, latency ${this.info.latencyMs} ms, ${this.info.loadType !== null ? `preset load type ${this.info.loadType}` : "no preset"})`,
      );
    } else if (ev.event === "license" && this.info) {
      this.info = {
        ...this.info,
        valid: ev.valid ?? this.info.valid,
        unlicensedFeatures: ev.unlicensedFeatures ?? "",
      };
    } else return;
    if (!this.info.valid || this.info.unlicensedFeatures)
      this.opts.alert({
        type: "stereotool_unlicensed",
        severity: "error",
        message: `Stereo Tool licence does not cover the active preset${this.info.unlicensedFeatures ? `: ${this.info.unlicensedFeatures}` : ""} — the library may add beeps or voice-overs to the audio`,
        details: { version: this.info.softwareVersion },
      });
  }

  private onExit(proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.proc !== proc) return;
    this.proc = null;
    if (this.stopped) return;
    const ranMs = Date.now() - this.startedAt;
    this.failures = ranMs > 30_000 ? 1 : this.failures + 1;
    this.error = this.error ?? `exited code=${code} signal=${signal}`;
    if (this.failures > this.config.restart.maxAttempts) {
      this.giveUp("stereotool_failed");
      return;
    }
    const delay = Math.min(this.config.restart.backoffMs * 2 ** (this.failures - 1), 60_000);
    this.opts.log(
      `stereotool exited (code=${code}, signal=${signal}); ${this.config.bypassOnFailure ? "bypassing" : "holding output"} and restarting in ${delay} ms`,
    );
    if (this.failures === 1)
      this.opts.alert({
        type: "stereotool_bypass",
        severity: this.config.bypassOnFailure ? "critical" : "error",
        message: this.config.bypassOnFailure
          ? `Stereo Tool stopped (${this.error}); audio is on air unprocessed while it restarts`
          : `Stereo Tool stopped (${this.error}); output is silent while it restarts`,
        details: { mode: this.mode, code, signal },
      });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopped) return;
      this.restarts += 1;
      this.spawnProcess();
    }, delay);
  }

  private giveUp(type: string): void {
    this.gaveUp = true;
    this.opts.alert({
      type,
      severity: "critical",
      message: this.config.bypassOnFailure
        ? `Stereo Tool unavailable (${this.error}); station is on air unprocessed`
        : `Stereo Tool unavailable (${this.error}); output is silent`,
      details: { mode: this.mode, restarts: this.restarts },
    });
  }

  private emit(pcm: Buffer): void {
    for (const cb of this.out) cb(pcm);
  }

  writePcm(pcm: Buffer): void {
    const proc = this.proc;
    const stdin = proc?.stdin;
    if (!proc || !stdin || stdin.destroyed) {
      if (this.config.bypassOnFailure) this.emit(pcm);
      return;
    }
    const now = Date.now();
    const stallMs = this.opts.stallMs ?? 5000;
    if (now - this.lastOutputAt > stallMs && now - this.startedAt > stallMs) {
      this.error = `no output for ${Math.round((now - this.lastOutputAt) / 1000)} s`;
      this.opts.log(`stereotool stalled (${this.error}); killing`);
      proc.kill("SIGKILL");
      if (this.config.bypassOnFailure) this.emit(pcm);
      return;
    }
    // Plugin host still loading the library/preset: pass audio through instead of queueing
    // it, so a (re)start never adds permanent delay to the on-air signal.
    if (!this.ready) {
      if (this.config.bypassOnFailure) this.emit(pcm);
      return;
    }
    const maxBytes = (this.opts.maxBufferSeconds ?? 2) * SAMPLE_RATE * BYTES_PER_FRAME;
    if (stdin.writableLength > maxBytes) {
      this.droppedBytes += pcm.length;
      return;
    }
    stdin.write(pcm);
  }

  onOutput(cb: (chunk: Buffer) => void): void {
    this.out.push(cb);
  }

  get running(): boolean {
    return this.proc !== null;
  }

  status(): StereoToolStatus {
    const healthy = this.running && Date.now() - this.startedAt > 10_000;
    return {
      enabled: true,
      running: this.running,
      bypassed: (!this.running || !this.ready) && this.config.bypassOnFailure,
      mode: this.mode,
      edition:
        this.mode === "mock"
          ? "mock"
          : this.mode === "plugin" && this.info
            ? `${formatVersion(this.info.softwareVersion)} ${this.info.valid && !this.info.unlicensedFeatures ? "licensed" : "unlicensed"}`
            : this.config.edition,
      restarts: this.restarts,
      error: healthy ? null : this.error,
    };
  }

  /** True once restart attempts are exhausted (stays bypassed until restart()). */
  get exhausted(): boolean {
    return this.gaveUp;
  }

  get dropped(): number {
    return this.droppedBytes;
  }

  /** Test/ops helper: kill the process to exercise restart/bypass. */
  kill(): void {
    this.proc?.kill("SIGKILL");
  }

  stop(graceMs = 2000): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const proc = this.proc;
    this.proc = null;
    if (!proc) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // already gone
        }
        resolve();
      }, graceMs);
      proc.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        proc.stdin!.end();
      } catch {
        proc.kill("SIGTERM");
      }
    });
  }
}

/** 11080 → "v11.08" */
export function formatVersion(v: number): string {
  if (v <= 0) return "v?";
  return `v${Math.floor(v / 1000)}.${String(Math.floor((v % 1000) / 10)).padStart(2, "0")}`;
}

export function createStereoTool(
  config: StereoToolConfig,
  opts: StereoToolOptions,
): StereoToolAdapter {
  if (!config.enabled) return new PassthroughStereoTool(false);
  if (opts.mock)
    return new ProcessStereoTool(config, opts, "mock", process.execPath, [opts.mockScript]);
  const licenseKey = readLicenseKey(config.licenseKeyEnv, opts.keyFile);
  if (config.inputMode === "plugin") {
    const hostConfig = {
      library: config.library,
      preset: config.preset,
      loadType: config.presetLoadType,
      licenseKeyEnv: config.licenseKeyEnv,
      home: opts.homeDir,
      rate: SAMPLE_RATE,
      channels: CHANNELS,
    };
    return new ProcessStereoTool(
      config,
      opts,
      "plugin",
      process.execPath,
      [opts.hostScript ?? DEFAULT_HOST_SCRIPT],
      [licenseKey],
      {
        ...process.env,
        // The host reads the key from this env var (never from the command line).
        [config.licenseKeyEnv]: licenseKey,
        STEREOTOOL_HOST: JSON.stringify(hostConfig),
      },
    );
  }
  const args = expandArgs(config.args, {
    preset: config.preset,
    license: config.license,
    licenseKey,
    rate: String(SAMPLE_RATE),
    channels: String(CHANNELS),
  });
  return new ProcessStereoTool(config, opts, "stdio-pcm", config.binary, args, [licenseKey]);
}
