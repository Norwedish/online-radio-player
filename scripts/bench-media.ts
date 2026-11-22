/**
 * M2 acceptance benchmark: scan 1,000 files (< 60 s) and query 10k rows (< 100 ms).
 * Usage: pnpm bench:media [files=1000]
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadRuntimeConfig } from "../packages/shared/src/index.ts";
import {
  createRepositories,
  openDatabase,
  runMigrations,
  seedDatabase,
} from "../packages/db/src/index.ts";
import { scanLibrary } from "../apps/api/src/services/media/scanner.ts";

const count = Number(process.argv[2] ?? 1000);
const dir = mkdtempSync(join(tmpdir(), "radio-bench-"));
const config = loadRuntimeConfig({
  env: { NODE_ENV: "test", DATA_DIR: dir, RADIO_SECRETS: join(dir, "x") },
});
const root = config.media.root;
const seeds: string[] = [];
mkdirSync(join(root, "seed"), { recursive: true });
for (let i = 0; i < 20; i += 1) {
  const f = join(root, "seed", `s${i}.mp3`);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=f=${200 + i * 37}:d=${30 + i}`,
    "-ac",
    "2",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    "-metadata",
    `artist=Artist ${i}`,
    "-metadata",
    `title=Seed ${i}`,
    f,
  ]);
  seeds.push(f);
}
for (let i = 0; i < count - seeds.length; i += 1) {
  const decade = `${(i % 10) * 10}`.padStart(2, "0") + "s";
  mkdirSync(join(root, decade), { recursive: true });
  copyFileSync(seeds[i % seeds.length]!, join(root, decade, `Artist ${i % 300} - Track ${i}.mp3`));
}
runMigrations(config.db.file);
const db = openDatabase(config.db.file);
await seedDatabase(db);
const repos = createRepositories(db);
const t0 = Date.now();
const report = await scanLibrary(repos, config);
const scanMs = Date.now() - t0;
console.log(
  `scan: ${report.files} files in ${(scanMs / 1000).toFixed(2)} s (created ${report.created}, errors ${report.errors.length})`,
);

const ins = db.prepare(
  "INSERT INTO media (station_id, path, title, artist, album, duration, status, tags_json, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, 'ok', '{}', '', '')",
);
db.transaction(() => {
  for (let i = 0; i < 10_000; i += 1)
    ins.run(
      `/bench/${i}.mp3`,
      `Title ${i}`,
      `Band ${i % 700}`,
      `Album ${i % 1200}`,
      120 + (i % 240),
    );
})();
const queries = [
  { q: "Band 42" },
  { artist: "Band 1", maxDuration: 200 },
  { sort: "duration" as const, order: "desc" as const, limit: 100 },
  { duplicates: true },
];
for (const q of queries) {
  const t = performance.now();
  const r = repos.media.search(q);
  console.log(
    `query ${JSON.stringify(q)} → ${r.total} rows in ${(performance.now() - t).toFixed(1)} ms`,
  );
}
db.close();
rmSync(dir, { recursive: true, force: true });
if (scanMs > 60_000) process.exit(1);
