/**
 * News bulletins are replaced under the same file name many times a day. The
 * regular library scan (every few minutes) is too slow for that, so the two
 * news files are checked every few seconds: as soon as a new version is
 * completely written (same size and time on two checks in a row), it is
 * re-imported and analysed for loudness and cue points. The playout worker
 * reads those fresh values just before the news goes on air.
 *
 * The files are looked up like the scanner does: under media.root and every
 * enabled NAS path (the news generator writes to the share's Nieuws folder).
 */
import { statSync } from "node:fs";
import type { Repositories } from "@radio/db";
import type { RuntimeConfig } from "@radio/shared";
import { analyzeMedia } from "./loudness.js";
import { importFile, locateInRoots, mediaRoots } from "./scanner.js";

export class NewsRefresher {
  /** Size + modification time seen on the previous check, per file. */
  private lastSeen = new Map<string, string>();
  /** Duplicate-location warnings already logged (rel → locations). */
  private warned = new Map<string, string>();
  private busy = false;

  constructor(
    private readonly repos: Repositories,
    private readonly config: RuntimeConfig,
    /** Relative paths of the news files (generator settings). */
    private readonly newsPaths: () => string[],
    private readonly targetLufs: () => number,
    private readonly log: (m: string) => void = () => {},
  ) {}

  /** Returns how many news files were (re)analysed. */
  async check(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let done = 0;
    try {
      const roots = mediaRoots(this.config);
      for (const rel of this.newsPaths()) {
        const path = this.locate(rel, roots);
        // Missing everywhere: the generator's news_missing alert covers it.
        if (!path) continue;
        const st = statSync(path);
        const sig = `${st.size}:${st.mtime.toISOString()}`;
        const prev = this.lastSeen.get(path);
        this.lastSeen.set(path, sig);
        const row = this.repos.media.getByPath(path);
        const upToDate =
          row &&
          `${row.size}:${row.mtime}` === sig &&
          row.loudness_lufs !== null &&
          row.loudness_envelope !== null;
        if (upToDate) continue;
        // Still being copied (or first look): wait until it stops changing.
        if (prev !== sig) continue;
        const { row: fresh } = await importFile(this.repos, this.config, path, roots);
        if (fresh.status !== "ok") continue;
        try {
          const r = await analyzeMedia(this.repos, fresh.id, this.targetLufs());
          this.log(
            `news: ${rel} updated (${fresh.duration?.toFixed(1)} s, cue ${r.autocue?.cueIn ?? 0}–${r.autocue?.cueOut ?? fresh.duration} s)`,
          );
          done += 1;
        } catch (e) {
          this.log(`news: analysing ${rel} failed: ${(e as Error).message}`);
        }
      }
    } finally {
      this.busy = false;
    }
    return done;
  }

  /**
   * Where the news file actually is. With copies in several roots, media.root wins,
   * then the NAS paths in config order; that is logged once per set of locations.
   */
  private locate(rel: string, roots: ReturnType<typeof mediaRoots>): string | null {
    const found = locateInRoots(rel, roots);
    if (found.length > 1) {
      const key = found.join("|");
      if (this.warned.get(rel) !== key) {
        this.warned.set(rel, key);
        this.log(
          `news: warning: ${rel} exists in ${found.length} places (${found.join(", ")}), using ${found[0]}`,
        );
      }
    } else {
      this.warned.delete(rel);
    }
    return found[0] ?? null;
  }
}
