#!/usr/bin/env node
/**
 * Generates the audio fixtures used by the M0 spikes and the audio integration tests.
 *
 * Fixtures (all 48 kHz, 2-channel, s16le PCM WAV — the project's PCM contract):
 *   data/fixtures/tone.wav   60 s 1 kHz tone, used for "is the chain alive at all" checks
 *   data/fixtures/music.wav  90 s pseudo-melody with a tremolo, a stand-in for real media
 *
 * Usage:
 *   node scripts/make-fixtures.mjs        # generate (skip when already present)
 *   node scripts/make-fixtures.mjs -f     # force-regenerate
 *
 * FFmpeg/ffprobe must be on PATH.
 */
import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

const outDir = path.resolve("data/fixtures");
const force = process.argv.includes("-f");

const fixtures = [
  {
    file: "tone.wav",
    note: "1 kHz tone; audible presence check for every mount",
    duration: 60,
    args: [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:sample_rate=48000:duration=60",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
    ],
  },
  {
    file: "music.wav",
    note: "pseudo-melody with tremolo; stand-in for real media",
    duration: 90,
    args: [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "aevalsrc=0.18*sin(2*PI*220*t)+0.12*sin(2*PI*277.18*t)+0.08*sin(2*PI*329.63*t):s=48000:d=90",
      "-af",
      "tremolo=f=3:d=0.35,volume=0.8",
      "-ac",
      "2",
      "-c:a",
      "pcm_s16le",
    ],
  },
];

await mkdir(outDir, { recursive: true });

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true, stdin: "ignore" });
  if (result.error) {
    throw new Error(`spawn ${command} failed: ${result.error.code ?? result.error.message}`);
  }
  if (result.exitCode !== 0 && result.exitCode !== undefined) {
    throw new Error(
      `${command} failed (exit ${result.exitCode} signal ${result.signal ?? "none"}): ${args.join(" ")}`,
    );
  }
  if (result.exitCode === undefined) {
    // Scoop/Chocolatey shims on Windows dev hosts launch the real binary as a child
    // process, so Node cannot recover its exit code. Callers must verify the artifact.
    console.warn(
      `[fixtures] ${command} exit code unavailable on this host (shim); verifying output instead`,
    );
  }
};

for (const fixture of fixtures) {
  const target = path.join(outDir, fixture.file);
  let existing;
  if (!force) {
    try {
      existing = await stat(target);
    } catch {
      existing = undefined;
    }
  }

  if (existing) {
    console.log(`[fixtures] skip ${fixture.file} (use -f to regenerate)`);
    continue;
  }

  console.log(`[fixtures] generating ${fixture.file} — ${fixture.note}`);
  run("ffmpeg", [...fixture.args, target]);

  const probed = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size:stream=codec_name,sample_rate,channels",
      "-of",
      "default=noprint_wrappers=1",
      target,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (probed.exitCode !== 0 && probed.exitCode !== undefined) {
    throw new Error(`ffprobe failed for ${fixture.file} (exit ${probed.exitCode})`);
  }
  if (probed.exitCode === undefined) {
    console.warn(
      `[fixtures] ffprobe exit code unavailable on this host (shim); checking stdout instead`,
    );
  }

  const rate = /sample_rate=(\d+)/.exec(String(probed.stdout))?.[1];
  const channels = /channels=(\d+)/.exec(String(probed.stdout))?.[1];
  const codec = /codec_name=(\w+)/.exec(String(probed.stdout))?.[1];
  const duration = /duration=([\d.]+)/.exec(String(probed.stdout))?.[1];
  if (rate !== "48000" || channels !== "2" || codec !== "pcm_s16le") {
    throw new Error(
      `${fixture.file} does not match the PCM contract: expected pcm_s16le 48000 Hz 2 ch, got ${[codec, rate, channels].join("/")}`,
    );
  }

  const actual = duration ? Number(duration) : Number.NaN;
  if (!(Math.abs(actual - fixture.duration) < 1)) {
    throw new Error(
      `${fixture.file} duration ${actual}s does not match expected ${fixture.duration}s`,
    );
  }

  console.log(`[fixtures] ok ${fixture.file}: pcm_s16le 48000 Hz 2 ch, ${actual}s`);
}

console.log(`[fixtures] done in ${outDir}`);
