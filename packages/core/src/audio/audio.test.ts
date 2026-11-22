import { describe, expect, it } from "vitest";
import {
  Envelope,
  Limiter,
  Meter,
  RingBuffer,
  dbToGain,
  fadeGain,
  floatToInt16,
  gainToDb,
  int16ToFloat,
  measure,
  trackGainAt,
} from "./index.js";

function sine(frames: number, amp: number, freq = 1000): Float32Array {
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const v = amp * Math.sin((2 * Math.PI * freq * i) / 48000);
    out[i * 2] = v;
    out[i * 2 + 1] = v;
  }
  return out;
}

describe("gain and fades (M4.1)", () => {
  it("converts dB and gain both ways", () => {
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(gainToDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(dbToGain(-200)).toBe(0);
  });

  it("fade curves start silent, end full and are monotonic", () => {
    for (const curve of ["linear", "log", "scurve"] as const) {
      expect(fadeGain(0, curve)).toBe(0);
      expect(fadeGain(1, curve)).toBeCloseTo(1, 6);
      let prev = -1;
      for (let p = 0; p <= 1; p += 0.05) {
        const g = fadeGain(p, curve);
        expect(g).toBeGreaterThanOrEqual(prev);
        prev = g;
      }
    }
  });

  it("track gain combines loudness gain with fade-in/out", () => {
    expect(trackGainAt(0, 100, 2, 3, 0)).toBe(0);
    expect(trackGainAt(50, 100, 2, 3, -6)).toBeCloseTo(dbToGain(-6), 6);
    expect(trackGainAt(100, 100, 2, 3, 0)).toBe(0);
  });

  it("round-trips int16 ↔ float", () => {
    const buf = Buffer.alloc(8);
    [0, 16384, -16384, 32767].forEach((v, i) => buf.writeInt16LE(v, i * 2));
    const back = floatToInt16(int16ToFloat(buf));
    expect([...Array(4)].map((_, i) => back.readInt16LE(i * 2))).toEqual([0, 16384, -16384, 32767]);
  });
});

describe("limiter (M4.1)", () => {
  it("prevents clipping when two -6 dB tones are summed hot", () => {
    const a = sine(48000, dbToGain(-1));
    const b = sine(48000, dbToGain(-1));
    for (let i = 0; i < a.length; i += 1) a[i]! += b[i]!; // ~+5 dBFS
    const limiter = new Limiter(-1, 5, 80);
    limiter.process(a);
    const { peak } = measure(a.subarray(48000)); // after the attack settles
    expect(peak).toBeLessThanOrEqual(-0.9);
    expect(limiter.reductionDb).toBeLessThan(0);
  });

  it("leaves material under the threshold untouched (after look-ahead delay)", () => {
    const a = sine(4800, 0.25);
    const ref = a.slice();
    new Limiter(-1, 5).process(a);
    const delay = 240 * 2;
    for (let i = delay; i < a.length; i += 101) expect(a[i]).toBeCloseTo(ref[i - delay]!, 5);
  });
});

describe("meters (M4.1)", () => {
  it("reports sine peak and RMS within 0.1 dB", () => {
    const m = measure(sine(48000, 0.5));
    expect(m.peak).toBeCloseTo(gainToDb(0.5), 1);
    expect(m.rms).toBeCloseTo(gainToDb(0.5 / Math.SQRT2), 1);
    const meter = new Meter();
    meter.add(sine(4800, 0.5), undefined, 0.5);
    expect(meter.read().peak).toBeCloseTo(gainToDb(0.25), 1);
    expect(meter.read().peak).toBe(-120);
  });
});

describe("ducking envelope", () => {
  it("reaches the duck depth within ~5 attack time constants and releases slower", () => {
    const env = new Envelope(1, 50, 500);
    const target = dbToGain(-12);
    let frames = 0;
    while (Math.abs(env.current - target) > 0.01 && frames < 48000) {
      env.step(target, 480);
      frames += 480;
    }
    expect(frames / 48).toBeLessThanOrEqual(300);
    let up = 0;
    while (env.current < 0.99 && up < 480000) {
      env.step(1, 480);
      up += 480;
    }
    expect(up).toBeGreaterThan(frames * 5);
  });
});

describe("RingBuffer", () => {
  it("wraps correctly and respects capacity", () => {
    const rb = new RingBuffer(10);
    expect(rb.write(Buffer.from("abcdefgh"))).toBe(8);
    expect(rb.read(5).toString()).toBe("abcde");
    expect(rb.write(Buffer.from("1234567"))).toBe(7);
    expect(rb.free).toBe(0);
    expect(rb.read(100).toString()).toBe("fgh1234567");
    expect(rb.length).toBe(0);
  });
});
