import { describe, expect, it } from "vitest";
import {
  computeAutocue,
  crossfadeShape,
  decodeEnvelope,
  encodeEnvelope,
  envelopeLevel,
  parseEbur128Frame,
  type LoudnessFrame,
} from "./autocue.js";

/** Frames every 100 ms from a loudness function of time. */
function frames(seconds: number, level: (t: number) => number): LoudnessFrame[] {
  const out: LoudnessFrame[] = [];
  for (let i = 1; i <= Math.round(seconds * 10); i += 1) {
    const t = i / 10;
    out.push({ t, m: level(t) });
  }
  return out;
}

describe("autocue (Liquidsoap internal algorithm)", () => {
  it("trims leading/trailing silence and starts the next track where the outro drops 7 dB", () => {
    // 2 s silence, music at −14 LUFS until 170 s, a linear fade to −60 at 180 s, then silence to 185 s.
    const f = frames(185, (t) =>
      t < 2 ? -120 : t < 170 ? -14 : t < 180 ? -14 - ((t - 170) / 10) * 46 : -120,
    );
    const r = computeAutocue(f, -14, 185)!;
    // Cue in just before the music (−0.1 margin, −0.2 for the 0.2 s fade-in).
    expect(r.cueIn).toBeGreaterThan(1.4);
    expect(r.cueIn).toBeLessThan(2);
    expect(r.fadeIn).toBe(0.2);
    // Cross point where the fade passes −21 (I − 7): 170 + 7/46·10 ≈ 171.5 s.
    const cross = r.cueOut - r.fadeOut;
    expect(cross).toBeGreaterThan(171);
    expect(cross).toBeLessThan(172.2);
    // Cue out where it passes −56 (I − 42) ≈ 179.1 s, then capped to max overlap 6 s.
    expect(r.fadeOut).toBeLessThanOrEqual(6);
    expect(r.cueOut).toBeLessThanOrEqual(180);
  });

  it("no leading silence → cue in 0 with no fade; hard ending → no overlap", () => {
    const f = frames(60, (t) => (t < 59.5 ? -12 : -120));
    const r = computeAutocue(f, -12, 60)!;
    expect(r.cueIn).toBe(0);
    expect(r.fadeIn).toBe(0);
    expect(r.cueOut).toBeGreaterThan(59.3);
    expect(r.fadeOut).toBe(0);
  });

  it("limits the overlap to maxOverlap by ending earlier", () => {
    // A 20 s slow fade from −14 to −60.
    const f = frames(200, (t) => (t < 170 ? -14 : t < 190 ? -14 - ((t - 170) / 20) * 46 : -120));
    const r = computeAutocue(f, -14, 200, { maxOverlap: 4, sustainedEndings: false })!;
    expect(r.fadeOut).toBe(4);
    const cross = r.cueOut - r.fadeOut;
    expect(cross).toBeGreaterThan(172);
    expect(cross).toBeLessThan(174);
  });

  it("sustained ending (stays loud into the tail) moves the cross point later", () => {
    // Loud to 170 s, then a long tail around −24 (I−10) until 185 s, then fades out.
    const tail = (t: number) =>
      t < 170 ? -14 : t < 185 ? -24 - ((t - 170) / 15) * 2 : t < 188 ? -26 - (t - 185) * 10 : -120;
    const plain = computeAutocue(frames(190, tail), -14, 190, { sustainedEndings: false })!;
    const smart = computeAutocue(frames(190, tail), -14, 190)!;
    expect(smart.sustained).toBe(true);
    expect(smart.cueOut - smart.fadeOut).toBeGreaterThan(plain.cueOut - plain.fadeOut);
  });

  it("returns null without usable loudness data", () => {
    expect(computeAutocue([], -14, 10)).toBeNull();
    expect(
      computeAutocue(
        frames(5, () => -120),
        -70,
        5,
      ),
    ).toBeNull();
  });

  it("envelope round-trips at 100 ms / 1 dB resolution", () => {
    const f = frames(30, (t) => (t < 1 ? Number.NaN : -10 - (t % 7)));
    const back = decodeEnvelope(encodeEnvelope(f));
    expect(back).toHaveLength(300);
    expect(Number.isNaN(back[0]!.m)).toBe(true);
    expect(back[150]!.t).toBeCloseTo(15.1, 5);
    expect(Math.abs(back[150]!.m - f[150]!.m)).toBeLessThanOrEqual(0.5);
    const a = computeAutocue(f, -13, 30)!;
    const b = computeAutocue(back, -13, 30)!;
    expect(Math.abs(a.cueIn - b.cueIn)).toBeLessThan(0.15);
    expect(Math.abs(a.cueOut - b.cueOut)).toBeLessThan(0.15);
  });

  it("measures the loudness of a stretch relative to the track's integrated loudness", () => {
    // Quiet intro (−30) for 3 s, then the song at −12.
    const f = frames(60, (t) => (t < 3 ? -30 : -12));
    expect(envelopeLevel(f, -12, 0, 2)).toBeCloseTo(-18, 1);
    expect(envelopeLevel(f, -12, 10, 12)).toBeCloseTo(0, 1);
    // Energy average: one loud frame dominates many quiet ones.
    const mixed = frames(3, (t) => (t > 2.95 ? -10 : -40));
    expect(envelopeLevel(mixed, -10, 0, 3)!).toBeGreaterThan(-15);
    // Shorter than a 400 ms frame window: the nearest frame.
    expect(envelopeLevel(f, -12, 20, 20.1)).toBeCloseTo(0, 1);
    expect(envelopeLevel([], -12, 0, 2)).toBeNull();
  });

  it("fades the old track fast under a loud intro and lets it play out under a quiet one", () => {
    // Loud intro (0 LU) over a quiet tail (−15 LU): out within 1 s, right away.
    expect(crossfadeShape(4, -15, 0)).toEqual({ hold: 0, fade: 1 });
    // Quiet intro (−24 LU) under the same tail: the tail plays on, fading only at the end.
    expect(crossfadeShape(4, -15, -24)).toEqual({ hold: 3.5, fade: 0.5 });
    // Similar levels: halfway.
    const mid = crossfadeShape(4, -15, -15)!;
    expect(mid.fade).toBeCloseTo(0.75, 3);
    expect(mid.hold).toBeCloseTo(1.625, 3);
    // Never longer than the overlap itself.
    for (const intro of [-40, -20, -15, -10, 0]) {
      const s = crossfadeShape(0.4, -15, intro)!;
      expect(s.hold + s.fade).toBeLessThanOrEqual(0.4 + 1e-9);
    }
    expect(crossfadeShape(4, null, 0)).toBeNull();
    expect(crossfadeShape(0, -15, 0)).toBeNull();
  });

  it("parses ffmpeg ebur128 verbose frame lines", () => {
    const line =
      "[Parsed_ebur128_0 @ 0x55] t: 1.299979   TARGET:-23 LUFS    M:-163.5 S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU";
    expect(parseEbur128Frame(line)).toEqual({ t: 1.299979, m: -127 });
    expect(parseEbur128Frame("t: 2.5  TARGET:-23 LUFS    M: -14.2 S:-14")!.m).toBeCloseTo(-14.2);
    expect(parseEbur128Frame("Summary:")).toBeNull();
  });
});
