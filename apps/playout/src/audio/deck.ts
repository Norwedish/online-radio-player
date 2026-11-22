/**
 * Deck (PLAN §6.4.2 / M4.2): one FFmpeg process decoding one item to
 * 48 kHz s16le stereo. Decodes ahead into a bounded ring buffer (stdout is
 * paused when full), applies loudness gain + fades, tracks the sample
 * position, and supports pause/resume/seek by respawning FFmpeg with `-ss`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { BYTES_PER_FRAME, RingBuffer, SAMPLE_RATE, trackGainAt } from "@radio/core";

export interface DeckSource {
  /** File path, or `lavfi:<graph>` for generated audio (tests/emergency tone). */
  path: string;
  cueIn: number;
  /** Seconds to play from cueIn (null = to the end of the file). */
  duration: number | null;
  fadeIn: number;
  fadeOut: number;
  gainDb: number;
  /** Loop forever (emergency loop). */
  loop?: boolean;
}

export type DeckState = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

const BUFFER_SECONDS = 6;
const LOW_WATER = 0.5;

export class Deck extends EventEmitter {
  private proc: ChildProcess | null = null;
  private ring = new RingBuffer(SAMPLE_RATE * BYTES_PER_FRAME * BUFFER_SECONDS);
  private pending: Buffer[] = [];
  private eof = false;
  private playedFrames = 0;
  private startOffset = 0;
  private generation = 0;
  private stderr = "";
  state: DeckState = "idle";
  underruns = 0;
  /** Extra gain multiplier (cut fades, manual fades). */
  private rampFrom = 1;
  private rampTo = 1;
  private rampFrames = 0;
  private rampPos = 0;

  constructor(
    readonly source: DeckSource,
    readonly id: string = Math.random().toString(36).slice(2),
  ) {
    super();
  }

  /** Effective length in seconds (cue-out applied). */
  get duration(): number {
    return this.source.duration ?? Number.POSITIVE_INFINITY;
  }

  /** Seconds played since cue-in. */
  get position(): number {
    return this.startOffset + this.playedFrames / SAMPLE_RATE;
  }

  get remaining(): number {
    return this.duration - this.position;
  }

  get bufferedSeconds(): number {
    return this.ring.length / BYTES_PER_FRAME / SAMPLE_RATE;
  }

  /** Starts decoding from `offset` seconds after cue-in (preload: decode before consuming). */
  load(offset = 0): void {
    this.kill();
    const gen = ++this.generation;
    this.startOffset = Math.max(0, offset);
    this.playedFrames = 0;
    this.ring.clear();
    this.pending = [];
    this.eof = false;
    this.state = "loading";
    const args = ["-hide_banner", "-nostats", "-loglevel", "error", "-nostdin"];
    const seek = this.source.cueIn + this.startOffset;
    if (this.source.path.startsWith("lavfi:")) {
      args.push("-f", "lavfi", "-i", this.source.path.slice(6));
      if (seek > 0) args.push("-ss", seek.toFixed(3));
    } else {
      if (this.source.loop) args.push("-stream_loop", "-1");
      if (seek > 0) args.push("-ss", seek.toFixed(3));
      args.push("-i", this.source.path);
    }
    if (this.source.duration !== null && !this.source.loop) {
      args.push("-t", Math.max(0.05, this.source.duration - this.startOffset).toFixed(3));
    }
    args.push("-vn", "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "2", "pipe:1");
    const proc = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout!.on("data", (chunk: Buffer) => {
      if (gen !== this.generation) return;
      this.pending.push(chunk);
      this.drainPending();
      if (this.ring.free < 128 * 1024) proc.stdout!.pause();
    });
    proc.stderr!.on("data", (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-2000);
    });
    proc.on("error", (e) => {
      if (gen !== this.generation) return;
      this.state = "error";
      this.emit("error", e);
    });
    proc.on("close", (code) => {
      if (gen !== this.generation) return;
      this.proc = null;
      this.eof = true;
      if (code !== 0 && code !== null && this.ring.length === 0 && this.pending.length === 0) {
        this.state = "error";
        this.emit(
          "error",
          new Error(`ffmpeg exited ${code}: ${this.stderr.trim().split("\n").pop() ?? ""}`),
        );
      }
    });
  }

  private drainPending(): void {
    while (this.pending.length > 0 && this.ring.free > 0) {
      const chunk = this.pending[0]!;
      const written = this.ring.write(chunk);
      if (written < chunk.length) {
        this.pending[0] = chunk.subarray(written);
        break;
      }
      this.pending.shift();
    }
  }

  /** True once enough audio is buffered to start without an underrun. */
  get ready(): boolean {
    return this.eof || this.ring.length >= SAMPLE_RATE * BYTES_PER_FRAME * 0.25;
  }

  play(): void {
    if (this.state === "idle") this.load(0);
    if (this.state === "loading" || this.state === "paused") this.state = "playing";
  }

  /**
   * Reads `frames` stereo frames into `out` (interleaved float, *added* with `busGain`).
   * Returns the per-frame-block peak contribution count (frames actually read).
   */
  mixInto(out: Float32Array, frames: number, busGain: number): number {
    if (this.state !== "playing") return 0;
    const bytes = frames * BYTES_PER_FRAME;
    const chunk = this.ring.read(bytes);
    if (this.ring.length < this.ring.capacity * LOW_WATER) {
      this.drainPending();
      if (this.proc?.stdout?.isPaused()) this.proc.stdout.resume();
    }
    const got = chunk.length / BYTES_PER_FRAME;
    if (got < frames && !this.eof) this.underruns += 1;
    const pos0 = this.position;
    const dur = Number.isFinite(this.duration) ? this.duration : 1e9;
    let gain = 0;
    for (let f = 0; f < got; f += 1) {
      // Gain is recomputed per 64-frame block (the mix frame size): smooth and cheap.
      if ((f & 63) === 0) {
        const t = pos0 + f / SAMPLE_RATE;
        gain =
          trackGainAt(t, dur, this.source.fadeIn, this.source.fadeOut, this.source.gainDb) *
          this.rampGainAt(f) *
          busGain;
      }
      out[f * 2] = out[f * 2]! + (chunk.readInt16LE(f * 4) / 32768) * gain;
      out[f * 2 + 1] = out[f * 2 + 1]! + (chunk.readInt16LE(f * 4 + 2) / 32768) * gain;
    }
    this.advanceRamp(got);
    this.playedFrames += got;
    if (
      this.eof &&
      this.ring.length === 0 &&
      this.pending.length === 0 &&
      this.state === "playing"
    ) {
      if (this.source.loop) {
        this.load(0);
        this.state = "playing";
      } else {
        this.state = "ended";
        this.emit("ended");
      }
    }
    return got;
  }

  private rampGain(): number {
    return this.rampGainAt(0);
  }

  private rampGainAt(offsetFrames: number): number {
    if (this.rampFrames <= 0) return this.rampTo;
    const p = Math.min(1, (this.rampPos + offsetFrames) / this.rampFrames);
    return this.rampFrom + (this.rampTo - this.rampFrom) * p;
  }

  private advanceRamp(frames: number): void {
    if (this.rampFrames <= 0) return;
    this.rampPos += frames;
    if (this.rampPos >= this.rampFrames) {
      this.rampFrames = 0;
      this.rampFrom = this.rampTo;
      if (this.rampTo === 0) this.emit("faded");
    }
  }

  /** Linear fade of the deck's extra gain (used for 150 ms boundary cuts and manual fades). */
  fadeTo(gain: number, ms: number): void {
    this.rampFrom = this.rampGain();
    this.rampTo = gain;
    this.rampFrames = Math.max(1, Math.round((ms / 1000) * SAMPLE_RATE));
    this.rampPos = 0;
  }

  /** Stops decoding and remembers the position (resume restarts FFmpeg with -ss). */
  pause(): void {
    if (this.state !== "playing" && this.state !== "loading") return;
    const pos = this.position;
    this.kill();
    this.startOffset = pos;
    this.playedFrames = 0;
    this.ring.clear();
    this.pending = [];
    this.state = "paused";
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.load(this.startOffset);
    this.state = "playing";
  }

  seek(position: number): void {
    const wasPlaying = this.state === "playing";
    this.load(
      Math.max(
        0,
        Math.min(position, Number.isFinite(this.duration) ? this.duration - 0.05 : position),
      ),
    );
    if (wasPlaying) this.state = "playing";
  }

  stop(): void {
    this.kill();
    this.ring.clear();
    this.pending = [];
    this.state = "ended";
  }

  private kill(): void {
    this.generation += 1;
    if (this.proc) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        // gone
      }
      this.proc = null;
    }
  }
}
