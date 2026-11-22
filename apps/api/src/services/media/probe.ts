/**
 * Media probing (M2.1/M2.2): tags and stream info via `music-metadata`, with
 * an `ffprobe` fallback for files it cannot parse; embedded artwork is cached
 * under `media.artworkDir` keyed by the content hash.
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { parseFile } from "music-metadata";

const run = promisify(execFile);

export interface Picture {
  data: Buffer;
  format: string;
}

export interface ProbeResult {
  title: string | null;
  artist: string | null;
  artistSort: string | null;
  album: string | null;
  albumArtist: string | null;
  genre: string | null;
  year: number | null;
  duration: number | null;
  sampleRate: number | null;
  channels: number | null;
  /** kbit/s */
  bitrate: number | null;
  codec: string | null;
  picture: Picture | null;
  source: "music-metadata" | "ffprobe";
}

const clean = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\0/g, "").trim();
  return s.length ? s.slice(0, 500) : null;
};

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number.parseFloat(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
};

async function probeWithMusicMetadata(path: string): Promise<ProbeResult> {
  const { common, format } = await parseFile(path, { duration: true, skipCovers: false });
  const pic = common.picture?.[0];
  return {
    title: clean(common.title),
    artist: clean(common.artist),
    artistSort: clean(common.artistsort),
    album: clean(common.album),
    albumArtist: clean(common.albumartist),
    genre: clean(common.genre?.[0]),
    year: num(common.year),
    duration: num(format.duration),
    sampleRate: num(format.sampleRate),
    channels: num(format.numberOfChannels),
    bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null,
    codec: clean(format.codec ?? format.container)?.toLowerCase() ?? null,
    picture: pic ? { data: Buffer.from(pic.data), format: pic.format } : null,
    source: "music-metadata",
  };
}

interface FfprobeJson {
  format?: { duration?: string; bit_rate?: string; tags?: Record<string, string> };
  streams?: {
    codec_type?: string;
    codec_name?: string;
    sample_rate?: string;
    channels?: number;
    tags?: Record<string, string>;
  }[];
}

async function probeWithFfprobe(path: string): Promise<ProbeResult> {
  const { stdout } = await run(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    { windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const j = JSON.parse(stdout) as FfprobeJson;
  const audio = j.streams?.find((s) => s.codec_type === "audio");
  if (!audio) throw new Error("no audio stream");
  const raw = { ...(audio.tags ?? {}), ...(j.format?.tags ?? {}) };
  const tags = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    title: clean(tags.title),
    artist: clean(tags.artist),
    artistSort: clean(tags.artistsort ?? tags["artist-sort"]),
    album: clean(tags.album),
    albumArtist: clean(tags.album_artist ?? tags.albumartist),
    genre: clean(tags.genre),
    year: num(String(tags.date ?? tags.year ?? "").slice(0, 4)),
    duration: num(j.format?.duration),
    sampleRate: num(audio.sample_rate),
    channels: num(audio.channels),
    bitrate: num(j.format?.bit_rate) ? Math.round(Number(j.format!.bit_rate) / 1000) : null,
    codec: clean(audio.codec_name),
    picture: null,
    source: "ffprobe",
  };
}

/** Probes a file; throws when neither music-metadata nor ffprobe can read audio from it. */
export async function probeFile(path: string): Promise<ProbeResult> {
  let first: unknown;
  try {
    const r = await probeWithMusicMetadata(path);
    if (r.duration) return r;
    // No duration (e.g. odd containers): ask ffprobe, keep the richer tags.
    const f = await probeWithFfprobe(path).catch(() => null);
    return f ? { ...f, ...pickDefined(r), duration: f.duration, source: "ffprobe" } : r;
  } catch (e) {
    first = e;
  }
  try {
    return await probeWithFfprobe(path);
  } catch (e) {
    throw new Error(
      `unreadable: ${(first as Error)?.message ?? ""} / ffprobe: ${(e as Error).message}`.slice(
        0,
        300,
      ),
    );
  }
}

function pickDefined(r: ProbeResult): Partial<ProbeResult> {
  return Object.fromEntries(
    Object.entries(r).filter(([, v]) => v !== null && v !== undefined),
  ) as Partial<ProbeResult>;
}

/** "Artist - Title.mp3" → { artist, title }; anything else → { title: basename }. */
export function parseFilename(path: string): { artist: string | null; title: string | null } {
  const base = basename(path, extname(path))
    .replace(/^\d{1,3}[\s._-]+/, "") // leading track number
    .replace(/_/g, " ")
    .trim();
  const m = /^(.+?)\s+[-–]\s+(.+)$/.exec(base);
  if (m) return { artist: clean(m[1]), title: clean(m[2]) };
  return { artist: null, title: clean(base) };
}

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Writes artwork bytes to `<dir>/<key>.<ext>` and returns the path. */
export function saveArtwork(dir: string, key: string, picture: Picture): string {
  mkdirSync(dir, { recursive: true });
  const ext = EXT[picture.format.toLowerCase()] ?? "jpg";
  const safe = key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  const path = join(dir, `${safe}.${ext}`);
  writeFileSync(path, picture.data);
  return path;
}
