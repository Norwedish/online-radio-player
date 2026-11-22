/** Test helpers: temp DB + FFmpeg-generated audio fixtures. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createRepositories,
  openDatabase,
  runMigrations,
  seedDatabase,
  type Repositories,
} from "@radio/db";
import { loadRuntimeConfig, type RuntimeConfig } from "@radio/shared";

export interface TestEnv {
  dir: string;
  repos: Repositories;
  config: RuntimeConfig;
  cleanup(): void;
}

export async function createTestEnv(options: { admin?: boolean } = {}): Promise<TestEnv> {
  const dir = mkdtempSync(join(tmpdir(), "radio-test-"));
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    DATA_DIR: dir,
    RADIO_SECRETS: join(dir, "none.env"),
    RADIO_ROOT: join(dirname(fileURLToPath(import.meta.url)), "../../.."),
    ICECAST_SOURCE_PASSWORD: "test-source",
    STEREOTOOL_MOCK: "1",
  };
  const config = loadRuntimeConfig({ env, rootDir: env.RADIO_ROOT });
  mkdirSync(config.media.root, { recursive: true });
  runMigrations(config.db.file);
  const db = openDatabase(config.db.file);
  await seedDatabase(
    db,
    options.admin ? { admin: { username: "admin", password: "admin-password-123" } } : {},
  );
  const repos = createRepositories(db);
  return {
    dir,
    repos,
    config,
    cleanup() {
      try {
        db.close();
      } catch {
        // ignore
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface ToneOptions {
  seconds: number;
  frequency?: number;
  amplitude?: number;
  title?: string;
  artist?: string;
  album?: string;
  cover?: boolean;
  format?: "mp3" | "wav" | "flac" | "ogg";
}

/** Writes a stereo sine tone with optional ID3 tags/cover art. */
export function makeTone(path: string, opts: ToneOptions): string {
  mkdirSync(dirname(path), { recursive: true });
  const amp = opts.amplitude ?? 0.1;
  const freq = opts.frequency ?? 997;
  const format = opts.format ?? "mp3";
  const target = opts.cover ? `${path}.nocover.${format}` : path;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=${amp}*sin(2*PI*${freq}*t)|${amp}*sin(2*PI*${freq}*t):s=48000:d=${opts.seconds}`,
  ];
  if (format === "mp3") args.push("-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "3");
  if (format === "flac") args.push("-c:a", "flac");
  if (format === "ogg") args.push("-c:a", "libopus", "-b:a", "64k");
  if (opts.title) args.push("-metadata", `title=${opts.title}`);
  if (opts.artist) args.push("-metadata", `artist=${opts.artist}`);
  if (opts.album) args.push("-metadata", `album=${opts.album}`);
  args.push(target);
  execFileSync("ffmpeg", args);
  if (opts.cover) {
    // Second pass: attach a PNG cover without re-encoding (single-pass muxing truncates the audio).
    const png = `${path}.cover.png`;
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=green:s=64x64",
      "-frames:v",
      "1",
      png,
    ]);
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      target,
      "-i",
      png,
      "-map",
      "0:a",
      "-map",
      "1:v",
      "-c",
      "copy",
      "-disposition:v",
      "attached_pic",
      "-id3v2_version",
      "3",
      path,
    ]);
    rmSync(target);
    rmSync(png);
  }
  return path;
}
