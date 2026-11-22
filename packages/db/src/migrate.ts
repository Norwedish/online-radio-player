/**
 * Migration runner (PLAN M1.2) — applies the SQL that drizzle-kit generated
 * from `./schema.ts` into `packages/db/drizzle/`.
 *
 * The runtime database stays better-sqlite3 with the ADR 0005 pragmas
 * (`openDatabase`); drizzle-orm is only used for the migration reader, so the
 * schema file and the committed migrations stay the single source of truth.
 *
 * CLI: `pnpm db:migrate [dbFile]` — see `scripts/db-migrate.ts`.
 */
import { openDatabase, type DatabaseOptions } from "./index.js";
import { SCHEMA_TABLE_NAMES } from "./schema.js";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `packages/db/drizzle`, resolved from this file so CLIs can run from anywhere. */
export const defaultMigrationsFolder = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "drizzle",
);

/** Table drizzle-orm's better-sqlite3 migrator creates to record applied hashes. */
const MIGRATIONS_TABLE = "__drizzle_migrations";

export interface MigrationReport {
  dbFile: string;
  migrationsFolder: string;
  migrationsApplied: number;
  tables: string[];
  integrity: string;
}

/**
 * Opens `dbFile`, runs every pending migration, then verifies that every table
 * declared in `./schema.ts` exists and that SQLite reports the file as
 * internally consistent.
 */
export function runMigrations(
  dbFile: string,
  migrationsFolder: string = defaultMigrationsFolder,
  options: DatabaseOptions = {},
): MigrationReport {
  const file = resolve(dbFile);
  const folder = resolve(migrationsFolder);
  const db = openDatabase(file, options);
  try {
    const countMigrations = (): number => {
      try {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${MIGRATIONS_TABLE}`).get();
        return Number((row as { n: number }).n);
      } catch {
        return 0;
      }
    };

    const before = countMigrations();
    const stationDb = drizzle(db);
    migrate(stationDb, { migrationsFolder: folder });

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' " +
          "ORDER BY name",
      )
      .all()
      .map((row) => String((row as { name: string }).name))
      .filter((name) => name !== MIGRATIONS_TABLE);

    const integrityRows = db.pragma("integrity_check") as unknown[];
    const integrityFirst = (integrityRows[0] ?? {}) as Record<string, unknown>;
    const integrityValues = Object.values(integrityFirst);
    const integrity = String(integrityValues[0] ?? integrityRows[0] ?? "no output");

    const report: MigrationReport = {
      dbFile: file,
      migrationsFolder: folder,
      migrationsApplied: countMigrations() - before,
      tables,
      integrity,
    };

    const missing = SCHEMA_TABLE_NAMES.filter((name) => !tables.includes(name));
    if (missing.length > 0) {
      throw new Error(
        `Migrations did not create: ${missing.join(", ")}. ` +
          "Run `pnpm --filter @radio/db exec drizzle-kit generate` and commit the result.",
      );
    }
    if (integrity.toLowerCase() !== "ok") {
      throw new Error(`integrity_check for ${file} is not ok: ${integrity}`);
    }
    return report;
  } finally {
    db.close();
  }
}
