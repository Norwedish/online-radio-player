/**
 * `pnpm db:migrate [dbFile]` — create the station database (PLAN M1.2).
 *
 * Usage:
 *   pnpm db:migrate                        # DATABASE_URL or data/radio.db
 *   pnpm db:migrate data/radio.db          # explicit SQLite file
 *   pnpm db:migrate /var/radio/radio.db    # production path
 *
 * Exit codes: 0 = every committed migration applied and the file verified;
 * 1 = the migration run failed or the resulting DB is incomplete/damaged.
 *
 * The runner is imported from `packages/db/src/migrate.ts`: `drizzle-orm` and
 * `better-sqlite3` are dependencies of the `@radio/db` workspace package, so
 * bare imports only resolve from inside that package (same note as
 * `scripts/validate-config.ts`). Idempotent: re-running only reports 0 applied.
 */
import { defaultMigrationsFolder, runMigrations } from "../packages/db/src/migrate.ts";
import { SCHEMA_TABLE_NAMES } from "../packages/db/src/schema.ts";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_DB_FILE = "data/radio.db";

/** `file:./data/radio.db` (DATABASE_URL in .env.example) → a plain path. */
function parseDatabaseUrl(value: string): string {
  if (value.startsWith("file:")) {
    return value.slice("file:".length);
  }
  if (value.startsWith("sqlite://")) {
    return value.slice("sqlite://".length);
  }
  return value;
}

const requested =
  process.argv[2] ??
  (process.env.DATABASE_URL ? parseDatabaseUrl(process.env.DATABASE_URL) : DEFAULT_DB_FILE);
const dbFile = resolve(requested);

mkdirSync(dirname(dbFile), { recursive: true });

console.log(`db:migrate → ${dbFile} (migrations: ${defaultMigrationsFolder})`);

try {
  const report = runMigrations(dbFile);
  const extra = report.tables.filter((name) => !SCHEMA_TABLE_NAMES.includes(name));
  console.table([
    {
      db: report.dbFile,
      migrationsFolder: report.migrationsFolder,
      migrationsApplied: report.migrationsApplied,
      tables: report.tables.length,
      expectedTables: SCHEMA_TABLE_NAMES.length,
      unexpectedTables: extra.join(", ") || "—",
      integrity: report.integrity,
    },
  ]);
  if (extra.length > 0) {
    console.log(`unexpected tables: ${extra.join(", ")}`);
    process.exit(1);
  }
  console.log(`tables: ${report.tables.join(", ")}`);
  process.exit(0);
} catch (error) {
  console.error(`db:migrate failed: ${String(error)}\n`);
  console.error(
    `If the schema changed, regenerate: pnpm --filter @radio/db exec drizzle-kit generate`,
  );
  process.exit(1);
}
