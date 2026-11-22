/**
 * Loudness analysis (M2.4): FFmpeg `ebur128` (integrated loudness + true
 * peak); stores `loudness_lufs`, `peak_db` and the playback `gain_db` that
 * brings the track to the station target. Originals are never modified.
 */
import { spawn } from "node:child_process";
import type { Repositories } from "@radio/db";

export interface LoudnessResult {
  lufs: number;
  peakDb: number;
  gainDb: number;
}

const MAX_BOOST_DB = 12;
const MAX_CUT_DB = -24;

/** Integrated loudness (LUFS) and true peak (dBTP) of a file. */
export function measureLoudness(
  path: string,
  timeoutMs = 300_000,
): Promise<{ lufs: number; peakDb: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-hide_banner",
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
    let err = "";
    proc.stderr.on("data", (d: Buffer) => {
      err += d.toString();
      if (err.length > 200_000) err = err.slice(-50_000);
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
      resolve({ lufs, peakDb });
    });
  });
}

export function gainFor(lufs: number, targetLufs: number): number {
  const g = targetLufs - lufs;
  return Math.round(Math.max(MAX_CUT_DB, Math.min(MAX_BOOST_DB, g)) * 100) / 100;
}

/** Measures one media row and stores the result (status → error when unreadable). */
export async function analyzeMedia(
  repos: Repositories,
  id: number,
  targetLufs: number,
): Promise<LoudnessResult> {
  const media = repos.media.get(id);
  if (!media) throw new Error(`media ${id} not found`);
  try {
    const { lufs, peakDb } = await measureLoudness(media.path);
    const gainDb = gainFor(lufs, targetLufs);
    repos.media.update(id, {
      loudness_lufs: Math.round(lufs * 10) / 10,
      peak_db: Math.round(peakDb * 10) / 10,
      gain_db: gainDb,
    });
    return { lufs, peakDb, gainDb };
  } catch (e) {
    repos.media.update(id, {
      status: "error",
      tags: { ...media.tags, error: `loudness: ${(e as Error).message}`.slice(0, 300) },
    });
    throw e;
  }
}

/**
 * Analyzes up to `limit` rows still missing loudness; returns how many were
 * processed (failures are marked `error`, so a loop until 0 always ends).
 */
export async function analyzePending(
  repos: Repositories,
  targetLufs: number,
  limit = 10,
): Promise<number> {
  let n = 0;
  for (const m of repos.media.needsLoudness(limit)) {
    n += 1;
    try {
      await analyzeMedia(repos, m.id, targetLufs);
    } catch {
      // marked as error; keep going
    }
  }
  return n;
}
