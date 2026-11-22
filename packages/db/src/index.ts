import Database from "better-sqlite3";

/** Schema revision — see ./schema.js (M1.2) and the migrations in ../drizzle. */
export const DB_SCHEMA_VERSION = 1;

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

/** Migrations and schema metadata (M1.2) — see ./migrate.js and ./schema.js. */
export { defaultMigrationsFolder, runMigrations, type MigrationReport } from "./migrate.js";
export { SCHEMA_TABLE_NAMES } from "./schema.js";
