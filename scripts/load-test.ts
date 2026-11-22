/**
 * Load test (PLAN M14.6): simulated listeners on the Icecast mounts (through nginx),
 * public WebSocket clients and a steady rate of public API calls, while the playout
 * worker keeps running. Pass criteria: API p95 < 200 ms, no API/listener errors,
 * readiness stays "ready" and every listener receives audio at its nominal bitrate.
 *
 *   pnpm load:test --listeners 500 --ws 200 --rps 100 --duration 60
 *   pnpm load:test --api http://127.0.0.1:3001 --streams http://127.0.0.1/stream
 *
 * API calls go straight to the API on loopback with an X-Forwarded-For header per
 * simulated client, exactly as nginx forwards them, so per-IP rate limits behave as
 * in production (one client = one IP). Run it on the station host or next to it.
 */
import { execFileSync } from "node:child_process";

interface Options {
  api: string;
  streams: string;
  listeners: number;
  ws: number;
  rps: number;
  duration: number;
  mounts: string[];
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return (i >= 0 ? argv[i + 1] : undefined) ?? fallback;
  };
  const api = get("api", process.env.API_URL ?? "http://127.0.0.1:3001");
  return {
    api,
    streams: get("streams", process.env.STREAMS_URL ?? "http://127.0.0.1/stream"),
    listeners: Number(get("listeners", "500")),
    ws: Number(get("ws", "200")),
    rps: Number(get("rps", "100")),
    duration: Number(get("duration", "60")),
    mounts: get("mounts", "").split(",").filter(Boolean),
    json: argv.includes("--json"),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeIp = (n: number) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

/** CPU seconds + RSS of the station processes, sampled with ps (Linux). */
function sampleProcesses(): Record<string, { cpu: number; rssMb: number }> {
  const out: Record<string, { cpu: number; rssMb: number }> = {};
  let text = "";
  try {
    text = execFileSync("ps", ["-eo", "rss=,times=,args="], { encoding: "utf8" });
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const args = m[3] ?? "";
    const name = args.includes("apps/api/dist")
      ? "api"
      : args.includes("apps/playout/dist")
        ? "playout"
        : /(^|\/)icecast2?\b/.test(args)
          ? "icecast"
          : /^nginx: worker/.test(args)
            ? "nginx"
            : /(^|\/)ffmpeg\b/.test(args)
              ? "ffmpeg"
              : null;
    if (!name) continue;
    const cur = out[name] ?? { cpu: 0, rssMb: 0 };
    cur.cpu += Number(m[2]);
    cur.rssMb += Number(m[1]) / 1024;
    out[name] = cur;
  }
  return out;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const np = (await (await fetch(`${o.api}/api/public/now-playing`)).json()) as {
    streams?: { mounts?: { mount: string; bitrate: string }[] };
  };
  const mounts = o.mounts.length
    ? o.mounts.map((m) => ({ mount: m, bitrate: 128 }))
    : (np.streams?.mounts ?? [])
        .filter((s) => !s.mount.startsWith("live"))
        .map((s) => ({ mount: s.mount, bitrate: parseInt(s.bitrate, 10) }));
  if (mounts.length === 0) throw new Error("no mounts published; is the station running?");
  const log = (s: string) => o.json || console.log(s);
  log(
    `load test: ${o.listeners} listeners over ${mounts.map((m) => m.mount).join(", ")}, ` +
      `${o.ws} websockets, ${o.rps} req/s, ${o.duration} s`,
  );

  const stop = AbortSignal.timeout(o.duration * 1000);
  const t0 = Date.now();
  const cpu0 = sampleProcesses();

  // Listeners: each holds one HTTP stream and counts bytes.
  const listeners = Array.from({ length: o.listeners }, (_, i) => ({
    mount: mounts[i % mounts.length]!,
    bytes: 0,
    connectedAt: 0,
    error: "" as string,
    ended: false,
  }));
  const listenerTasks = listeners.map(async (l, i) => {
    await sleep((i / o.listeners) * Math.min(10_000, o.duration * 200)); // ramp up
    try {
      const res = await fetch(`${o.streams}/${l.mount.mount}`, {
        signal: stop,
        headers: { "x-forwarded-for": fakeIp(100_000 + i) },
      });
      if (!res.ok || !res.body) {
        l.error = `HTTP ${res.status}`;
        return;
      }
      l.connectedAt = Date.now();
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        l.bytes += value.byteLength;
      }
      l.ended = true; // server closed the stream before the test ended
    } catch (e) {
      if (!stop.aborted) l.error = (e as Error).message;
    }
  });

  // WebSocket clients (public now-playing channel).
  let wsOpen = 0;
  let wsMessages = 0;
  let wsErrors = 0;
  const sockets: WebSocket[] = [];
  const wsUrl = o.api.replace(/^http/, "ws") + "/ws";
  for (let i = 0; i < o.ws; i++) {
    const s = new WebSocket(wsUrl);
    s.onopen = () => wsOpen++;
    s.onmessage = () => wsMessages++;
    s.onerror = () => wsErrors++;
    sockets.push(s);
  }

  // Open-loop public API traffic.
  const endpoints: [string, number][] = [
    ["/api/public/now-playing", 6],
    ["/api/public/schedule", 1],
    ["/api/public/history?limit=20", 1],
    ["/api/public/search?q=song", 1],
  ];
  const weighted = endpoints.flatMap(([p, w]) => Array<string>(w).fill(p));
  const latency = new Map<string, number[]>();
  const apiErrors = new Map<string, number>();
  let sent = 0;
  const inflight: Promise<void>[] = [];
  const clientPool = Math.max(1000, o.rps * 30); // ≤ 2 requests per simulated client per minute
  const apiLoop = (async () => {
    const interval = 1000 / o.rps;
    let next = performance.now();
    while (!stop.aborted) {
      const path = weighted[sent % weighted.length]!;
      const ip = fakeIp(sent % clientPool);
      sent++;
      const started = performance.now();
      inflight.push(
        fetch(o.api + path, { headers: { "x-forwarded-for": ip } })
          .then(async (r) => {
            await r.arrayBuffer();
            const key = path.split("?")[0] ?? path;
            if (!r.ok)
              apiErrors.set(`${key} ${r.status}`, (apiErrors.get(`${key} ${r.status}`) ?? 0) + 1);
            const arr = latency.get(key) ?? [];
            arr.push(performance.now() - started);
            latency.set(key, arr);
          })
          .catch((e: Error) => {
            apiErrors.set(e.message, (apiErrors.get(e.message) ?? 0) + 1);
          }),
      );
      next += interval;
      await sleep(Math.max(0, next - performance.now()));
    }
  })();

  // Readiness / worker health while under load.
  const notReady: string[] = [];
  const healthLoop = (async () => {
    while (!stop.aborted) {
      try {
        const r = (await (await fetch(`${o.api}/api/ready`)).json()) as {
          status: string;
          checks: Record<string, { ok: boolean; detail?: string }>;
        };
        if (r.status !== "ready") {
          const failing = Object.entries(r.checks)
            .filter(([, c]) => !c.ok)
            .map(([k, c]) => `${k}${c.detail ? `(${c.detail})` : ""}`);
          notReady.push(
            `${Math.round((Date.now() - t0) / 1000)}s ${r.status}: ${failing.join(", ")}`,
          );
        }
      } catch (e) {
        notReady.push(`ready probe failed: ${(e as Error).message}`);
      }
      await sleep(5000);
    }
  })();

  await Promise.all([apiLoop, healthLoop]);
  await Promise.allSettled(inflight);
  await Promise.allSettled(listenerTasks);
  for (const s of sockets) s.close();
  const elapsed = (Date.now() - t0) / 1000;
  const cpu1 = sampleProcesses();

  // Results.
  const all = [...latency.values()].flat().sort((a, b) => a - b);
  const perEndpoint = Object.fromEntries(
    [...latency.entries()].map(([k, v]) => {
      const s = [...v].sort((a, b) => a - b);
      return [
        k,
        {
          n: s.length,
          p50: +percentile(s, 50).toFixed(1),
          p95: +percentile(s, 95).toFixed(1),
          p99: +percentile(s, 99).toFixed(1),
        },
      ];
    }),
  );
  const connected = listeners.filter((l) => l.connectedAt > 0);
  const kbps = connected.map(
    (l) => (l.bytes * 8) / 1000 / Math.max(1, (Date.now() - l.connectedAt) / 1000),
  );
  // A listener is "starved" when it got < 90 % of its mount's bitrate (burst-on-connect pushes it above 100 %).
  const starved = connected.filter((l, i) => (kbps[i] ?? 0) < l.mount.bitrate * 0.9).length;
  const processes = Object.fromEntries(
    Object.entries(cpu1).map(([k, v]) => [
      k,
      {
        cpuPct: +(((v.cpu - (cpu0[k]?.cpu ?? 0)) / elapsed) * 100).toFixed(1),
        rssMb: Math.round(v.rssMb),
      },
    ]),
  );
  const listenerErrors = listeners.filter((l) => l.error || l.ended);
  const errorCount = [...apiErrors.values()].reduce((a, b) => a + b, 0);
  const p95 = percentile(all, 95);
  const result = {
    durationSeconds: +elapsed.toFixed(1),
    api: {
      requests: all.length,
      ratePerSecond: +(all.length / elapsed).toFixed(1),
      p50: +percentile(all, 50).toFixed(1),
      p95: +p95.toFixed(1),
      p99: +percentile(all, 99).toFixed(1),
      max: +(all.at(-1) ?? 0).toFixed(1),
      errors: Object.fromEntries(apiErrors),
      perEndpoint,
    },
    listeners: {
      target: o.listeners,
      connected: connected.length,
      failed: listenerErrors.length,
      failures: [...new Set(listenerErrors.map((l) => l.error || "stream ended early"))].slice(
        0,
        5,
      ),
      starved,
      avgKbps: +(kbps.reduce((a, b) => a + b, 0) / Math.max(1, kbps.length)).toFixed(1),
      mbReceived: +(listeners.reduce((a, l) => a + l.bytes, 0) / 1e6).toFixed(1),
    },
    websockets: { target: o.ws, opened: wsOpen, messages: wsMessages, errors: wsErrors },
    readiness: notReady.length ? notReady : "ready throughout",
    processes,
  };
  const pass =
    p95 < 200 &&
    errorCount === 0 &&
    listenerErrors.length === 0 &&
    connected.length === o.listeners &&
    starved === 0 &&
    wsOpen === o.ws &&
    notReady.length === 0;
  if (o.json) console.log(JSON.stringify({ pass, ...result }, null, 2));
  else {
    console.log(JSON.stringify(result, null, 2));
    console.log(pass ? "✅ load test passed (p95 < 200 ms, no errors)" : "❌ load test failed");
  }
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
