/**
 * M5.5 benchmark: run the full playout chain (4 mounts + HLS + Stereo Tool
 * mock process) against a local Icecast for N seconds and report CPU per
 * process (Linux /proc) and RSS. Usage: pnpm bench:chain [seconds=60]
 */
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfig } from "../packages/shared/src/index.ts";
import { PlayoutWorker } from "../apps/playout/src/worker.ts";
import { FakePlanSource, item, tone } from "../apps/playout/src/test-utils.ts";
import { SOURCE_PASSWORD, TestIcecast, freePort } from "../tests/integration/helpers.ts";

const seconds = Number(process.argv[2] ?? 60);
const HZ = 100;

function procTimes(): Map<number, { name: string; ticks: number; rssKb: number }> {
  const out = new Map<number, { name: string; ticks: number; rssKb: number }>();
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(f[11]) + Number(f[12]);
      const rss = Number(f[21]) * 4;
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      const label =
        name === "ffmpeg"
          ? `ffmpeg ${cmd.includes("hls") ? "hls" : (cmd.match(/\/([a-z]+\.(mp3|ogg|aac))/)?.[1] ?? (cmd.includes("pipe:1") ? "decode" : "?"))}`
          : name === "node" && cmd.includes("mock-stereotool")
            ? "stereotool(mock)"
            : name;
      out.set(Number(pid), { name: label, ticks, rssKb: rss });
    } catch {
      // process gone
    }
  }
  return out;
}

const dir = mkdtempSync(join(tmpdir(), "radio-bench-"));
chmodSync(dir, 0o755);
const port = await freePort();
const config = loadRuntimeConfig({
  env: {
    NODE_ENV: "test",
    DATA_DIR: dir,
    RADIO_SECRETS: join(dir, "x"),
    ICECAST_PORT: String(port),
    HLS_ENABLED: "1",
    STEREOTOOL_MOCK: "1",
  },
});
process.env.BENCH_SOURCE_PW = SOURCE_PASSWORD;
config.icecast.sourcePasswordEnv = "BENCH_SOURCE_PW";
config.icecast.port = port;
const icecast = new TestIcecast(join(dir, "icecast"), config);
await icecast.start();
const source = new FakePlanSource("UTC");
const files = Array.from({ length: 4 }, (_, i) =>
  tone(join(dir, "m"), `t${i}`, 30, 220 + i * 110, 0.3),
);
source.fillers = files.map((f, i) => item(f, 30, { title: `T${i}` }));
const worker = new PlayoutWorker(config, {
  source,
  endpoint: { port: await freePort() },
  livePort: await freePort(),
  log: () => {},
});
await worker.start();
await icecast.waitForMounts(["hq.mp3", "mobile.mp3", "opus.ogg", "aac.aac"]);
await new Promise((r) => setTimeout(r, 2000));

const before = procTimes();
const t0 = Date.now();
const rss0 = process.memoryUsage().rss;
await new Promise((r) => setTimeout(r, seconds * 1000));
const wall = (Date.now() - t0) / 1000;
const after = procTimes();
const rows: { process: string; cpuPct: number; rssMb: number }[] = [];
let total = 0;
for (const [pid, a] of after) {
  const b = before.get(pid);
  if (!b) continue;
  const pct = ((a.ticks - b.ticks) / HZ / wall) * 100;
  if (
    pct < 0.05 &&
    !["node", "icecast2"].includes(a.name) &&
    !a.name.startsWith("ffmpeg") &&
    !a.name.startsWith("stereo")
  )
    continue;
  if (!(
    a.name.startsWith("ffmpeg") ||
    a.name.startsWith("stereo") ||
    a.name === "icecast2" ||
    pid === process.pid
  ))
    continue;
  rows.push({
    process: pid === process.pid ? "radio-playout (node)" : a.name,
    cpuPct: Math.round(pct * 10) / 10,
    rssMb: Math.round(a.rssKb / 102.4) / 10,
  });
  total += pct;
}
rows.sort((x, y) => y.cpuPct - x.cpuPct);
console.table(rows);
console.log(
  `total ${total.toFixed(1)}% of one core = ${(total / cpus().length).toFixed(1)}% of ${cpus().length} vCPU over ${wall.toFixed(0)} s; node RSS ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB (start ${(rss0 / 1048576).toFixed(0)} MB); clock stalls ${worker.clock.stalls}; deck underruns ${worker.engine.current?.deck.underruns ?? 0}`,
);
console.log(
  `encoders: ${JSON.stringify(worker.hub.statuses().map((s) => ({ m: s.mount, up: s.running, r: s.restarts, q: s.queuedMs })))}`,
);
await worker.stop();
await icecast.stop();
rmSync(dir, { recursive: true, force: true });
process.exit(0);
