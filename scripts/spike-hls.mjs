#!/usr/bin/env node
/**
 * M0.6 spike: HLS as an FFmpeg packaging step (upstream Icecast has no HLS).
 *
 * Produces AAC 96k HLS segments from a fixture in real time, watches the playlist
 * appear and grow, then checks that nginx serves the playlist and segments with
 * the right content types (the nginx-hls dev container, port 8081).
 *
 * Usage:
 *   node scripts/spike-hls.mjs [input] [seconds]
 *
 * Writes data/spike/hls/spike-result.json and leaves the live artifacts in place
 * (stream.m3u8, seg*.ts, player.html) so the browser test can run while the
 * producer is still streaming.
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const input = process.argv[2] ?? "data/fixtures/music.wav";
const seconds = Number(process.argv[3] ?? 120);
const outDir = path.resolve("data/spike/hls");
const resultPath = path.join(outDir, "spike-result.json");
const playlistName = "stream.m3u8";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log("[hls]", ...args);

await mkdir(outDir, { recursive: true });
for (const entry of await readdir(outDir)) {
  if (entry.endsWith(".ts") || entry.endsWith(".m3u8")) {
    await unlink(path.join(outDir, entry)).catch(() => {});
  }
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const child = spawn(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      {
        windowsHide: true,
      },
    );
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.on("close", () => resolve(Number.parseFloat(out.trim()) || 0));
    child.on("error", () => resolve(0));
  });
}

const inputSeconds = await probeDuration(input);
const loopsForever = inputSeconds > 0 && seconds > inputSeconds;

const playerHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>M0.6 HLS spike</title>
<style>
  body { background: #111; color: #eee; font-family: ui-monospace, monospace; padding: 16px; }
  #log { white-space: pre-wrap; font-size: 12px; margin-top: 12px; }
  button { padding: 8px 16px; margin-top: 8px; }
</style>
</head>
<body>
<h1>HLS spike (M0.6)</h1>
<audio id="a" controls></audio>
<button id="play">Play</button>
<div id="log"></div>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"></script>
<script>
  const log = (...args) => {
    const line = args.join(" ");
    document.getElementById("log").textContent += line + "\\n";
    console.log(line);
  };
  const audio = document.getElementById("a");
  const url = "/hls/stream.m3u8";
  document.getElementById("play").onclick = () => {
    audio.play().then(() => log("play started")).catch((e) => log("play error", e.message));
  };
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({ liveSyncDurationCount: 3 });
    hls.loadSource(url);
    hls.attachMedia(audio);
    window.__hls = hls;
    hls.on(Hls.Events.MANIFEST_PARSED, () => log("manifest parsed levels=" + hls.levels.length));
    hls.on(Hls.Events.LEVEL_LOADED, (e, d) =>
      log("level loaded live=" + d.details.live + " target=" + d.details.targetduration + " segs=" + d.details.fragments.length));
    hls.on(Hls.Events.FRAG_LOADED, (e, d) => log("frag loaded sn=" + d.frag.sn + " dur=" + d.frag.duration));
    hls.on(Hls.Events.ERROR, (e, d) => log("ERROR " + d.type + " " + d.details + " fatal=" + d.fatal));
    setInterval(() => {
      log(
        "status latency=" + (hls.latency ?? -1).toFixed(2) +
        " liveSync=" + (hls.liveSyncPosition ?? -1).toFixed(2) +
        " currentTime=" + audio.currentTime.toFixed(2) +
        " paused=" + audio.paused,
      );
    }, 2000);
  } else if (audio.canPlayType("application/vnd.apple.mpegurl")) {
    audio.src = url;
    log("native HLS (Safari path)");
  } else {
    log("HLS not supported in this browser");
  }
</script>
</body>
</html>`;
await writeFile(path.join(outDir, "player.html"), playerHtml);

const ffmpegArgs = [
  "-hide_banner",
  "-nostats",
  "-loglevel",
  "warning",
  ...(loopsForever ? ["-stream_loop", "-1"] : []),
  "-re",
  "-i",
  input,
  "-t",
  String(seconds),
  "-c:a",
  "aac",
  "-b:a",
  "96k",
  "-ar",
  "48000",
  "-ac",
  "2",
  "-f",
  "hls",
  "-hls_time",
  "2",
  "-hls_list_size",
  "6",
  "-hls_flags",
  "delete_segments+omit_endlist+independent_segments",
  "-hls_segment_filename",
  path.join(outDir, "seg%05d.ts"),
  path.join(outDir, playlistName),
];

log(`input=${input} duration=${inputSeconds}s requested=${seconds}s loop=${loopsForever}`);
log(`output=${path.relative(process.cwd(), outDir)}`);

const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let ffmpegErr = "";
ffmpeg.stderr.on("data", (chunk) => {
  ffmpegErr += String(chunk);
});

const startedAt = Date.now();
const playlistPath = path.join(outDir, playlistName);
let firstPlaylistMs = null;
let firstSegmentMs = null;
let maxSegments = 0;
let lastTarget = null;
let mediaSequence = null;
let playlistSamples = 0;
let segmentDurations = [];

async function readPlaylist() {
  const text = await readFile(playlistPath, "utf8");
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const segments = lines.filter((l) => !l.startsWith("#"));
  const target = lines.find((l) => l.startsWith("#EXT-X-TARGETDURATION:"))?.split(":")[1] ?? null;
  const sequence = lines.find((l) => l.startsWith("#EXT-X-MEDIA-SEQUENCE:"))?.split(":")[1] ?? null;
  const durations = lines
    .filter((l) => l.startsWith("#EXTINF:"))
    .map((l) => Number.parseFloat(l.slice("#EXTINF:".length)));
  return { segments, target, sequence, durations, live: !text.includes("#EXT-X-ENDLIST") };
}

const exitPromise = new Promise((resolve) => {
  ffmpeg.on("exit", (code, signal) => resolve({ code, signal }));
});

let running = true;
exitPromise.then(() => {
  running = false;
});

while (running) {
  try {
    const info = await readPlaylist();
    playlistSamples += 1;
    if (firstPlaylistMs === null) {
      firstPlaylistMs = Date.now() - startedAt;
      log(
        `playlist appeared after ${firstPlaylistMs} ms (target=${info.target}s, segs=${info.segments.length})`,
      );
    }
    if (info.segments.length > 0 && firstSegmentMs === null) {
      firstSegmentMs = Date.now() - startedAt;
      log(`first segment listed after ${firstSegmentMs} ms: ${info.segments[0]}`);
    }
    maxSegments = Math.max(maxSegments, info.segments.length);
    lastTarget = info.target ?? lastTarget;
    mediaSequence = info.sequence ?? mediaSequence;
    segmentDurations = info.durations;
    if (firstSegmentMs !== null && playlistSamples % 20 === 0) {
      log(
        `live: segs=${info.segments.length} target=${info.target}s seq=${info.sequence} last=${info.segments.at(-1)}`,
      );
    }
  } catch {
    // playlist not written yet
  }
  await sleep(250);
}

const exit = await exitPromise;
const wallSeconds = +((Date.now() - startedAt) / 1000).toFixed(1);

async function httpCheck(url) {
  const res = await fetch(url);
  const body = Buffer.from(await res.arrayBuffer());
  return {
    url,
    status: res.status,
    contentType: res.headers.get("content-type"),
    cacheControl: res.headers.get("cache-control"),
    bytes: body.length,
  };
}

const playlistHttp = await httpCheck("http://127.0.0.1:8081/hls/stream.m3u8").catch((e) => ({
  error: e.message,
}));
let segmentHttp = null;
let finalPlaylist = null;
try {
  finalPlaylist = await readPlaylist();
  const last = finalPlaylist.segments.at(-1);
  if (last)
    segmentHttp = await httpCheck(`http://127.0.0.1:8081/hls/${last}`).catch((e) => ({
      error: e.message,
    }));
} catch (error) {
  log(`final playlist read failed: ${error.message}`);
}

let segmentFiles = [];
try {
  segmentFiles = (await readdir(outDir)).filter((f) => f.endsWith(".ts"));
} catch {
  // ignore
}

const segmentSizes = await Promise.all(
  segmentFiles.map(async (f) => {
    try {
      return (await stat(path.join(outDir, f))).size;
    } catch {
      return 0;
    }
  }),
);

const result = {
  at: new Date().toISOString(),
  platform: process.platform,
  input,
  inputSeconds,
  requestedSeconds: seconds,
  streamLoop: loopsForever,
  wallSeconds,
  firstPlaylistMs,
  firstSegmentMs,
  playlistSamples,
  maxSegmentsInList: maxSegments,
  targetDuration: lastTarget,
  lastMediaSequence: mediaSequence,
  segmentDurations,
  segmentFilesOnDisk: segmentFiles.length,
  segmentSizeBytes: segmentSizes.length
    ? { min: Math.min(...segmentSizes), max: Math.max(...segmentSizes) }
    : null,
  exit,
  ffmpegStderr: ffmpegErr.trim().slice(0, 2000),
  http: { playlist: playlistHttp, segment: segmentHttp },
  finalPlaylist: finalPlaylist
    ? {
        segments: finalPlaylist.segments.length,
        target: finalPlaylist.target,
        live: finalPlaylist.live,
      }
    : null,
};

await writeFile(resultPath, JSON.stringify(result, null, 2));
log(`result written to ${resultPath}`);
console.log(JSON.stringify(result, null, 2));
