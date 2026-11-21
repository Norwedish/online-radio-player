#!/usr/bin/env node
/**
 * Development-only Stereo Tool mock.
 *
 * Passes PCM from stdin to stdout unchanged, optionally with a small delay.
 * Use this on Windows/macOS where the Thimeo binary is not available.
 *
 * Usage:
 *   ffmpeg ... -f s16le ... pipe:1 | node scripts/mock-stereotool.mjs | ffmpeg ...
 */
const delayMs = Number(process.env.MOCK_ST_DELAY_MS ?? 0);

process.stdin.on("data", (chunk) => {
  if (delayMs > 0) {
    setTimeout(() => process.stdout.write(chunk), delayMs);
  } else {
    process.stdout.write(chunk);
  }
});

process.stdin.on("end", () => process.stdout.end());
process.stdin.on("error", (error) => {
  console.error("mock-stereotool stdin error:", error);
  process.exit(1);
});

process.stdout.on("error", (error) => {
  if (error && error.code === "EPIPE") process.exit(0);
  console.error("mock-stereotool stdout error:", error);
  process.exit(1);
});

console.error("mock-stereotool: passthrough ready");
