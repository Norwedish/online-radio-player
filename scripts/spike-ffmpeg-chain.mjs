#!/usr/bin/env node
/**
 * M0.4 spike: decode -> PCM -> mock Stereo Tool -> MP3 -> Icecast.
 *
 * Measures:
 *  - source startup time until the mount appears in Icecast stats
 *  - first listener byte latency
 *  - captured audio size/duration
 *  - CPU from FFmpeg's `-benchmark` output plus the mock Stereo Tool's own usage
 *
 * The chain is allowed to run to completion so the benchmark lines are emitted.
 *
 * Usage:
 *   node scripts/spike-ffmpeg-chain.mjs [input] [seconds] [mount]
 *
 * Env:
 *   ICECAST_HOST (default 127.0.0.1)
 *   ICECAST_PORT (default 8000)
 *   ICECAST_SOURCE_PASSWORD (default change-me-source)
 *   SPIKE_DEBUG=1 for verbose process output
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const input = process.argv[2] ?? "data/fixtures/music.wav";
const seconds = Number(process.argv[3] ?? 30);
const mount = process.argv[4] ?? "hq.mp3";

const host = process.env.ICECAST_HOST ?? "127.0.0.1";
const port = process.env.ICECAST_PORT ?? "8000";
const password = process.env.ICECAST_SOURCE_PASSWORD ?? "change-me-source";
const sourceUrl = `icecast://source:${password}@${host}:${port}/${mount}`;
const statusUrl = `http://${host}:${port}/status-json.xsl`;
const listenUrl = `http://${host}:${port}/${mount}`;
const outDir = path.resolve("data/fixtures");
const captureSlug = mount.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");
const capturePath = path.join(outDir, `capture-${captureSlug}.mp3`);
const resultPath = process.env.SPIKE_RESULT_PATH
  ? path.resolve(process.env.SPIKE_RESULT_PATH)
  : path.join(outDir, "spike-result.json");
const debug = process.env.SPIKE_DEBUG === "1";

await mkdir(outDir, { recursive: true });

const log = (...args) => console.log(`[spike]`, ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function spawnChild(name, command, args, stdio) {
  const child = spawn(command, args, { stdio, windowsHide: true });
  child.on("error", (error) => log(`${name} spawn error: ${error.message}`));
  return child;
}

function collectStderr(name, child) {
  let text = "";
  child.stderr?.on("data", (chunk) => {
    const value = String(chunk);
    text += value;
    if (debug) {
      for (const line of value.split(/\r?\n/).filter(Boolean)) {
        log(`${name} +${Date.now() - startedAt}ms: ${line}`);
      }
    }
  });
  return () => text;
}

function parseBench(text) {
  const match = /bench:\s*utime=([\d.]+)s\s+stime=([\d.]+)s\s+rtime=([\d.]+)s/.exec(text);
  if (!match) return null;
  return {
    utime: Number(match[1]),
    stime: Number(match[2]),
    rtime: Number(match[3]),
    cpuSeconds: Number(match[1]) + Number(match[2]),
  };
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      log(`timeout waiting for ${child.spawnfile}; killing`);
      child.kill("SIGKILL");
      resolve({ code: null, signal: "SIGKILL" });
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitForMount(timeoutMs = 15000) {
  const started = Date.now();
  let lastError = "no successful status fetch";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(statusUrl, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const data = await response.json();
        const raw = data?.icestats?.source;
        const sources = Array.isArray(raw) ? raw : raw ? [raw] : [];
        const found = sources.find((source) => {
          const url = String(source.listenurl ?? source.mount ?? "");
          return url.endsWith(`/${mount}`) || url.endsWith(mount);
        });
        if (found) return Date.now() - started;
        lastError = `status reachable, mount /${mount} not listed (sources: ${
          sources.map((source) => source?.listenurl ?? "?").join(", ") || "none"
        })`;
      } else {
        lastError = `status HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error.message;
    }
    await sleep(200);
  }
  throw new Error(`Mount /${mount} did not appear within ${timeoutMs} ms; last: ${lastError}`);
}

async function mountPresent() {
  try {
    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return false;
    const data = await response.json();
    const raw = data?.icestats?.source;
    const sources = Array.isArray(raw) ? raw : raw ? [raw] : [];
    return sources.some((source) => {
      const url = String(source.listenurl ?? source.mount ?? "");
      return url.endsWith(`/${mount}`) || url.endsWith(mount);
    });
  } catch {
    return false;
  }
}

/**
 * Polls the mount while the source runs, so a soak test can prove the source
 * never dropped. Returns counts only; per-sample data is too noisy for a result file.
 */
async function watchMount(child, intervalMs = 5000) {
  const samples = [];
  const timer = setInterval(async () => {
    samples.push({ at: Date.now() - startedAt, present: await mountPresent() });
  }, intervalMs);
  const done = new Promise((resolve) => child.once("exit", resolve));
  await done;
  clearInterval(timer);
  return {
    samples: samples.length,
    missing: samples.filter((sample) => !sample.present).length,
    firstMissingAt: samples.find((sample) => !sample.present)?.at ?? null,
  };
}

async function captureFirstAudio(maxBytes = 256 * 1024, maxMs = 8000) {
  const started = Date.now();
  const response = await fetch(listenUrl, { signal: AbortSignal.timeout(maxMs + 2000) });
  if (!response.ok) throw new Error(`Listener HTTP ${response.status}`);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let firstByteMs;

  while (total < maxBytes && Date.now() - started < maxMs) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstByteMs === undefined) firstByteMs = Date.now() - started;
    chunks.push(Buffer.from(value));
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  return { buffer: Buffer.concat(chunks), firstByteMs, total, elapsedMs: Date.now() - started };
}

function probe(file) {
  try {
    const out = execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration,bit_rate",
        "-of",
        "default=noprint_wrappers=1:nokey=0",
        file,
      ],
      { encoding: "utf8", windowsHide: true, timeout: 10000 },
    );
    const duration = /duration=([\d.]+)/.exec(out)?.[1];
    const bitRate = /bit_rate=(\d+)/.exec(out)?.[1];
    return {
      duration: duration ? Number(duration) : null,
      bitRate: bitRate ? Number(bitRate) : null,
    };
  } catch {
    return { duration: null, bitRate: null };
  }
}

const startedAt = Date.now();

const inputInfo = probe(input);
const inputSeconds = inputInfo?.duration ?? 0;
const loopsForever = inputSeconds > 0 && seconds > inputSeconds;

const decoderArgs = [
  "-hide_banner",
  "-nostats",
  "-benchmark",
  ...(loopsForever ? ["-stream_loop", "-1"] : []),
  "-re",
  "-i",
  input,
  "-t",
  String(seconds),
  "-f",
  "s16le",
  "-ar",
  "48000",
  "-ac",
  "2",
  "pipe:1",
];

const decoder = spawnChild("decoder", "ffmpeg", decoderArgs, ["ignore", "pipe", "pipe"]);

const stereoTool = spawnChild(
  "mock-stereotool",
  process.execPath,
  ["scripts/mock-stereotool.mjs"],
  ["pipe", "pipe", "pipe"],
);

const encoder = spawnChild(
  "encoder",
  "ffmpeg",
  [
    "-hide_banner",
    "-nostats",
    "-benchmark",
    "-v",
    debug ? "debug" : "info",
    "-probesize",
    "32768",
    "-analyzeduration",
    "0",
    "-f",
    "s16le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-i",
    "pipe:0",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "320k",
    "-f",
    "mp3",
    "-content_type",
    "audio/mpeg",
    sourceUrl,
  ],
  ["pipe", "ignore", "pipe"],
);

const getDecoderStderr = collectStderr("decoder", decoder);
const getStereoToolStderr = collectStderr("mock-stereotool", stereoTool);
const getEncoderStderr = collectStderr("encoder", encoder);

decoder.stdout.pipe(stereoTool.stdin);
stereoTool.stdout.pipe(encoder.stdin);
decoder.stdout.on("error", () => {});
stereoTool.stdin.on("error", () => {});
stereoTool.stdout.on("error", () => {});
encoder.stdin.on("error", () => {});

const pids = [decoder.pid, stereoTool.pid, encoder.pid].filter(Boolean);
log(`pids: ${pids.join(", ")}`);
log(`input: ${input}, duration: ${seconds}s, source: ${sourceUrl}`);

const start = startedAt;

try {
  const startupMs = await waitForMount();
  log(`mount appeared after ${startupMs} ms`);

  const capture = await captureFirstAudio();
  await writeFile(capturePath, capture.buffer);
  log(
    `captured ${capture.total} bytes in ${capture.elapsedMs} ms; first byte after ${capture.firstByteMs} ms`,
  );

  log("waiting for the chain to finish so benchmark lines are emitted...");
  const soakPromise = seconds >= 60 ? watchMount(decoder) : null;
  const decoderExit = await waitForExit(decoder, seconds * 1000 + 10000);
  const soak = soakPromise ? await soakPromise : null;
  const encoderExit = await waitForExit(encoder, 10000);
  const stereoToolExit = await waitForExit(stereoTool, 5000);

  const decoderBench = parseBench(getDecoderStderr());
  const encoderBench = parseBench(getEncoderStderr());
  const stereoToolBench = parseBench(getStereoToolStderr());
  const wallSeconds = Math.max(0.001, (Date.now() - start) / 1000);
  const cpuSeconds =
    (decoderBench?.cpuSeconds ?? 0) +
    (encoderBench?.cpuSeconds ?? 0) +
    (stereoToolBench?.cpuSeconds ?? 0);

  const probeResult = probe(capturePath);
  const result = {
    at: new Date().toISOString(),
    platform: process.platform,
    input,
    inputSeconds,
    streamLoop: loopsForever,
    requestedSeconds: seconds,
    mount,
    sourceUrl: sourceUrl.replace(password, "***"),
    startupMs,
    firstByteMs: capture.firstByteMs,
    captureBytes: capture.total,
    captureElapsedMs: capture.elapsedMs,
    captureDurationSeconds: probeResult.duration,
    captureBitRate: probeResult.bitRate,
    wallSeconds,
    cpuSeconds,
    averageCpuCores: cpuSeconds / wallSeconds,
    benchmarks: {
      decoder: decoderBench,
      mockStereoTool: stereoToolBench,
      encoder: encoderBench,
    },
    soak,
    exits: { decoder: decoderExit, encoder: encoderExit, stereoTool: stereoToolExit },
  };

  await writeFile(resultPath, JSON.stringify(result, null, 2));
  log(`result written to ${resultPath}`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  log(`FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  for (const child of [decoder, stereoTool, encoder]) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await sleep(500);
  for (const child of [decoder, stereoTool, encoder]) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
