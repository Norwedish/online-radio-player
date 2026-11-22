import Database from "better-sqlite3";

export const DB_SCHEMA_VERSION = 0;

export interface DatabaseOptions {
  /** Open without write access — the playout worker never writes (ADR 0005). */
  readonly?: boolean;
}

/**
 * Opens the station database with the pragmas agreed in ADR 0005.
 *
 * The API owns the only read-write handle; the playout worker opens read-only.
 * WAL is only set by the writer: a read-only connection cannot change the
 * journal mode and does not need to.
 */
export function openDatabase(file: string, options: DatabaseOptions = {}): Database.Database {
  const readonly = options.readonly ?? false;
  const db = new Database(file, { readonly });
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  if (!readonly) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
  }
  return db;
}
