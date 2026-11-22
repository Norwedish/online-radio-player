#!/usr/bin/env node
/**
 * M0.7 spike: external-DJ latency through Icecast ingest.
 *
 * 1. Generates a 1 kHz burst every 2 s (markers.wav).
 * 2. Publishes it to Icecast in real time as MP3 128k on /live-test.
 * 3. Connects a listener and timestamps every burst it hears.
 * 4. Latency = burst arrival - (source start + k * 2 s).
 *
 * Usage: node scripts/spike-live-icecast.mjs [seconds]
 * Writes data/spike/live/icecast-result.json.
 */
import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const seconds = Number(process.argv[2] ?? 30);
const dir = path.resolve("data/spike/live");
const markers = path.resolve("data/fixtures/markers.wav");
const resultPath = path.join(dir, "icecast-result.json");
const mount = "live-test";
const password = process.env.ICECAST_SOURCE_PASSWORD ?? "change-me-source";
const sourceUrl = `icecast://source:${password}@127.0.0.1:8000/${mount}`;
const listenerUrl = `http://127.0.0.1:8000/${mount}`;
const burstPeriodMs = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log("[icecast]", ...args);

await mkdir(dir, { recursive: true });
await mkdir(path.dirname(markers), { recursive: true });

let haveMarkers = false;
try {
  haveMarkers = (await stat(markers)).size > 1000;
} catch {
  haveMarkers = false;
}

function run(name, command, args, options = {}) {
  const child = spawn(command, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  child.stderr?.on("data", (chunk) => {
    if (process.env.SPIKE_DEBUG) log(`${name}: ${String(chunk).trim()}`);
  });
  return child;
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve({ code: null, signal: "TIMEOUT" });
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

if (!haveMarkers) {
  log(`generating ${path.relative(process.cwd(), markers)}`);
  const gen = run("generate", "ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "aevalsrc=if(lt(mod(t\\,2)\\,0.06)\\,0.7*sin(2*PI*1000*t)\\,0):s=48000:d=40",
    "-ac",
    "2",
    "-c:a",
    "pcm_s16le",
    markers,
  ]);
  const genExit = await waitExit(gen, 60_000);
  if (genExit.code !== 0) {
    throw new Error(`marker generation failed: ${JSON.stringify(genExit)}`);
  }
}

log(`source -> ${sourceUrl.replace(password, "***")} (${seconds}s)`);

const source = run("source", "ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "warning",
  "-progress",
  "pipe:1",
  "-stats_period",
  "0.1",
  "-re",
  "-stream_loop",
  "-1",
  "-i",
  markers,
  "-t",
  String(seconds + 4),
  "-c:a",
  "libmp3lame",
  "-b:a",
  "128k",
  "-ar",
  "48000",
  "-ac",
  "2",
  "-f",
  "mp3",
  sourceUrl,
]);
// Media timeline of the source: ffmpeg -progress reports out_time_us; record the
// wall time when each burst's media position is reached. This removes the
// startup pacing race (ffmpeg emits its first chunks faster than real time).
const sourceProgress = [];
let progressBuffer = "";
source.stdout.on("data", (chunk) => {
  progressBuffer += String(chunk);
  const lines = progressBuffer.split(/\r?\n/);
  progressBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const match = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
    if (!match) continue;
    // ffmpeg 7 reports both out_time_us and out_time_ms in microseconds.
    sourceProgress.push({ mediaUs: Number(match[1]), at: Date.now() });
  }
});

await sleep(400);

const listener = run("listener", "ffmpeg", [
  "-hide_banner",
  "-nostats",
  "-loglevel",
  "warning",
  "-i",
  listenerUrl,
  "-t",
  String(seconds),
  "-f",
  "s16le",
  "-ac",
  "2",
  "-ar",
  "48000",
  "pipe:1",
]);

let pending = Buffer.alloc(0);
const threshold = 5000;
let armed = true;
const bursts = [];
let listenStartedAt = Date.now();

listener.stdout.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  const frameBytes = 4; // stereo s16
  const windowBytes = 512 * frameBytes;
  while (pending.length >= windowBytes) {
    const window = pending.subarray(0, windowBytes);
    pending = pending.subarray(windowBytes);
    let peak = 0;
    for (let i = 0; i + 1 < window.length; i += 2) {
      const v = Math.abs(window.readInt16LE(i));
      if (v > peak) peak = v;
    }
    const active = peak > threshold;
    if (active && armed) {
      armed = false;
      bursts.push({ at: Date.now(), peak });
    } else if (!active && !armed) {
      armed = true;
    }
  }
});

await sleep(600);
log(`listener connected; collecting for ${seconds}s`);

const listenerExit = await waitExit(listener, (seconds + 30) * 1000);
const sourceExit = await waitExit(source, 5_000);
const listenMs = Date.now() - listenStartedAt;

const emissionFor = (k) => {
  const targetUs = k * burstPeriodMs * 1000;
  const sample = sourceProgress.find((s) => s.mediaUs >= targetUs);
  return sample?.at ?? null;
};

const latencies = bursts
  .map((burst, k) => {
    const emittedAt = emissionFor(k);
    if (emittedAt === null) return null;
    return { k, latencyMs: burst.at - emittedAt, at: burst.at };
  })
  .filter((b) => b !== null && b.latencyMs > -1000 && b.latencyMs < 30_000);

const values = latencies.map((b) => b.latencyMs).sort((a, b) => a - b);
const avg = values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
const pct = (p) => values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))];

const result = {
  at: new Date().toISOString(),
  platform: process.platform,
  mount,
  seconds,
  burstPeriodMs,
  timeline: "ffmpeg -progress out_time_us (100 ms resolution)",
  progressSamples: sourceProgress.length,
  burstsDetected: bursts.length,
  burstsMatched: latencies.length,
  latencyMs: {
    avg: +avg.toFixed(1),
    p50: +(pct(0.5) ?? NaN).toFixed(1),
    p95: +(pct(0.95) ?? NaN).toFixed(1),
    max: +(pct(1) ?? NaN).toFixed(1),
    min: +(values[0] ?? NaN).toFixed(1),
  },
  perBurst: latencies.slice(0, 30).map((b) => ({ k: b.k, ms: +b.latencyMs.toFixed(1) })),
  listenMs,
  sourceExit,
  listenerExit,
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
log(`result written to ${resultPath}`);
console.log(JSON.stringify(result, null, 2));

if (latencies.length < 5) {
  log("verdict: FAIL (fewer than 5 bursts matched)");
  process.exitCode = 1;
} else {
  log("verdict: PASS");
}
