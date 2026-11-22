#!/usr/bin/env node
/**
 * M0.7 spike: browser -> server audio uplink over WebSocket PCM.
 *
 * Serves a test page (8090) that generates a tone in an AudioContext, packs
 * 1024-sample Int16 frames with a client timestamp, and streams them over
 * WebSocket. The server measures one-way arrival latency (same machine, so the
 * clocks are comparable), jitter, sequence gaps and throughput.
 *
 * Usage: node scripts/spike-live-ws.mjs [seconds]
 * Writes data/spike/live/ws-result.json.
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";

const seconds = Number(process.argv[2] ?? 20);
const port = 8090;
const resultPath = path.resolve("data/spike/live/ws-result.json");

await mkdir(path.dirname(resultPath), { recursive: true });

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>M0.7 WebSocket PCM uplink</title>
<style>
  body { background: #111; color: #eee; font-family: ui-monospace, monospace; padding: 16px; }
  #log { white-space: pre-wrap; font-size: 12px; margin-top: 12px; }
  button { padding: 8px 16px; }
</style>
</head>
<body>
<h1>M0.7 WebSocket PCM uplink</h1>
<button id="start">Start uplink</button>
<div id="log"></div>
<script>
  const log = (...a) => {
    document.getElementById('log').textContent += a.join(' ') + '\\n';
    console.log(a.join(' '));
  };
  let started = false;
  document.getElementById('start').onclick = async () => {
    if (started) return;
    started = true;
    const ctx = new AudioContext({ sampleRate: 48000 });
    await ctx.resume();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const proc = ctx.createScriptProcessor(1024, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    osc.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    osc.start();

    const ws = new WebSocket('ws://' + location.host + '/ws');
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => log('ws open rate=' + ctx.sampleRate);
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'stats') log('stats', JSON.stringify(m));
        if (m.type === 'done') log('done', JSON.stringify(m));
      } catch {}
    };
    let seq = 0;
    proc.onaudioprocess = (e) => {
      if (ws.readyState !== 1) return;
      const ch = e.inputBuffer.getChannelData(0);
      const buf = new ArrayBuffer(12 + ch.length * 2);
      const view = new DataView(buf);
      view.setUint32(0, seq++, true);
      view.setFloat64(4, performance.timeOrigin + performance.now(), true);
      for (let i = 0; i < ch.length; i++) {
        const v = Math.max(-1, Math.min(1, ch[i]));
        view.setInt16(12 + i * 2, v * 0x7fff, true);
      }
      ws.send(buf);
    };
  };
</script>
</body>
</html>`;

const server = createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

const wss = new WebSocketServer({ server, path: "/ws" });

let samples = [];
let bytes = 0;
let frames = 0;
let seqGaps = 0;
let lastSeq = null;
let firstAt = null;
let lastAt = null;
let finishTimer = null;
let connectionCount = 0;
let finished = false;

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];

function statsPayload(final = false) {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((s, v) => s + v, 0) / Math.max(1, samples.length);
  const jitter =
    samples.length > 1
      ? Math.sqrt(samples.reduce((s, v) => s + (v - avg) ** 2, 0) / samples.length)
      : 0;
  return {
    type: final ? "done" : "stats",
    frames,
    seconds: firstAt ? +((lastAt - firstAt) / 1000).toFixed(1) : 0,
    avgMs: +avg.toFixed(2),
    p50Ms: +percentile(sorted, 0.5).toFixed(2),
    p95Ms: +percentile(sorted, 0.95).toFixed(2),
    maxMs: +percentile(sorted, 1).toFixed(2),
    jitterMs: +jitter.toFixed(2),
    seqGaps,
    kbps: firstAt ? +((bytes * 8) / Math.max(1, lastAt - firstAt) / 1).toFixed(1) : 0,
    bytes,
  };
}

function finish() {
  if (finished) return;
  finished = true;
  const payload = statsPayload(true);
  const result = {
    at: new Date().toISOString(),
    platform: process.platform,
    seconds,
    connections: connectionCount,
    ...payload,
    type: undefined,
  };
  const cpu = process.cpuUsage();
  result.cpuSeconds = +((cpu.user + cpu.system) / 1e6).toFixed(3);
  writeFile(resultPath, JSON.stringify(result, null, 2))
    .then(() => {
      console.log("[ws] result written to", resultPath);
      console.log(JSON.stringify(result, null, 2));
    })
    .finally(() => {
      for (const client of wss.clients) {
        try {
          client.send(JSON.stringify({ type: "done", ...payload }));
        } catch {
          // ignore
        }
      }
      setTimeout(() => {
        try {
          for (const client of wss.clients) client.terminate();
        } catch {
          // ignore
        }
        server.close();
        process.exit(0);
      }, 300);
    });
}

wss.on("connection", (ws) => {
  connectionCount += 1;
  console.log(`[ws] client connected (${connectionCount})`);
  if (!finishTimer) {
    finishTimer = setTimeout(finish, seconds * 1000);
  }
  const interval = setInterval(() => {
    if (samples.length > 0) {
      try {
        ws.send(JSON.stringify(statsPayload(false)));
      } catch {
        // ignore
      }
    }
  }, 1000);

  ws.on("message", (data, isBinary) => {
    if (!isBinary || data.length < 12) return;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const seq = view.getUint32(0, true);
    const clientTs = view.getFloat64(4, true);
    const now = Date.now();
    const latency = now - clientTs;
    if (latency >= 0 && latency < 60_000) {
      samples.push(latency);
    }
    bytes += data.length;
    frames += 1;
    if (lastSeq !== null && seq !== lastSeq + 1) {
      seqGaps += seq > lastSeq + 1 ? seq - lastSeq - 1 : 0;
    }
    lastSeq = seq;
    if (firstAt === null) firstAt = now;
    lastAt = now;
  });

  ws.on("close", () => clearInterval(interval));
});

server.listen(port, () => {
  console.log(`[ws] listening on http://127.0.0.1:${port}/ (${seconds}s test)`);
  console.log("[ws] open the page in a browser and click Start uplink");
});
