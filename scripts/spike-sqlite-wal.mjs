#!/usr/bin/env node
/**
 * M0.8 spike — SQLite WAL concurrency for the deployment model:
 *   one writer (apps/api) + continuous readers (apps/playout, stats poller)
 * against a single SQLite file, plus a `db.backup()` taken mid-load.
 *
 * Usage: node scripts/spike-sqlite-wal.mjs [seconds] [writes-per-second]
 *
 * Writes data/spike/sqlite/spike-result.json and prints a summary table.
 * Exits non-zero if writes failed, the backup failed, or readers never saw rows.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const seconds = Number(process.argv[2] ?? 30);
const rate = Number(process.argv[3] ?? 50);
const dir = path.resolve("data/spike/sqlite");
const dbPath = path.join(dir, "wal.db");
const backupPath = path.join(dir, "wal-backup-copy.db");
const resultPath = path.join(dir, "spike-result.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log("[wal]", ...args);

await mkdir(dir, { recursive: true });

function spawnChild(name, script, args) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: path.resolve("."),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { name, child, stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    state.stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    state.stderr += String(chunk);
  });
  return state;
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, signal: "TIMEOUT" });
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function summaryOf(stdout) {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((x) => x && x.type === "summary")
    .pop();
  return line ?? null;
}

log(`db=${path.relative(process.cwd(), dbPath)} seconds=${seconds} writes/s=${rate}`);

const writer = spawnChild("writer", path.resolve("packages/db/scripts/spike-writer.mjs"), [
  dbPath,
  String(seconds),
  String(rate),
  backupPath,
]);

// Give the writer a head start so the schema exists when readers open.
const waitStart = Date.now();
while (Date.now() - waitStart < 10_000) {
  try {
    const info = await stat(dbPath);
    if (info.size > 0) break;
  } catch {
    // not created yet
  }
  await sleep(100);
}
log("database file exists; starting readers");

const readers = [
  spawnChild("playout-worker", path.resolve("packages/db/scripts/spike-reader.mjs"), [
    dbPath,
    String(seconds),
    "playout-worker",
  ]),
  spawnChild("stats-poller", path.resolve("packages/db/scripts/spike-reader.mjs"), [
    dbPath,
    String(seconds),
    "stats-poller",
  ]),
];

const timeoutMs = (seconds + 30) * 1000;
const [writerExit, ...readerExits] = await Promise.all([
  waitExit(writer.child, timeoutMs),
  ...readers.map((r) => waitExit(r.child, timeoutMs)),
]);

await sleep(300);

const writerSummary = summaryOf(writer.stdout);
const readerSummaries = readers.map((r) => summaryOf(r.stdout)).filter(Boolean);

if (!writerSummary) {
  log("writer stderr:", writer.stderr.trim());
  log("writer stdout:", writer.stdout.trim());
  throw new Error("writer produced no summary line");
}

const busyTotal =
  (writerSummary.busyRetries ?? 0) +
  readerSummaries.reduce((sum, r) => sum + (r.busyRetries ?? 0), 0);
const backupOk = writerSummary.backup?.ok === true;
const readersSawRows =
  readerSummaries.length > 0 && readerSummaries.every((r) => (r.maxRows ?? 0) > 0);
const readersFresh = readerSummaries.every(
  (r) => (r.maxRows ?? 0) >= Math.max(0, (writerSummary.finalRows ?? 0) - rate),
);

let walBytesAtRest = null;
try {
  walBytesAtRest = (await stat(`${dbPath}-wal`)).size;
} catch {
  walBytesAtRest = 0;
}

const result = {
  at: new Date().toISOString(),
  platform: process.platform,
  seconds,
  writesPerSecond: rate,
  db: path.basename(dbPath),
  writer: {
    journalMode: writerSummary.journalMode,
    attempts: writerSummary.attempts,
    busyRetries: writerSummary.busyRetries,
    failures: writerSummary.failures,
    insertsPerSecond: writerSummary.insertsPerSecond,
    avgWriteMs: writerSummary.avgWriteMs,
    maxWriteMs: writerSummary.maxWriteMs,
    finalRows: writerSummary.finalRows,
    lastStartedAt: writerSummary.lastStartedAt,
    backup: writerSummary.backup,
    walMaxBytes: writerSummary.walMaxBytes,
    syntaxLog: writerSummary.syntaxLog,
  },
  readers: readerSummaries.map((r) => ({
    label: r.label,
    openMode: r.openMode,
    openError: r.openError,
    reads: r.reads,
    busyRetries: r.busyRetries,
    failures: r.failures,
    maxReadMs: r.maxReadMs,
    firstRows: r.firstRows,
    maxRows: r.maxRows,
    maxNewest: r.maxNewest,
    rowsAdvanced: r.rowsAdvanced,
  })),
  walBytesAtRest,
  exits: {
    writer: writerExit.code ?? writerExit.signal,
    readers: readerExits.map((e) => e.code ?? e.signal),
  },
  verdict: {
    sqliteBusyRetries: busyTotal,
    backupWorked: backupOk,
    readersSawRows,
    readersFresh,
    writerFailures: writerSummary.failures,
  },
};

const ok =
  writerExit.code === 0 &&
  readerExits.every((e) => e.code === 0) &&
  writerSummary.failures === 0 &&
  readerSummaries.every((r) => r.failures === 0) &&
  backupOk &&
  readersSawRows &&
  readersFresh &&
  writerSummary.journalMode === "wal";

await writeFile(resultPath, JSON.stringify(result, null, 2));

log(`journal_mode=${writerSummary.journalMode}`);
log(
  `writer: ${writerSummary.attempts} attempts, ${writerSummary.busyRetries} busy retries, ` +
    `${writerSummary.failures} failures, ${writerSummary.insertsPerSecond}/s, max ${writerSummary.maxWriteMs} ms`,
);
for (const r of result.readers) {
  log(
    `${r.label}: mode=${r.openMode} reads=${r.reads} busy=${r.busyRetries} failures=${r.failures} ` +
      `maxRead=${r.maxReadMs}ms rows ${r.firstRows}->${r.maxRows}`,
  );
}
log(
  `backup: ${backupOk ? "ok" : "FAILED"} ` +
    `${writerSummary.backup?.rowsAtBackup ?? "?"} rows at backup; ` +
    `wal max ${Math.round((writerSummary.walMaxBytes ?? 0) / 1024)} kb`,
);
log(`result written to ${resultPath}`);
console.log(JSON.stringify(result, null, 2));

if (!ok) {
  log("verdict: FAIL");
  process.exitCode = 1;
} else {
  log("verdict: PASS");
}

// Surface child stderr only when something went wrong.
if (!ok) {
  for (const handle of [writer, ...readers]) {
    if (handle.stderr.trim()) log(`${handle.name} stderr:\n${handle.stderr.trim()}`);
  }
}

// Keep readFile imported for future artifact checks without tripping lint.
void readFile;
