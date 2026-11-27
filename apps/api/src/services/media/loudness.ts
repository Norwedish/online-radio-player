/**
 * Loudness analysis (M2.4) + automatic cue points (Liquidsoap-style autocue):
 * FFmpeg `ebur128` gives integrated loudness, true peak and the momentary
 * loudness of every 100 ms frame. The envelope is stored so cue points can be
 * recomputed later without decoding the file again; `computeAutocue` then
 * derives cue-in, cue-out, fade-in and the crossfade length from volume
 * thresholds (see @radio/core `audio/autocue.ts`).
 *
 * Originals are never modified.
 */
import { spawn } from "node:child_process";
import type { MediaRow, Repositories } from "@radio/db";
import {
  AUTOCUE_DEFAULTS,
  computeAutocue,
  decodeEnvelope,
  encodeEnvelope,
  parseEbur128Frame,
  type AutocueOptions,
  type AutocueResult,
  type LoudnessFrame,
} from "@radio/core";

export interface LoudnessResult {
  lufs: number;
  peakDb: number;
  gainDb: number;
  /** Detected cue points, or null when the file has no usable audio. */
  autocue: AutocueResult | null;
}

export interface AutocueSettings extends AutocueOptions {
  enabled: boolean;
}

/** Autocue options from the station settings (fallbacks match Liquidsoap's defaults). */
export function autocueSettings(repos: Repositories): AutocueSettings {
  const get = <T>(key: string, fallback: T): T => repos.settings.get<T>(key, fallback);
  return {
    enabled: get("audio.autocue.enabled", true),
    cueInThreshold: get("audio.autocue.cueInThreshold", AUTOCUE_DEFAULTS.cueInThreshold),
    cueOutThreshold: get("audio.autocue.cueOutThreshold", AUTOCUE_DEFAULTS.cueOutThreshold),
    crossThreshold: get("audio.autocue.crossThreshold", AUTOCUE_DEFAULTS.crossThreshold),
    maxOverlap: get("audio.autocue.maxOverlap", AUTOCUE_DEFAULTS.maxOverlap),
    sustainedEndings: get("audio.autocue.sustainedEndings", AUTOCUE_DEFAULTS.sustainedEndings),
  };
}

const MAX_BOOST_DB = 12;
const MAX_CUT_DB = -24;
/** Keep this much non-frame stderr for error messages (the summary lives at the end). */
const STDERR_TAIL = 8_000;

/**
 * Integrated loudness (LUFS), true peak (dBTP) and the 100 ms momentary
 * loudness envelope of a file in one decode.
 */
export function measureLoudness(
  path: string,
  timeoutMs = 300_000,
): Promise<{ lufs: number; peakDb: number; frames: LoudnessFrame[] }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        // framelog=verbose only prints per-frame values at verbose level.
        "-v",
        "verbose",
        "-nostats",
        "-i",
        path,
        "-map",
        "0:a:0",
        "-filter:a",
        "ebur128=peak=true:framelog=verbose",
        "-f",
        "null",
        "-",
      ],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    const frames: LoudnessFrame[] = [];
    let err = "";
    let pending = "";
    proc.stderr.on("data", (d: Buffer) => {
      pending += d.toString();
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.includes("TARGET:")) {
          const f = parseEbur128Frame(line);
          if (f) frames.push(f);
          continue;
        }
        err = (err + line + "\n").slice(-STDERR_TAIL);
      }
    });
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      // The summary block is the last "Integrated loudness" section.
      const summary = err.slice(err.lastIndexOf("Summary:"));
      const i = /I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(summary);
      const peak = /Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(summary);
      if (code !== 0 || !i) {
        reject(new Error(`ebur128 failed (code ${code}): ${err.trim().split("\n").pop() ?? ""}`));
        return;
      }
      const lufs = i[1] === "-inf" ? -70 : Number(i[1]);
      const peakDb = !peak || peak[1] === "-inf" ? -70 : Number(peak[1]);
      resolve({ lufs, peakDb, frames });
    });
  });
}

export function gainFor(lufs: number, targetLufs: number): number {
  const g = targetLufs - lufs;
  return Math.round(Math.max(MAX_CUT_DB, Math.min(MAX_BOOST_DB, g)) * 100) / 100;
}

/** Detected points as stored in `media.autocue_json` (kept for the UI and re-use). */
export interface StoredAutocue extends AutocueResult {
  lufs: number;
  at: string;
}

function stored(result: AutocueResult, lufs: number): StoredAutocue {
  return { ...result, lufs, at: new Date().toISOString() };
}

/** Cue/fade columns the detector writes (file seconds for cue out). */
function cueColumns(
  r: AutocueResult,
): Pick<MediaRow, "cue_in" | "cue_out" | "fade_in" | "fade_out"> {
  return { cue_in: r.cueIn, cue_out: r.cueOut, fade_in: r.fadeIn, fade_out: r.fadeOut };
}

/**
 * Measures one media row, stores loudness + envelope + detected cue points,
 * and applies the cues unless the user pinned them (`cue_source = 'manual'`).
 * `adopt` overrides that pin (the "detect again and use the result" action).
 */
export async function analyzeMedia(
  repos: Repositories,
  id: number,
  targetLufs: number,
  options: { adopt?: boolean; autocue?: Partial<AutocueSettings> } = {},
): Promise<LoudnessResult> {
  const media = repos.media.get(id);
  if (!media) throw new Error(`media ${id} not found`);
  try {
    const { lufs, peakDb, frames } = await measureLoudness(media.path);
    const gainDb = gainFor(lufs, targetLufs);
    const settings = { ...autocueSettings(repos), ...options.autocue };
    const duration = media.duration ?? frames.at(-1)?.t ?? 0;
    const detected = settings.enabled ? computeAutocue(frames, lufs, duration, settings) : null;
    const adopt = options.adopt === true || media.cue_source !== "manual";
    repos.media.update(id, {
      loudness_lufs: Math.round(lufs * 10) / 10,
      peak_db: Math.round(peakDb * 10) / 10,
      gain_db: gainDb,
      // "" (not null) when there were no frames, so the backfill does not retry forever.
      loudness_envelope: encodeEnvelope(frames),
      autocue_json: detected ? JSON.stringify(stored(detected, lufs)) : null,
      ...(detected && adopt ? { ...cueColumns(detected), cue_source: "auto" } : {}),
    });
    return { lufs, peakDb, gainDb, autocue: detected };
  } catch (e) {
    repos.media.update(id, {
      status: "error",
      tags: { ...media.tags, error: `loudness: ${(e as Error).message}`.slice(0, 300) },
    });
    throw e;
  }
}

/**
 * Recomputes cue points from the stored envelope (no decoding). Used when the
 * thresholds change or the user switches a track back to automatic.
 * `adopt` also overwrites tracks whose cues are pinned as manual.
 * Returns null when the row has no envelope yet.
 */
export function recomputeAutocue(
  repos: Repositories,
  id: number,
  options: Partial<AutocueSettings> = {},
  adopt = false,
): AutocueResult | null {
  const media = repos.media.get(id);
  if (!media) throw new Error(`media ${id} not found`);
  const frames = decodeEnvelope(media.loudness_envelope);
  const lufs = media.loudness_lufs;
  if (frames.length === 0 || lufs === null) return null;
  const settings = { ...autocueSettings(repos), ...options };
  const result = computeAutocue(frames, lufs, media.duration ?? frames.at(-1)?.t ?? 0, settings);
  if (settings.enabled && result && (adopt || media.cue_source !== "manual")) {
    repos.media.update(id, {
      ...cueColumns(result),
      cue_source: "auto",
      autocue_json: JSON.stringify(stored(result, lufs)),
    });
  }
  return result;
}

/** All rows with a stored envelope (for a threshold change across the library). */
export function recomputeAllAutocue(
  repos: Repositories,
  options: Partial<AutocueSettings> = {},
  adopt = false,
): { updated: number; skipped: number } {
  let updated = 0;
  let skipped = 0;
  for (const m of repos.media.allWithEnvelope()) {
    try {
      const before = m.autocue_json;
      if (recomputeAutocue(repos, m.id, options, adopt)) {
        const after = repos.media.get(m.id)?.autocue_json;
        if (after !== before) updated += 1;
        else skipped += 1;
      } else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  return { updated, skipped };
}

/**
 * Analyzes up to `limit` rows still missing loudness or cue points; returns
 * how many were processed (failures are marked `error`, so repeated calls end).
 */
export async function analyzePending(
  repos: Repositories,
  targetLufs: number,
  limit = 10,
): Promise<number> {
  const missingLoudness = repos.media.needsLoudness(limit);
  const rows = [
    ...missingLoudness,
    ...repos.media.needsAutocue(Math.max(0, limit - missingLoudness.length)),
  ];
  let n = 0;
  for (const m of rows) {
    n += 1;
    try {
      await analyzeMedia(repos, m.id, targetLufs);
    } catch {
      // marked as error; keep going
    }
  }
  return n;
}
