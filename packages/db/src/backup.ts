/**
 * Backups (PLAN M1.6 / M12.4): online SQLite `.backup` (safe while the API
 * writes — ADR 0005), integrity verification, 14 daily / 8 weekly rotation,
 * and offline restore.
 */
import Database from "better-sqlite3";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

export interface BackupResult {
  path: string;
  size: number;
  integrity: string;
  tables: number;
  weeklyPath: string | null;
  removed: string[];
}

export interface BackupOptions {
  dailyKeep?: number;
  weeklyKeep?: number;
  /** Override "now" (tests). */
  now?: Date;
  prefix?: string;
}

function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function verifyDatabaseFile(file: string): {
  integrity: string;
  tables: number;
  users: number;
  plans: number;
} {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const integrity = String(
      Object.values((db.pragma("integrity_check") as Record<string, unknown>[])[0] ?? {})[0] ??
        "unknown",
    );
    const tables = Number(
      (
        db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table'").get() as {
          n: number;
        }
      ).n,
    );
    const count = (table: string) => {
      try {
        return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
      } catch {
        return 0;
      }
    };
    return { integrity, tables, users: count("users"), plans: count("hourly_plans") };
  } finally {
    db.close();
  }
}

/** Online backup of an open database (or a file path) into `dir`. */
export async function backupDatabase(
  source: Database.Database | string,
  dir: string,
  options: BackupOptions = {},
): Promise<BackupResult> {
  const now = options.now ?? new Date();
  const prefix = options.prefix ?? "radio";
  mkdirSync(dir, { recursive: true });
  const stamp = now
    .toISOString()
    .replace(/[:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const target = resolve(join(dir, `${prefix}-${stamp}.sqlite3`));
  const tmp = `${target}.partial`;

  const db =
    typeof source === "string"
      ? new Database(source, { readonly: true, fileMustExist: true })
      : source;
  try {
    await db.backup(tmp);
  } finally {
    if (typeof source === "string") db.close();
  }
  const check = verifyDatabaseFile(tmp);
  if (check.integrity.toLowerCase() !== "ok") {
    unlinkSync(tmp);
    throw new Error(`backup integrity_check failed: ${check.integrity}`);
  }
  renameSync(tmp, target);

  // One weekly copy per ISO week.
  let weeklyPath: string | null = resolve(join(dir, `${prefix}-weekly-${isoWeek(now)}.sqlite3`));
  if (existsSync(weeklyPath)) weeklyPath = null;
  else copyFileSync(target, weeklyPath);

  const removed = rotateBackups(dir, {
    dailyKeep: options.dailyKeep ?? 14,
    weeklyKeep: options.weeklyKeep ?? 8,
    prefix,
  });
  return {
    path: target,
    size: statSync(target).size,
    integrity: check.integrity,
    tables: check.tables,
    weeklyPath,
    removed,
  };
}

export function listBackupFiles(
  dir: string,
  prefix = "radio",
): { daily: string[]; weekly: string[] } {
  if (!existsSync(dir)) return { daily: [], weekly: [] };
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith(".sqlite3"))
    .sort();
  return {
    weekly: files.filter((f) => f.startsWith(`${prefix}-weekly-`)).map((f) => join(dir, f)),
    daily: files.filter((f) => !f.startsWith(`${prefix}-weekly-`)).map((f) => join(dir, f)),
  };
}

export function rotateBackups(
  dir: string,
  opts: { dailyKeep: number; weeklyKeep: number; prefix?: string },
): string[] {
  const { daily, weekly } = listBackupFiles(dir, opts.prefix);
  const removed: string[] = [];
  // Keep the newest backup per day for `dailyKeep` days.
  const byDay = new Map<string, string[]>();
  for (const file of daily) {
    const day = basename(file).replace(/^.*?-(\d{4}-\d{2}-\d{2}).*$/, "$1");
    byDay.set(day, [...(byDay.get(day) ?? []), file]);
  }
  const days = [...byDay.keys()].sort().reverse();
  days.forEach((day, index) => {
    const files = (byDay.get(day) ?? []).sort();
    const keep = index < opts.dailyKeep ? files.slice(-1) : [];
    for (const f of files) if (!keep.includes(f)) removed.push(f);
  });
  const weeklySorted = [...weekly].sort().reverse();
  removed.push(...weeklySorted.slice(opts.weeklyKeep));
  for (const f of removed) {
    try {
      unlinkSync(f);
    } catch {
      // already gone
    }
  }
  return removed;
}

/**
 * Offline restore: verifies `backupFile`, keeps a safety copy of the current DB
 * (`<db>.pre-restore-<ts>`), then atomically replaces it. Stop radio-api first.
 */
export function restoreDatabase(
  backupFile: string,
  targetFile: string,
): {
  restored: string;
  safetyCopy: string | null;
  integrity: string;
  users: number;
  plans: number;
} {
  const src = resolve(backupFile);
  const target = resolve(targetFile);
  const check = verifyDatabaseFile(src);
  if (check.integrity.toLowerCase() !== "ok")
    throw new Error(`backup ${src} failed integrity_check: ${check.integrity}`);
  let safetyCopy: string | null = null;
  if (existsSync(target)) {
    // Checkpoint the WAL so the safety copy is complete.
    try {
      const live = new Database(target);
      live.pragma("wal_checkpoint(TRUNCATE)");
      live.close();
    } catch {
      // ignore: the file may be locked or not WAL
    }
    safetyCopy = `${target}.pre-restore-${new Date().toISOString().replace(/[:.]/g, "")}`;
    copyFileSync(target, safetyCopy);
  }
  const tmp = `${target}.restoring`;
  copyFileSync(src, tmp);
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(target + suffix)) unlinkSync(target + suffix);
  }
  renameSync(tmp, target);
  return {
    restored: target,
    safetyCopy,
    integrity: check.integrity,
    users: check.users,
    plans: check.plans,
  };
}
