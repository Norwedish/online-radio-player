import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * M0.10 walking skeleton: tone -> mock Stereo Tool -> MP3 320k -> Icecast.
 *
 * This is a placeholder for the real chain in M4/M5: no decks, no mixer, no
 * scheduling. It exists so `/listen` plays audible audio end to end and the
 * deployment wiring (FFmpeg, mock ST, Icecast mount) is proven.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export interface SkeletonStream {
  stop(): void;
}

export function startSkeletonStream(
  log: (message: string) => void = console.log,
): SkeletonStream | null {
  const input = process.env.SKELETON_INPUT ?? path.join(repoRoot, "data/fixtures/tone.wav");
  const mockStereoTool = path.join(repoRoot, "scripts/mock-stereotool.mjs");
  const password = process.env.ICECAST_SOURCE_PASSWORD ?? "change-me-source";
  const icecastUrl =
    process.env.SKELETON_ICECAST_URL ?? `icecast://source:${password}@127.0.0.1:8000/hq.mp3`;

  if (!existsSync(input)) {
    log(`skeleton stream disabled: ${input} not found (run pnpm spike:fixtures)`);
    return null;
  }
  if (!existsSync(mockStereoTool)) {
    log(`skeleton stream disabled: ${mockStereoTool} not found`);
    return null;
  }

  log(
    `skeleton stream: ${path.relative(repoRoot, input)} -> mock ST -> ${icecastUrl.replace(password, "***")}`,
  );

  const decoder = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "warning",
      "-stream_loop",
      "-1",
      "-re",
      "-i",
      input,
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );

  const stereoTool = spawn(process.execPath, [mockStereoTool], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const encoder = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "warning",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      // ADR 0001: pipe-fed FFmpeg needs these or it spends ~3.8 s probing.
      "-analyzeduration",
      "0",
      "-probesize",
      "32768",
      "-i",
      "pipe:0",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "320k",
      // FFmpeg's icecast muxer only recognizes Ogg/WebM/Opus magic bytes, so an
      // unset content type makes it warn "unsupported format" even for MP3. Set it
      // explicitly (audio/aac and audio/ogg are required for the other mounts).
      "-content_type",
      "audio/mpeg",
      "-f",
      "mp3",
      icecastUrl,
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );

  decoder.stdout.pipe(stereoTool.stdin);
  stereoTool.stdout.pipe(encoder.stdin);

  const children: Array<[string, ChildProcess]> = [
    ["decoder", decoder],
    ["mock-stereotool", stereoTool],
    ["encoder", encoder],
  ];

  for (const [name, child] of children) {
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = String(chunk).trim();
      if (text) log(`skeleton ${name}: ${text}`);
    });
    child.on("error", (error) => log(`skeleton ${name} failed to start: ${error.message}`));
    child.on("exit", (code, signal) => {
      if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") {
        log(`skeleton ${name} exited code=${code} signal=${signal}`);
      }
    });
  }

  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      for (const [, child] of children) {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
    },
  };
}
