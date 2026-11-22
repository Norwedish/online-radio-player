#!/usr/bin/env node
/**
 * M0.8 spike — the apps/playout side: a continuous reader next to the writer.
 *
 * Usage: node packages/db/scripts/spike-reader.mjs <db> <seconds> <label>
 * Prints one JSON summary line on stdout (type: "summary").
 *
 * Opens the database read-only when possible (the real worker never writes) and
 * polls the newest play_history rows, the way the playout worker refreshes state.
 */
import Database from "better-sqlite3";
import { stat } from "node:fs/promises";

const [dbPath, secondsArg, label] = process.argv.slice(2);
const seconds = Number(secondsArg ?? 30);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isBusy = (error) =>
  String(error?.code ?? "") === "SQLITE_BUSY" || String(error?.code ?? "") === "SQLITE_LOCKED";

const startWait = Date.now();
while (Date.now() - startWait < 15_000) {
  try {
    const info = await stat(dbPath);
    if (info.size > 0) break;
  } catch {
    // writer has not created the file yet
  }
  await sleep(100);
}

let db = null;
let openMode = "readonly";
let openError = null;
try {
  db = new Database(dbPath, { readonly: true });
} catch (error) {
  openError = `${error.code} ${error.message}`;
  openMode = "read-write-fallback";
  db = new Database(dbPath);
}

const query = db.prepare("SELECT COUNT(1) AS rows, MAX(started_at) AS newest FROM play_history;");

let reads = 0;
let busyRetries = 0;
let failures = 0;
let maxReadMs = 0;
let totalReadMs = 0;
let firstRows = null;
let maxRows = null;
let maxNewest = null;
let rowsAdvanced = 0;
let lastRows = null;

const deadline = Date.now() + seconds * 1000;

while (Date.now() < deadline) {
  const tick = Date.now();
  let result = null;
  while (!result) {
    reads += 1;
    try {
      result = query.get();
    } catch (error) {
      if (!isBusy(error)) {
        failures += 1;
        break;
      }
      busyRetries += 1;
      await sleep(10);
    }
  }
  if (result) {
    const elapsed = Date.now() - tick;
    totalReadMs += elapsed;
    maxReadMs = Math.max(maxReadMs, elapsed);
    const rows = result.rows ?? 0;
    if (firstRows === null) firstRows = rows;
    if (lastRows !== null && rows > lastRows) rowsAdvanced += 1;
    lastRows = rows;
    maxRows = Math.max(maxRows ?? 0, rows);
    maxNewest = Math.max(maxNewest ?? 0, result.newest ?? 0);
  }
  await sleep(250);
}

console.log(
  JSON.stringify({
    type: "summary",
    label,
    openMode,
    openError,
    reads,
    busyRetries,
    failures,
    maxReadMs,
    avgReadMs: +(totalReadMs / Math.max(1, reads)).toFixed(3),
    firstRows,
    maxRows,
    maxNewest,
    rowsAdvanced,
  }),
);

db.close();
