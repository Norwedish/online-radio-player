/**
 * Self-contained demo/E2E stack: generates a small tagged library (hour
 * playlists, news, jingles, emergency loop), seeds an admin, starts a local
 * Icecast (when installed), the playout worker and the API serving the built
 * web UI. Runs until interrupted.
 *
 *   pnpm demo            # http://127.0.0.1:3301  (admin / demo-password-123)
 *   DEMO_PORT=4000 pnpm demo
 */
import { execFileSync } from "node:child_process";
import { chmodSync, createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRuntimeConfig } from "../packages/shared/src/index.ts";
import {
  createRepositories,
  openDatabase,
  runMigrations,
  seedDatabase,
} from "../packages/db/src/index.ts";
import { scanLibrary } from "../apps/api/src/services/media/scanner.ts";
import { createContext } from "../apps/api/src/context.ts";
import { buildServer } from "../apps/api/src/server.ts";
import { startJobs } from "../apps/api/src/jobs.ts";
import { PlayoutWorker } from "../apps/playout/src/worker.ts";
import {
  ADMIN_PASSWORD,
  SOURCE_PASSWORD,
  TestIcecast,
  freePort,
  icecastBinary,
} from "../tests/integration/helpers.ts";

const port = Number(process.env.DEMO_PORT ?? 3301);
const dir = process.env.DEMO_DIR ?? mkdtempSync(join(tmpdir(), "radio-demo-"));
mkdirSync(dir, { recursive: true });
chmodSync(dir, 0o755);
const log = (m: string) => console.log(`[demo] ${m}`);

const ARTISTS = [
  "Amber Coast",
  "The Night Shift",
  "Velvet Static",
  "Northbound",
  "Lumen",
  "Paper Kites Club",
  "Juno Avenue",
  "Harbour Lights",
  "Glass Arcade",
  "Mira Sol",
  "Low Orbit",
  "Cassette Club",
];
const WORDS = [
  "Midnight",
  "Signal",
  "Golden",
  "Echoes",
  "Satellite",
  "Summer",
  "Static",
  "Neon",
  "Horizon",
  "Weather",
  "Radio",
  "Afterglow",
  "Wavelength",
  "Coastline",
  "Daylight",
];

function tone(
  path: string,
  seconds: number,
  freq: number,
  title: string,
  artist: string,
  album?: string,
): void {
  if (existsSync(path)) return;
  mkdirSync(join(path, ".."), { recursive: true });
  const amp = 0.25;
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `aevalsrc=${amp}*sin(2*PI*${freq}*t)*(0.6+0.4*sin(2*PI*0.5*t))|${amp}*sin(2*PI*${freq * 1.5}*t)*(0.6+0.4*sin(2*PI*0.5*t)):s=48000:d=${seconds}`,
    "-c:a",
    "libmp3lame",
    "-b:a",
    "96k",
    "-metadata",
    `title=${title}`,
    "-metadata",
    `artist=${artist}`,
    ...(album ? ["-metadata", `album=${album}`] : []),
    path,
  ]);
}

const env = {
  ...process.env,
  NODE_ENV: "development",
  DATA_DIR: dir,
  RADIO_SECRETS: join(dir, "none"),
  HLS_ENABLED: "1",
  STEREOTOOL_MOCK: "1",
  PORT: String(port),
  STATION_NAME: process.env.STATION_NAME ?? "Harbour FM",
};
const config = loadRuntimeConfig({ env });
const icePort = await freePort();
config.icecast.port = icePort;
process.env.DEMO_SOURCE_PW = SOURCE_PASSWORD;
process.env.DEMO_ADMIN_PW = ADMIN_PASSWORD;
config.icecast.sourcePasswordEnv = "DEMO_SOURCE_PW";
config.icecast.adminPasswordEnv = "DEMO_ADMIN_PW";
config.worker.protocolPort = await freePort();
config.apiPort = port;
const livePort = await freePort();
process.env.PLAYOUT_LIVE_PORT = String(livePort);

log(`data dir ${dir}`);
const root = config.media.root;
// 48 tracks from 24 artists in General: every [PM] hour falls back to General when its own playlist is empty.
const TRACKS = Number(process.env.DEMO_TRACKS ?? 48);
for (let i = 0; i < TRACKS; i += 1) {
  const artist = `${ARTISTS[i % ARTISTS.length]}${i >= 24 ? "" : ""}${i % 24 >= 12 ? " Trio" : ""}`;
  const title = `${WORDS[(i * 7) % WORDS.length]} ${WORDS[(i * 5 + 3) % WORDS.length]}`;
  tone(
    join(root, "General", `${artist} - ${title}.mp3`),
    150 + ((i * 37) % 120),
    180 + (i % 24) * 22,
    title,
    artist,
    `${WORDS[i % WORDS.length]} Sessions`,
  );
}
tone(join(root, "Nieuws", "nieuws-heel-uur.mp3"), 120, 880, "Nieuws heel uur", "Newsroom");
tone(join(root, "Nieuws", "nieuws-half-uur.mp3"), 60, 990, "Nieuws half uur", "Newsroom");
for (const [i, t] of [
  "Station ID",
  "Sweeper: more music",
  "Weather bed",
  "Traffic sting",
].entries())
  tone(join(root, "Jingles", `${t}.mp3`), 6 + i * 2, 600 + i * 120, t, "Harbour FM");
tone(join(root, "Emergency", "emergency-loop.mp3"), 30, 440, "Emergency loop", "Harbour FM");

if (process.env.DEMO_FRESH_DB === "1")
  for (const f of [config.db.file, `${config.db.file}-wal`, `${config.db.file}-shm`])
    rmSync(f, { force: true });
runMigrations(config.db.file);
const db = openDatabase(config.db.file);
await seedDatabase(db, {
  stationName: config.station.name,
  timezone: config.station.timezone,
  admin: { username: "admin", password: "demo-password-123", email: "admin@example.org" },
});
const repos = createRepositories(db);
if (!repos.users.findByLogin("dj")) {
  const { hashPassword } = await import("../packages/db/src/index.ts");
  repos.users.create({
    username: "dj",
    email: "dj@example.org",
    role: "dj",
    passwordHash: await hashPassword("demo-password-123"),
  });
  repos.users.create({
    username: "operator",
    email: "op@example.org",
    role: "operator",
    passwordHash: await hashPassword("demo-password-123"),
  });
}
const scan = await scanLibrary(repos, config);
// A small demo library needs gentler separation than a real one.
repos.schedule.setSetting("generator", {
  ...repos.schedule.getSetting("generator", {}),
  separation_track_hours: 1.5,
  separation_artist_hours: 0.25,
});
log(`scanned ${scan.files} files`);
db.close();

let icecast: TestIcecast | null = null;
if (icecastBinary()) {
  icecast = new TestIcecast(join(dir, "icecast"), config);
  await icecast.start();
  log(`icecast on :${icePort}`);
}

const ctx = await createContext(config, {
  log,
  workerEndpoint: { port: config.worker.protocolPort },
});
// Plans for the rest of today and tomorrow (the on-air hour is generated as "catch-up" before the worker starts).
const nowHour = new Date().getHours();
ctx.generator.generate({
  runType: "demo",
  force: true,
  hours: Array.from({ length: 24 }, (_, h) => h).filter((h) => h !== nowHour),
});
ctx.generator.generate({
  runType: "demo",
  force: true,
  hours: [nowHour],
  nowMs: Date.now() - 3_600_000 * 2,
});
const worker = new PlayoutWorker(config, {
  endpoint: { port: config.worker.protocolPort },
  livePort,
  log: (m) => (/meter|heartbeat/.test(m) ? null : console.log(`[playout] ${m}`)),
  outputs: Boolean(icecast),
});
await worker.start();
const app = await buildServer(ctx);
// Dev convenience: proxy streams/HLS/live uplink like nginx does in production.
app.get("/stream/*", async (req, reply) => {
  const res = await fetch(`http://127.0.0.1:${icePort}/${(req.params as { "*": string })["*"]}`);
  reply
    .header("content-type", res.headers.get("content-type") ?? "audio/mpeg")
    .header("cache-control", "no-store");
  return reply.send(res.body);
});
app.get("/hls/:file", async (req, reply) => {
  const file = (req.params as { file: string }).file;
  if (!/^[\w.-]+\.(m3u8|ts)$/.test(file) || !existsSync(join(config.hlsDir, file)))
    return reply.status(404).send();
  reply
    .header("content-type", file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t")
    .header("cache-control", file.endsWith(".m3u8") ? "no-store" : "max-age=60");
  return reply.send(createReadStream(join(config.hlsDir, file)));
});
ctx.worker.start();
ctx.sync.start();
const stopJobs = startJobs(ctx);
await app.listen({ port, host: "127.0.0.1" });
log(
  `ready: http://127.0.0.1:${port}/listen  ·  /admin (admin / demo-password-123)  ·  live uplink ws on :${livePort}`,
);
process.env.DEMO_LIVE_PORT = String(livePort);

const shutdown = async () => {
  stopJobs();
  await app.close();
  await worker.stop();
  await ctx.close();
  await icecast?.stop();
  if (!process.env.DEMO_DIR) rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
