/**
 * Autocue: loudness-based cue-in, cue-out and crossfade points — a port of
 * Liquidsoap's internal autocue (src/libs/autocue.liq, the implementation
 * AzuraCast uses), based on EBU R128 momentary loudness frames (100 ms).
 *
 *   cue-in     first frame louder than  I + cueInThreshold   (default I − 34 dB)
 *   cue-out    last frame louder than   I + cueOutThreshold  (default I − 42 dB)
 *   crossfade  last frame louder than   I + crossThreshold   (default I − 7 dB):
 *              the next track starts here; this one fades out until cue-out
 *   sustained endings: when the end stays loud (or decays slowly) the
 *              thresholds are lowered so long endings are kept intact.
 *
 * `I` is the track's integrated loudness, so the thresholds follow the track.
 */

export interface LoudnessFrame {
  /** Seconds from the start of the file. */
  t: number;
  /** Momentary loudness (LUFS, 400 ms window); NaN when not available. */
  m: number;
}

export interface AutocueOptions {
  cueInThreshold: number;
  cueOutThreshold: number;
  crossThreshold: number;
  /** Maximum overlap between two tracks (seconds). */
  maxOverlap: number;
  sustainedEndings: boolean;
  /** [%] max. loudness drop right after the crossfade point to count as a sustained ending. */
  sustainedDropoff?: number;
  /** [%] max. loudness difference between crossfade point and cue-out. */
  sustainedSlope?: number;
  /** Minimum length of the ending to analyse (seconds). */
  sustainedMinDuration?: number;
  /** Thresholds may be lowered at most by this factor. */
  sustainedThresholdLimit?: number;
}

export const AUTOCUE_DEFAULTS: Required<AutocueOptions> = {
  cueInThreshold: -34,
  cueOutThreshold: -42,
  crossThreshold: -7,
  maxOverlap: 6,
  sustainedEndings: true,
  sustainedDropoff: 15,
  sustainedSlope: 20,
  sustainedMinDuration: 1,
  sustainedThresholdLimit: 2,
};

export interface AutocueResult {
  /** Seconds from file start where playback begins. */
  cueIn: number;
  /** Seconds from file start where playback ends. */
  cueOut: number;
  /** Fade-in length at cue-in (0 or 0.2 s, as Liquidsoap). */
  fadeIn: number;
  /** Fade-out length before cue-out = the crossfade overlap; the next track starts at cueOut − fadeOut. */
  fadeOut: number;
  /** Whether the sustained-ending rule moved the points. */
  sustained: boolean;
}

/**
 * Computes cue points from momentary-loudness frames (one per 100 ms) and the
 * integrated loudness `lufs`. `duration` is the file length in seconds.
 */
export function computeAutocue(
  frames: LoudnessFrame[],
  lufs: number,
  duration: number,
  options: Partial<AutocueOptions> = {},
): AutocueResult | null {
  const o = { ...AUTOCUE_DEFAULTS, ...options };
  const valid = frames.filter((f) => Number.isFinite(f.m));
  if (valid.length < 2 || !Number.isFinite(lufs) || lufs <= -70) return null;

  const cueInTh = lufs + o.cueInThreshold;
  const cueOutTh = lufs + o.cueOutThreshold;
  const crossTh = lufs + o.crossThreshold;

  // Cue in: first frame above the threshold → the timestamp of the frame before it.
  let cueIn = 0;
  {
    let lastTs = 0;
    for (const f of valid) {
      if (f.m > cueInTh) {
        cueIn = lastTs;
        break;
      }
      lastTs = f.t;
    }
  }

  // Cue out + crossfade point, scanning from the end.
  const scanEnd = (outTh: number, crossTh_: number) => {
    let cueOut = 0;
    let cross = 0;
    let crossIdx = -1;
    let outIdx = -1;
    let found = false;
    let lastTs = 0;
    for (let i = valid.length - 1; i >= 0; i -= 1) {
      const f = valid[i]!;
      if (f.m > outTh && !found) {
        cueOut = lastTs || f.t;
        outIdx = i;
        found = true;
      } else if (found && f.m > crossTh_) {
        cross = lastTs;
        crossIdx = i;
        break;
      }
      lastTs = f.t;
    }
    return { cueOut, cross, crossIdx, outIdx };
  };

  let { cueOut, cross } = scanEnd(cueOutTh, crossTh);
  let sustained = false;

  // Sustained endings: compare the loudness of the two halves of the fade region.
  const { crossIdx, outIdx } = scanEnd(cueOutTh, crossTh);
  if (o.sustainedEndings && crossIdx >= 0 && outIdx > crossIdx) {
    const start = crossIdx + 5;
    const stop = outIdx - 5;
    const length = stop - start;
    if (length >= o.sustainedMinDuration * 10) {
      const mid = stop - length / 2;
      const avg = (from: number, to: number) => {
        const xs = valid.slice(Math.max(0, Math.ceil(from)), Math.floor(to)).map((f) => f.m);
        return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
      };
      const first = avg(start + 1, mid);
      const second = avg(mid, stop);
      if (Number.isFinite(first) && first < 0) {
        const slope = Number.isFinite(second) && second < 0 ? first / second : 0;
        const detectSlope = slope > 1 - o.sustainedSlope / 100;
        const detectDropoff = first > crossTh * (o.sustainedDropoff / 100 + 1);
        if (detectSlope || detectDropoff) {
          const crossSustained = Math.max(
            crossTh * o.sustainedThresholdLimit,
            (detectSlope ? second : first) - 0.5,
          );
          const outSustained = Math.max(
            cueOutTh * o.sustainedThresholdLimit,
            cueOutTh + (crossSustained - crossTh),
          );
          const re = scanEnd(outSustained, crossSustained);
          if (re.cueOut > 0) {
            cueOut = re.cueOut;
            cross = re.cross;
            sustained = true;
          }
        }
      }
    }
  }

  if (cueOut <= 0 || cueOut > duration) cueOut = duration;

  let fadeOut = 0;
  if (cross > 0 && cross + 0.1 < cueOut) fadeOut = cueOut - cross;

  // A little margin before the first audible frame, with a short fade to avoid a click.
  cueIn -= 0.1;
  let fadeIn = 0;
  if (cueIn > 0.2) {
    fadeIn = 0.2;
    cueIn -= 0.2;
  }
  if (cueIn <= 0.2) {
    fadeIn = 0;
    cueIn = 0;
  }
  if (o.maxOverlap < fadeIn) fadeIn = o.maxOverlap;
  if (o.maxOverlap < fadeOut) {
    // Too long a tail: end earlier instead of overlapping more than allowed.
    cueOut -= fadeOut - o.maxOverlap;
    fadeOut = o.maxOverlap;
  }
  // Never let the cue points cross (very short or silent files).
  if (cueOut - cueIn < 1) return { cueIn: 0, cueOut: duration, fadeIn: 0, fadeOut: 0, sustained };
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    cueIn: r3(cueIn),
    cueOut: r3(cueOut),
    fadeIn: r3(fadeIn),
    fadeOut: r3(fadeOut),
    sustained,
  };
}

/* ── Crossfade shape ──────────────────────────────────────────────────── */

/**
 * Loudness of the audio between `from` and `to` seconds (file time), in LU relative to
 * the track's integrated loudness `lufs` (energy average of the momentary frames; each
 * frame covers the 400 ms before its timestamp). Null without usable frames.
 */
export function envelopeLevel(
  frames: LoudnessFrame[],
  lufs: number,
  from: number,
  to: number,
): number | null {
  if (!Number.isFinite(lufs)) return null;
  const valid = frames.filter((f) => Number.isFinite(f.m));
  let sel = valid.filter((f) => f.t - 0.4 >= from - 0.05 && f.t <= to + 0.05);
  if (sel.length === 0) {
    // Shorter than one frame window: take the frame closest to it.
    const mid = Math.min(to, from + 0.4);
    const near = valid
      .filter((f) => Math.abs(f.t - mid) <= 0.5)
      .sort((a, b) => Math.abs(a.t - mid) - Math.abs(b.t - mid))[0];
    if (!near) return null;
    sel = [near];
  }
  const energy = sel.reduce((s, f) => s + 10 ** (f.m / 10), 0) / sel.length;
  return Math.round((10 * Math.log10(energy) - lufs) * 10) / 10;
}

export interface CrossfadeShape {
  /** Seconds the outgoing track keeps its full level after the next one starts. */
  hold: number;
  /** Seconds it then takes to fade to silence (hold + fade ≤ overlap). */
  fade: number;
}

/**
 * How the outgoing track leaves during an overlap of `overlap` seconds, from the loudness
 * of its tail (`oldTail`) and of the next track's intro (`newIntro`), both in LU relative
 * to their own integrated loudness — playback normalises tracks, so they compare directly.
 *
 *   intro ≥ 6 LU louder than the tail → the old track fades out within 1 s
 *   intro ≥ 6 LU quieter              → the old track plays out its own decay and
 *                                        fades only in the last 0.5 s, so no hole opens
 *   in between                        → proportionally
 *
 * The next track always starts at full level. Null when a level is unknown.
 */
export function crossfadeShape(
  overlap: number,
  oldTail: number | null,
  newIntro: number | null,
): CrossfadeShape | null {
  if (oldTail === null || newIntro === null || !(overlap > 0)) return null;
  const quick = Math.min(overlap, 1);
  const late = Math.min(overlap, 0.5);
  const t = Math.min(1, Math.max(0, (newIntro - oldTail + 6) / 12));
  const fade = late + (quick - late) * t;
  const hold = (overlap - fade) * (1 - t);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { hold: r3(hold), fade: r3(fade) };
}

/* ── Envelope storage ─────────────────────────────────────────────────── */

/**
 * Momentary loudness every 100 ms as one signed byte per frame (whole dB,
 * clamped to −127…0; −128 = no data), base64 encoded. A 4-minute track is
 * ~3 KB; keeping it lets cue points be recomputed without decoding again.
 */
export function encodeEnvelope(frames: LoudnessFrame[]): string {
  if (frames.length === 0) return "";
  const step = 0.1;
  const n = Math.round(frames[frames.length - 1]!.t / step);
  const bytes = new Int8Array(Math.max(1, n));
  bytes.fill(-128);
  for (const f of frames) {
    const i = Math.round(f.t / step) - 1;
    if (i < 0 || i >= bytes.length) continue;
    bytes[i] = Number.isFinite(f.m) ? Math.max(-127, Math.min(0, Math.round(f.m))) : -128;
  }
  return Buffer.from(bytes.buffer).toString("base64");
}

export function decodeEnvelope(text: string | null | undefined): LoudnessFrame[] {
  if (!text) return [];
  const buf = Buffer.from(text, "base64");
  const bytes = new Int8Array(buf.buffer, buf.byteOffset, buf.length);
  const out: LoudnessFrame[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    const v = bytes[i]!;
    out.push({ t: Math.round((i + 1) * 100) / 1000, m: v === -128 ? Number.NaN : v });
  }
  return out;
}

/** Parses one `ebur128=framelog=verbose` line (needs ffmpeg `-v verbose`). */
export function parseEbur128Frame(line: string): LoudnessFrame | null {
  const r = /\bt:\s*([\d.]+)\s+TARGET:\S+\s+LUFS\s+M:\s*(-?[\d.]+|-?inf|nan)/.exec(line);
  if (!r) return null;
  const m = r[2]!.includes("inf") || r[2] === "nan" ? Number.NaN : Number(r[2]);
  // Below −120 LUFS is digital silence: keep as a very low value (treated like silence).
  return { t: Number(r[1]), m: Number.isFinite(m) ? Math.max(m, -127) : Number.NaN };
}
