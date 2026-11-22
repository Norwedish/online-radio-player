/**
 * Encoder hub (PLAN §6.5.2 / M5.2): one FFmpeg per output (Icecast mounts,
 * the HLS segmenter of ADR 0003, and live-session recordings), fed from one
 * PCM fan-out with a bounded queue per encoder (default 10 s). Encoders are
 * restarted with exponential backoff; a full queue drops the oldest audio and
 * raises an alert (never silently). Icecast reconnects happen through the
 * restart loop when the server comes back (M5.6).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BYTES_PER_FRAME, SAMPLE_RATE } from "@radio/core";
import type { EncoderStatus, WorkerAlert } from "@radio/shared";

export type EncoderTarget =
  | {
      kind: "icecast";
      mount: string;
      codec: "mp3" | "opus" | "aac";
      bitrate: string;
      contentType: string;
      url: string;
      name?: string;
      description?: string;
      genre?: string;
      public?: boolean;
    }
  | { kind: "hls"; dir: string; segmentSeconds: number; listSize: number; bitrate: string }
  | { kind: "file"; path: string; codec: "flac" | "wav" | "mp3" };

const PCM_INPUT = [
  "-f",
  "s16le",
  "-ar",
  String(SAMPLE_RATE),
  "-ac",
  "2",
  "-analyzeduration",
  "0",
  "-probesize",
  "32768",
  "-i",
  "pipe:0",
];

export function encoderArgs(target: EncoderTarget): string[] {
  const base = ["-hide_banner", "-nostats", "-loglevel", "warning", "-nostdin", ...PCM_INPUT];
  if (target.kind === "icecast") {
    const codec =
      target.codec === "mp3"
        ? ["-c:a", "libmp3lame", "-b:a", target.bitrate, "-f", "mp3"]
        : target.codec === "opus"
          ? ["-c:a", "libopus", "-b:a", target.bitrate, "-application", "audio", "-f", "ogg"]
          : ["-c:a", "aac", "-b:a", target.bitrate, "-f", "adts"];
    const ice = [
      // ADR 0001: always pass the content type explicitly.
      "-content_type",
      target.contentType,
      ...(target.name ? ["-ice_name", target.name] : []),
      ...(target.description ? ["-ice_description", target.description] : []),
      ...(target.genre ? ["-ice_genre", target.genre] : []),
      "-ice_public",
      target.public === false ? "0" : "1",
    ];
    return [...base, ...codec, ...ice, target.url];
  }
  if (target.kind === "hls") {
    return [
      ...base,
      "-c:a",
      "aac",
      "-b:a",
      target.bitrate,
      "-f",
      "hls",
      "-hls_time",
      String(target.segmentSeconds),
      "-hls_list_size",
      String(target.listSize),
      "-hls_flags",
      "delete_segments+omit_endlist+independent_segments",
      "-hls_segment_filename",
      `${target.dir}/seg%05d.ts`,
      `${target.dir}/stream.m3u8`,
    ];
  }
  const codec =
    target.codec === "flac"
      ? ["-c:a", "flac", "-f", "flac"]
      : target.codec === "mp3"
        ? ["-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3"]
        : ["-c:a", "pcm_s16le", "-f", "wav"];
  return [...base, ...codec, "-y", target.path];
}

export function targetId(target: EncoderTarget): string {
  return target.kind === "icecast"
    ? target.mount
    : target.kind === "hls"
      ? "hls"
      : `file:${target.path}`;
}

export class Encoder {
  private proc: ChildProcess | null = null;
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private startedAt = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private failures = 0;
  restarts = 0;
  dropped = 0;
  lastError: string | null = null;
  readonly id: string;

  constructor(
    readonly target: EncoderTarget,
    private readonly opts: {
      maxQueueSeconds: number;
      log: (m: string) => void;
      alert: (a: WorkerAlert) => void;
      redact: (s: string) => string;
      restartOnExit?: boolean;
    },
  ) {
    this.id = targetId(target);
  }

  start(): void {
    this.stopped = false;
    if (this.target.kind === "hls") mkdirSync(this.target.dir, { recursive: true });
    if (this.target.kind === "file") mkdirSync(dirname(this.target.path), { recursive: true });
    const proc = spawn("ffmpeg", encoderArgs(this.target), {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    this.proc = proc;
    this.startedAt = Date.now();
    proc.stdin!.on("error", () => {
      /* close handler restarts */
    });
    proc.stdin!.on("drain", () => this.flush());
    proc.stderr!.on("data", (d: Buffer) => {
      const text = this.opts.redact(d.toString().trim());
      if (text) {
        this.lastError = text.split("\n").pop()!.slice(0, 300);
        this.opts.log(`encoder ${this.id}: ${text.slice(0, 500)}`);
      }
    });
    proc.on("error", (e) => {
      this.lastError = e.message;
    });
    proc.on("close", (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.stopped) return;
      const ranMs = Date.now() - this.startedAt;
      this.failures = ranMs > 30_000 ? 1 : this.failures + 1;
      this.lastError = this.lastError ?? `exited code=${code} signal=${signal}`;
      if (this.opts.restartOnExit === false) return;
      const delay = Math.min(1000 * 2 ** (this.failures - 1), 30_000);
      this.opts.log(`encoder ${this.id} exited (code=${code}); restarting in ${delay} ms`);
      if (this.failures === 3)
        this.opts.alert({
          type: "encoder_failure",
          severity: "error",
          message: `Encoder ${this.id} keeps failing: ${this.lastError ?? ""}`,
          details: { mount: this.id },
        });
      this.restartTimer = setTimeout(() => {
        this.restarts += 1;
        this.start();
      }, delay);
    });
    this.flush();
  }

  write(chunk: Buffer): void {
    this.queue.push(chunk);
    this.queuedBytes += chunk.length;
    const max = this.opts.maxQueueSeconds * SAMPLE_RATE * BYTES_PER_FRAME;
    if (this.queuedBytes > max) {
      // Bounded queue: drop the oldest audio, but loudly.
      let drop = 0;
      while (this.queuedBytes > max * 0.5 && this.queue.length > 0) {
        const c = this.queue.shift()!;
        this.queuedBytes -= c.length;
        drop += c.length;
      }
      this.dropped += drop;
      this.opts.alert({
        type: "encoder_queue_overflow",
        severity: "warning",
        message: `Encoder ${this.id} queue overflow: dropped ${(drop / (SAMPLE_RATE * BYTES_PER_FRAME)).toFixed(1)} s`,
        details: { mount: this.id },
      });
    }
    this.flush();
  }

  private flush(): void {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed) return;
    while (this.queue.length > 0) {
      const chunk = this.queue.shift()!;
      this.queuedBytes -= chunk.length;
      if (!stdin.write(chunk)) break;
    }
  }

  get running(): boolean {
    return this.proc !== null;
  }

  status(): EncoderStatus {
    const t = this.target;
    return {
      mount: this.id,
      codec: t.kind === "icecast" ? t.codec : t.kind === "hls" ? "aac/hls" : t.codec,
      bitrate: t.kind === "file" ? "-" : t.bitrate,
      running: this.running,
      restarts: this.restarts,
      uptimeSeconds: this.running ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      queuedMs: Math.round((this.queuedBytes / (SAMPLE_RATE * BYTES_PER_FRAME)) * 1000),
      lastError: this.running && Date.now() - this.startedAt > 10_000 ? null : this.lastError,
    };
  }

  /** Graceful stop: close stdin so FFmpeg finalizes the file/stream. */
  stop(graceMs = 3000): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const proc = this.proc;
    this.proc = null;
    if (!proc) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // gone
        }
        resolve();
      }, graceMs);
      proc.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        for (const c of this.queue) proc.stdin!.write(c);
        this.queue = [];
        proc.stdin!.end();
      } catch {
        proc.kill("SIGTERM");
      }
    });
  }

  /** Test/ops helper: kill the process to exercise restart. */
  kill(): void {
    this.proc?.kill("SIGKILL");
  }
}

export class EncoderHub {
  readonly encoders = new Map<string, Encoder>();
  private allDownSince: number | null = null;

  constructor(
    private readonly opts: {
      maxQueueSeconds: number;
      log: (m: string) => void;
      alert: (a: WorkerAlert) => void;
      redact: (s: string) => string;
    },
  ) {}

  add(target: EncoderTarget, options: { restartOnExit?: boolean } = {}): Encoder {
    const enc = new Encoder(target, { ...this.opts, ...options });
    this.encoders.set(enc.id, enc);
    enc.start();
    return enc;
  }

  async remove(id: string): Promise<void> {
    const enc = this.encoders.get(id);
    if (!enc) return;
    this.encoders.delete(id);
    await enc.stop();
  }

  write(chunk: Buffer): void {
    for (const enc of this.encoders.values()) enc.write(chunk);
  }

  statuses(): EncoderStatus[] {
    return [...this.encoders.values()].map((e) => e.status());
  }

  /** Seconds all Icecast encoders have been down (0 if any is up). */
  icecastDownSeconds(now = Date.now()): number {
    const ice = [...this.encoders.values()].filter((e) => e.target.kind === "icecast");
    if (ice.length === 0 || ice.some((e) => e.running && e.status().uptimeSeconds >= 2)) {
      this.allDownSince = null;
      return 0;
    }
    this.allDownSince ??= now;
    return (now - this.allDownSince) / 1000;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.encoders.values()].map((e) => e.stop()));
    this.encoders.clear();
  }
}
