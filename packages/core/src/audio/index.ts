/**
 * Audio utilities (PLAN §6.4.1 / M4.1). Internal format is 48 kHz s16le
 * stereo on the wire; mixing happens in Float32 (interleaved L/R).
 */

export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
export const BYTES_PER_FRAME = 4; // s16le stereo

export function dbToGain(db: number): number {
  return db <= -120 ? 0 : Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  return gain <= 1e-6 ? -120 : 20 * Math.log10(gain);
}

export function secondsToFrames(seconds: number, rate = SAMPLE_RATE): number {
  return Math.round(seconds * rate);
}

/** Int16 interleaved Buffer → Float32 interleaved in [-1, 1). */
export function int16ToFloat(buf: Buffer, out?: Float32Array): Float32Array {
  const samples = buf.length >> 1;
  const target = out && out.length >= samples ? out : new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) target[i] = buf.readInt16LE(i * 2) / 32768;
  return target;
}

/** Float32 interleaved → Int16 Buffer with hard clip (the limiter should prevent clipping). */
export function floatToInt16(samples: Float32Array, length = samples.length): Buffer {
  const out = Buffer.allocUnsafe(length * 2);
  for (let i = 0; i < length; i += 1) {
    let v = samples[i]! * 32768;
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    out.writeInt16LE(v < 0 ? Math.ceil(v - 0.5) : Math.floor(v + 0.5), i * 2);
  }
  return out;
}

export type FadeCurve = "linear" | "log" | "scurve";

/** Gain multiplier for a fade at progress p∈[0,1] (0 = silent, 1 = full). */
export function fadeGain(p: number, curve: FadeCurve = "scurve"): number {
  const x = Math.min(1, Math.max(0, p));
  if (curve === "linear") return x;
  if (curve === "log") return x === 0 ? 0 : dbToGain((1 - x) * -60);
  return 0.5 - 0.5 * Math.cos(Math.PI * x); // equal-velocity S-curve
}

/**
 * Per-track gain at a playback position: loudness gain × fade-in × fade-out.
 * Positions are seconds from the effective start (after cue-in).
 */
export function trackGainAt(
  position: number,
  duration: number,
  fadeIn: number,
  fadeOut: number,
  gainDb: number,
): number {
  let g = dbToGain(gainDb);
  if (fadeIn > 0 && position < fadeIn) g *= fadeGain(position / fadeIn);
  if (fadeOut > 0 && position > duration - fadeOut) g *= fadeGain((duration - position) / fadeOut);
  return g;
}

/** Attack/release envelope follower used for ducking (one value per frame block). */
export class Envelope {
  private value: number;
  constructor(
    initial = 1,
    public attackMs = 50,
    public releaseMs = 500,
  ) {
    this.value = initial;
  }

  get current(): number {
    return this.value;
  }

  /** Moves towards `target` over `frames` frames using attack (down) / release (up) time constants. */
  step(target: number, frames: number, rate = SAMPLE_RATE): number {
    const ms = (frames / rate) * 1000;
    const tc = target < this.value ? this.attackMs : this.releaseMs;
    const coeff = tc <= 0 ? 1 : 1 - Math.exp(-ms / tc);
    this.value += (target - this.value) * coeff;
    if (Math.abs(target - this.value) < 1e-4) this.value = target;
    return this.value;
  }

  set(value: number): void {
    this.value = value;
  }
}

/**
 * Look-ahead soft limiter (PLAN §6.4.3: 5 ms look-ahead, −1 dBFS threshold).
 * Delays audio by the look-ahead so gain reduction starts before the peak.
 */
export class Limiter {
  private readonly lookahead: number;
  private readonly delay: Float32Array;
  private readonly peaks: Float32Array;
  private writePos = 0;
  private gain = 1;
  private readonly threshold: number;
  private readonly releaseCoeff: number;
  reductionDb = 0;

  constructor(thresholdDb = -1, lookaheadMs = 5, releaseMs = 80, rate = SAMPLE_RATE) {
    this.lookahead = Math.max(1, Math.round((lookaheadMs / 1000) * rate));
    this.delay = new Float32Array(this.lookahead * CHANNELS);
    this.peaks = new Float32Array(this.lookahead);
    this.threshold = dbToGain(thresholdDb);
    this.releaseCoeff = 1 - Math.exp(-1 / ((releaseMs / 1000) * rate));
  }

  /** Processes interleaved stereo in place. */
  process(samples: Float32Array, length = samples.length): void {
    let minGain = 1;
    for (let i = 0; i < length; i += CHANNELS) {
      const l = samples[i]!;
      const r = samples[i + 1]!;
      const peak = Math.max(Math.abs(l), Math.abs(r));
      this.peaks[this.writePos] = peak;
      // Required gain over the look-ahead window.
      let windowPeak = 0;
      for (let k = 0; k < this.lookahead; k += 1)
        if (this.peaks[k]! > windowPeak) windowPeak = this.peaks[k]!;
      const target = windowPeak > this.threshold ? this.threshold / windowPeak : 1;
      if (target < this.gain) this.gain = target;
      else this.gain += (target - this.gain) * this.releaseCoeff;
      if (this.gain < minGain) minGain = this.gain;
      const d = this.writePos * CHANNELS;
      const outL = this.delay[d]!;
      const outR = this.delay[d + 1]!;
      this.delay[d] = l;
      this.delay[d + 1] = r;
      samples[i] = outL * this.gain;
      samples[i + 1] = outR * this.gain;
      this.writePos = (this.writePos + 1) % this.lookahead;
    }
    this.reductionDb = gainToDb(minGain);
  }

  get latencyFrames(): number {
    return this.lookahead;
  }
}

/** Peak/RMS meter over interleaved float samples, in dBFS. */
export function measure(
  samples: Float32Array,
  length = samples.length,
): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < length; i += 1) {
    const v = Math.abs(samples[i]!);
    if (v > peak) peak = v;
    sum += v * v;
  }
  const rms = length > 0 ? Math.sqrt(sum / length) : 0;
  return { peak: gainToDb(peak), rms: gainToDb(rms) };
}

/** Accumulating meter that reports and resets (for 10 Hz meter updates). */
export class Meter {
  private peak = 0;
  private sum = 0;
  private count = 0;

  add(samples: Float32Array, length = samples.length, gain = 1): void {
    for (let i = 0; i < length; i += 1) {
      const v = Math.abs(samples[i]! * gain);
      if (v > this.peak) this.peak = v;
      this.sum += v * v;
    }
    this.count += length;
  }

  read(): { peak: number; rms: number } {
    const out = {
      peak: gainToDb(this.peak),
      rms: gainToDb(this.count ? Math.sqrt(this.sum / this.count) : 0),
    };
    this.peak = 0;
    this.sum = 0;
    this.count = 0;
    return out;
  }
}

/** Fixed-capacity byte ring buffer for PCM. */
export class RingBuffer {
  private readonly buf: Buffer;
  private readPos = 0;
  private writePos = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    this.buf = Buffer.alloc(capacity);
  }

  get length(): number {
    return this.size;
  }

  get free(): number {
    return this.capacity - this.size;
  }

  /** Writes as much as fits; returns bytes written. */
  write(chunk: Buffer): number {
    const n = Math.min(chunk.length, this.free);
    for (let written = 0; written < n;) {
      const span = Math.min(n - written, this.capacity - this.writePos);
      chunk.copy(this.buf, this.writePos, written, written + span);
      this.writePos = (this.writePos + span) % this.capacity;
      written += span;
    }
    this.size += n;
    return n;
  }

  /** Reads up to `n` bytes (fewer if not available). */
  read(n: number): Buffer {
    const take = Math.min(n, this.size);
    const out = Buffer.allocUnsafe(take);
    for (let read = 0; read < take;) {
      const span = Math.min(take - read, this.capacity - this.readPos);
      this.buf.copy(out, read, this.readPos, this.readPos + span);
      this.readPos = (this.readPos + span) % this.capacity;
      read += span;
    }
    this.size -= take;
    return out;
  }

  clear(): void {
    this.readPos = this.writePos = this.size = 0;
  }
}
