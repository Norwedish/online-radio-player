#!/usr/bin/env node
/**
 * M0.8 spike — the apps/api side: the single SQLite writer.
 *
 * Usage: node packages/db/scripts/spike-writer.mjs <db> <seconds> <writes-per-second> [backup-copy]
 * Prints one JSON summary line on stdout (type: "summary").
 *
 * better-sqlite3 notes (verified on this build):
 *   - writes use Statement#run(), reads use get()/all()
 *   - `PRAGMA journal_mode = WAL` needs the `=`; `PRAGMA journal_mode WAL` is a syntax error
 *   - db.backup() is asynchronous and must be awaited
 */
import Database from "better-sqlite3";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

const [dbPath, secondsArg, rateArg, backupArg] = process.argv.slice(2);
const seconds = Number(secondsArg ?? 30);
const rate = Number(rateArg ?? 50);
const backupPath = backupArg ?? path.join(path.dirname(dbPath), "wal-backup-copy.db");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const suffix of ["", "-wal", "-shm", "-journal"]) {
  try {
    await unlink(dbPath + suffix);
  } catch {
    // ignore
  }
}
try {
  await unlink(backupPath);
} catch {
  // ignore
}
await mkdir(path.dirname(dbPath), { recursive: true });

const syntaxLog = [];
const db = new Database(dbPath);

let journalMode = null;
try {
  db.exec("PRAGMA journal_mode = WAL;");
  journalMode = db.prepare("PRAGMA journal_mode;").get()?.journal_mode ?? null;
} catch (error) {
  syntaxLog.push(`WAL pragma => THREW ${error.code} ${error.message}`);
}

db.exec(`
  CREATE TABLE play_history(
    id INTEGER PRIMARY KEY,
    station_id TEXT NOT NULL,
    media_id INTEGER,
    plan_id INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    source TEXT CHECK(source IN ('automation','live','event','request','manual')),
    listeners_peak INTEGER,
    created_at INTEGER
  );
  CREATE INDEX idx_play_history_recent ON play_history(station_id, started_at);
`);

const insert = db.prepare(
  "INSERT INTO play_history (station_id, media_id, plan_id, started_at, ended_at, source, listeners_peak, created_at) " +
    "VALUES (:station_id, :media_id, :plan_id, :started_at, :ended_at, :source, :listeners_peak, :created_at);",
);
const countQuery = db.prepare(
  "SELECT COUNT(1) AS rows, MAX(started_at) AS newest FROM play_history;",
);

const isBusy = (error) =>
  String(error?.code ?? "") === "SQLITE_BUSY" || String(error?.code ?? "") === "SQLITE_LOCKED";

const total = seconds * rate;
let attempts = 0;
let busyRetries = 0;
let failures = 0;
let maxWriteMs = 0;
let totalWriteMs = 0;
let lastStartedAt = null;
let backupResult = null;
let walMaxBytes = 0;
let walBytesAtEnd = null;

const startedAt = Date.now();
const walFile = `${dbPath}-wal`;
const base = 1_700_000_000;

for (let n = 0; n < total; n += 1) {
  const tick = Date.now();
  let stored = false;
  while (!stored) {
    attempts += 1;
    try {
      insert.run({
        station_id: "studio-one",
        media_id: (n % 500) + 1,
        plan_id: (n % 24) + 1,
        started_at: base + n,
        ended_at: base + n + 200,
        source: n % 17 === 0 ? "request" : "automation",
        listeners_peak: n % 90,
        created_at: base + n,
      });
      lastStartedAt = base + n;
      stored = true;
    } catch (error) {
      if (!isBusy(error)) throw error;
      busyRetries += 1;
      if (busyRetries > 200) {
        failures += 1;
        stored = true;
      } else {
        await sleep(10);
      }
    }
  }

  const elapsed = Date.now() - tick;
  totalWriteMs += elapsed;
  maxWriteMs = Math.max(maxWriteMs, elapsed);

  if (n === Math.floor(total / 2)) {
    try {
      await db.backup(backupPath);
      const copy = new Database(backupPath, { readonly: true });
      const seen = copy
        .prepare("SELECT COUNT(1) AS rows, MAX(started_at) AS newest FROM play_history;")
        .get();
      copy.close();
      backupResult = {
        ok: true,
        rowsAtBackup: seen?.rows ?? null,
        newestAtBackup: seen?.newest ?? null,
      };
    } catch (error) {
      backupResult = { ok: false, error: `${error.code} ${error.message}`.trim() };
    }
  }

  if (n % rate === 0) {
    try {
      walBytesAtEnd = (await stat(walFile)).size;
      walMaxBytes = Math.max(walMaxBytes, walBytesAtEnd);
    } catch {
      walBytesAtEnd = 0;
    }
    if (n > 0 && n % (rate * 5) === 0) {
      process.stdout.write(
        `[wal] progress ${n}/${total} busyRetries=${busyRetries} wal=${Math.round((walBytesAtEnd ?? 0) / 1024)}kb\n`,
      );
    }
  }

  const target = startedAt + ((n + 1) / rate) * 1000;
  const wait = target - Date.now();
  if (wait > 0) await sleep(wait);
}

const wallMs = Date.now() - startedAt;
const final = countQuery.get();

console.log(
  JSON.stringify({
    type: "summary",
    requestedSeconds: seconds,
    writesPerSecond: rate,
    journalMode,
    syntaxLog,
    attempts,
    busyRetries,
    failures,
    insertsPerSecond: +((attempts / wallMs) * 1000).toFixed(1),
    avgWriteMs: +(totalWriteMs / Math.max(1, attempts)).toFixed(3),
    maxWriteMs,
    wallMs,
    finalRows: final?.rows ?? null,
    lastStartedAt,
    backup: backupResult,
    walMaxBytes,
    walBytesAtEnd,
  }),
);

db.close();
