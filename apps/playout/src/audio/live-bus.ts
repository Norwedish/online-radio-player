/**
 * Live input bus (PLAN §6.4.6 / M8.1): PCM pushed from the browser studio
 * (WebSocket, ADR 0004), an Icecast `/live` ingest or ALSA line-in, through a
 * jitter buffer into the mixer. Mono input is duplicated to both channels.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { BYTES_PER_FRAME, RingBuffer, SAMPLE_RATE, dbToGain } from "@radio/core";

export class LiveBus {
  private ring = new RingBuffer(SAMPLE_RATE * BYTES_PER_FRAME * 4);
  private buffering = true;
  private proc: ChildProcess | null = null;
  active = false;
  gain = 1;
  peak = 0;
  underruns = 0;
  receivedFrames = 0;
  lastInputAt = 0;

  constructor(public jitterMs = 200) {}

  setGainDb(db: number): void {
    this.gain = dbToGain(db);
  }

  /** Push interleaved s16le PCM (`channels` 1 or 2). */
  push(pcm: Buffer, channels: 1 | 2 = 2): void {
    let stereo = pcm;
    if (channels === 1) {
      stereo = Buffer.allocUnsafe(pcm.length * 2);
      for (let i = 0; i < pcm.length / 2; i += 1) {
        const v = pcm.readInt16LE(i * 2);
        stereo.writeInt16LE(v, i * 4);
        stereo.writeInt16LE(v, i * 4 + 2);
      }
    }
    if (this.ring.free < stereo.length) {
      // Sender is ahead (clock drift): drop the oldest audio to bound latency.
      this.ring.read(stereo.length - this.ring.free + SAMPLE_RATE * BYTES_PER_FRAME * 0.05);
    }
    this.ring.write(stereo);
    this.receivedFrames += stereo.length / BYTES_PER_FRAME;
    this.lastInputAt = Date.now();
  }

  mixInto(out: Float32Array, frames: number, busGain: number): void {
    if (!this.active) return;
    const jitterBytes = Math.round((this.jitterMs / 1000) * SAMPLE_RATE) * BYTES_PER_FRAME;
    if (this.buffering) {
      if (this.ring.length < jitterBytes) return;
      this.buffering = false;
    }
    const chunk = this.ring.read(frames * BYTES_PER_FRAME);
    const got = chunk.length / BYTES_PER_FRAME;
    if (got < frames) {
      this.underruns += 1;
      this.buffering = true;
    }
    // Keep latency bounded: if more than 2× the jitter target is queued, skip ahead.
    if (this.ring.length > jitterBytes * 2) this.ring.read(this.ring.length - jitterBytes);
    const g = this.gain * busGain;
    let peak = 0;
    for (let f = 0; f < got; f += 1) {
      const l = (chunk.readInt16LE(f * 4) / 32768) * g;
      const r = (chunk.readInt16LE(f * 4 + 2) / 32768) * g;
      out[f * 2] = out[f * 2]! + l;
      out[f * 2 + 1] = out[f * 2 + 1]! + r;
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > peak) peak = a;
    }
    this.peak = Math.max(this.peak * 0.9, peak);
  }

  /** Starts an FFmpeg ingest (Icecast `/live` pull or ALSA line-in) feeding this bus. */
  startIngest(
    input: { kind: "icecast"; url: string } | { kind: "linein"; device: string },
    log: (m: string) => void,
  ): void {
    this.stopIngest();
    const args = [
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "error",
      "-nostdin",
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "2",
    ];
    if (input.kind === "icecast")
      args.push(
        "-fflags",
        "nobuffer",
        "-probesize",
        "32768",
        "-analyzeduration",
        "0",
        "-i",
        input.url,
      );
    else
      args.splice(
        0,
        args.length,
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "alsa",
        "-i",
        input.device,
      );
    args.push("-vn", "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "2", "pipe:1");
    const proc = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout!.on("data", (d: Buffer) => this.push(d, 2));
    proc.stderr!.on("data", (d: Buffer) => log(`live ingest: ${d.toString().trim()}`));
    proc.on("close", (code) => {
      if (this.proc === proc) {
        this.proc = null;
        log(`live ingest exited (${code})`);
      }
    });
  }

  stopIngest(): void {
    if (this.proc) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        // gone
      }
      this.proc = null;
    }
  }

  reset(): void {
    this.ring.clear();
    this.buffering = true;
    this.peak = 0;
  }
}
