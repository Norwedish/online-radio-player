/**
 * Library scanner (M2.1/M2.3): walks the media root and enabled NAS mounts,
 * probes new or changed files, hashes them for duplicate detection, caches
 * artwork, adds files to the playlist named after any folder on their path
 * (`General/…`, `Nieuws/…`, `[PM] 07:00/…`), and marks vanished files missing.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import type { MediaRow, Repositories } from "@radio/db";
import type { RuntimeConfig } from "@radio/shared";
import { parseFilename, probeFile, saveArtwork } from "./probe.js";

export interface MediaRoot {
  id: string;
  path: string;
}

export interface ScanReport {
  roots: number;
  files: number;
  created: number;
  updated: number;
  unchanged: number;
  missing: number;
  errors: string[];
  durationMs: number;
}

const IGNORED_DIRS = new Set(["@eadir", ".git", "#recycle", "$recycle.bin", "lost+found"]);
const HASH_BYTES = 5 * 1024 * 1024;

export function mediaRoots(config: RuntimeConfig): MediaRoot[] {
  const roots: MediaRoot[] = [{ id: "local", path: config.media.root }];
  for (const nas of config.media.nasPaths) {
    if (!nas.enabled) continue;
    roots.push({ id: nas.id, path: join(nas.mountPath, nas.relativePath.replace(/^\//, "")) });
  }
  return roots;
}

/**
 * Every existing file for a library-relative path ("Nieuws/x.mp3"), in root order:
 * media.root first, then the enabled NAS paths in config order. Paths that would
 * escape their root ("../") are never returned.
 */
export function locateInRoots(rel: string, roots: MediaRoot[]): string[] {
  const clean = rel.replace(/^[/\\]+/, "");
  const found: string[] = [];
  for (const root of roots) {
    const full = join(root.path, clean);
    const inside = relative(root.path, full);
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) continue;
    try {
      if (statSync(full).isFile()) found.push(full);
    } catch {
      // not in this root
    }
  }
  return found;
}

/** Temp/partial/hidden files that must never be imported. */
export function isIgnoredName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    name.startsWith(".") ||
    name.startsWith("~$") ||
    /\.(part|tmp|temp|crdownload|partial|download)$/.test(lower) ||
    lower === "thumbs.db"
  );
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (isIgnoredName(e.name)) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name.toLowerCase())) continue;
      yield* walk(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

/** SHA-256 over the first 5 MB + size + rounded duration (PLAN M2.3). */
export async function hashFile(
  path: string,
  size: number,
  duration: number | null,
): Promise<string> {
  const h = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const s = createReadStream(path, { start: 0, end: Math.min(size, HASH_BYTES) - 1 });
    s.on("data", (c) => h.update(c));
    s.on("end", resolve);
    s.on("error", reject);
  });
  h.update(`|${size}|${duration ? Math.round(duration) : 0}`);
  return h.digest("hex").slice(0, 40);
}

function rootFor(path: string, roots: MediaRoot[]): MediaRoot | undefined {
  return roots
    .filter((r) => {
      const rel = relative(r.path, path);
      return rel && !rel.startsWith("..") && !rel.includes(`:${sep}`);
    })
    .sort((a, b) => b.path.length - a.path.length)[0];
}

function relativePath(path: string, roots: MediaRoot[]): string {
  const root = rootFor(path, roots);
  return (root ? relative(root.path, path) : path).split(sep).join("/");
}

class PlaylistMatcher {
  private byName: Map<string, number>;
  constructor(private readonly repos: Repositories) {
    this.byName = new Map(repos.playlists.list().map((p) => [p.name.toLowerCase(), p.id]));
  }
  /** Playlist ids named after any folder on the relative path. */
  match(rel: string): number[] {
    const dirs = rel.split("/").slice(0, -1);
    const ids = new Set<number>();
    for (const d of dirs) {
      const id = this.byName.get(d.toLowerCase());
      if (id !== undefined) ids.add(id);
    }
    return [...ids];
  }
}

export interface ImportOptions {
  /** Re-probe even when size/mtime are unchanged. */
  force?: boolean;
  matcher?: PlaylistMatcher;
}

/** Probes and upserts a single file. */
export async function importFile(
  repos: Repositories,
  config: RuntimeConfig,
  path: string,
  roots: MediaRoot[] = mediaRoots(config),
  options: ImportOptions = {},
): Promise<{ row: MediaRow; created: boolean; changed: boolean }> {
  const st = statSync(path);
  const mtime = st.mtime.toISOString();
  const rel = relativePath(path, roots);
  const existing = repos.media.getByPath(path);
  if (
    existing &&
    !options.force &&
    existing.size === st.size &&
    existing.mtime === mtime &&
    existing.status !== "missing"
  )
    return { row: existing, created: false, changed: false };

  const matcher = options.matcher ?? new PlaylistMatcher(repos);
  let result: { row: MediaRow; created: boolean };
  try {
    const p = await probeFile(path);
    const fromName = parseFilename(path);
    const missingTags = !p.title || !p.artist;
    const hash = await hashFile(path, st.size, p.duration);
    let artwork: string | null = existing?.artwork_path ?? null;
    if (p.picture) {
      try {
        artwork = saveArtwork(config.media.artworkDir, hash, p.picture);
      } catch {
        // artwork is optional
      }
    }
    // Keep operator edits (tag editor) on rescans of a changed file: only fill blanks.
    const keep = <K extends keyof MediaRow>(k: K, v: MediaRow[K] | null) =>
      existing?.tags?.edited && existing[k] !== null ? existing[k] : v;
    result = repos.media.upsert({
      path,
      relative_path: rel,
      title: keep("title", p.title ?? fromName.title),
      artist: keep("artist", p.artist ?? fromName.artist),
      artist_sort: p.artistSort,
      album: keep("album", p.album),
      album_artist: p.albumArtist,
      genre: keep("genre", p.genre),
      year: keep("year", p.year),
      duration: p.duration,
      sample_rate: p.sampleRate,
      channels: p.channels,
      bitrate: p.bitrate,
      codec: p.codec,
      artwork_path: artwork,
      hash,
      size: st.size,
      mtime,
      status: p.duration ? "ok" : "error",
      // A changed file (e.g. a new news bulletin under the same name) needs fresh loudness
      // numbers, and its old automatic cue points no longer fit: play it whole until the
      // analysis has run. Cue points the user pinned by hand are kept.
      ...(existing && existing.hash !== hash
        ? {
            loudness_lufs: null,
            peak_db: null,
            gain_db: null,
            loudness_envelope: null,
            autocue_json: null,
            ...(existing.cue_source !== "manual"
              ? { cue_in: null, cue_out: null, fade_in: null, fade_out: null }
              : {}),
          }
        : {}),
      tags: {
        ...(existing?.tags ?? {}),
        probe: p.source,
        ...(missingTags ? { tagsMissing: true, nameSource: "filename" } : { tagsMissing: false }),
        ...(p.duration ? {} : { error: "no duration" }),
      },
    });
  } catch (e) {
    result = repos.media.upsert({
      path,
      relative_path: rel,
      ...parseFilename(path),
      size: st.size,
      mtime,
      status: "error",
      tags: { ...(existing?.tags ?? {}), error: (e as Error).message.slice(0, 300) },
    });
  }
  const playlists = matcher.match(rel);
  for (const id of playlists) repos.playlists.addItems(id, [result.row.id]);
  return { ...result, changed: true };
}

export async function scanLibrary(
  repos: Repositories,
  config: RuntimeConfig,
  options: { log?: (m: string) => void; roots?: MediaRoot[]; concurrency?: number } = {},
): Promise<ScanReport> {
  const t0 = Date.now();
  const roots = options.roots ?? mediaRoots(config);
  const exts = new Set(config.media.extensions.map((e) => e.toLowerCase()));
  const report: ScanReport = {
    roots: 0,
    files: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    missing: 0,
    errors: [],
    durationMs: 0,
  };
  const matcher = new PlaylistMatcher(repos);
  for (const root of roots) {
    if (!existsSync(root.path)) {
      report.errors.push(`root ${root.id} not found: ${root.path}`);
      continue;
    }
    report.roots += 1;
    const seen = new Set<string>();
    const queue: string[] = [];
    for await (const file of walk(root.path)) {
      if (!exts.has(extname(file).toLowerCase())) continue;
      if (report.files >= config.media.maxScanFiles) {
        report.errors.push(`maxScanFiles (${config.media.maxScanFiles}) reached; scan truncated`);
        break;
      }
      report.files += 1;
      seen.add(file);
      queue.push(file);
    }
    // An unmounted network share (SMB/NFS) looks like an empty folder: never mark the whole
    // library missing because of that.
    if (seen.size === 0 && repos.media.count() > 0) {
      report.errors.push(
        `no audio files found in ${root.path} — is the share mounted? Existing tracks were left as they are.`,
      );
      continue;
    }
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const file = queue[next++]!;
        try {
          const r = await importFile(repos, config, file, roots, { matcher });
          if (r.created) report.created += 1;
          else if (r.changed) report.updated += 1;
          else report.unchanged += 1;
          if (r.row.status === "error") report.errors.push(`${file}: ${String(r.row.tags.error)}`);
        } catch (e) {
          report.errors.push(`${file}: ${(e as Error).message}`);
        }
        if ((report.created + report.updated) % 500 === 0 && report.created + report.updated > 0)
          options.log?.(`scan: ${report.created + report.updated}/${report.files} imported`);
      }
    };
    await Promise.all(Array.from({ length: options.concurrency ?? 4 }, worker));
    // Only mark missing when the walk was complete.
    if (report.files < config.media.maxScanFiles)
      report.missing += repos.media.markMissingExcept(root.path, seen);
  }
  report.durationMs = Date.now() - t0;
  options.log?.(
    `scan done: ${report.files} files, ${report.created} new, ${report.updated} updated, ${report.missing} missing, ${report.errors.length} errors in ${(report.durationMs / 1000).toFixed(1)} s`,
  );
  return report;
}

/** One scan at a time, whether started from the console or by the periodic job. */
let running: Promise<ScanReport> | null = null;

export function isScanRunning(): boolean {
  return running !== null;
}

/** Starts a scan unless one is running (then returns null). */
export function scanLibraryOnce(
  repos: Repositories,
  config: RuntimeConfig,
  options: { log?: (m: string) => void } = {},
): Promise<ScanReport> | null {
  if (running) return null;
  running = scanLibrary(repos, config, options).finally(() => (running = null));
  return running;
}
