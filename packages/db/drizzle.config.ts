/**
 * drizzle-kit configuration (PLAN M1.2) — generates the SQLite migrations that
 * describe `packages/db/src/schema.ts`.
 *
 * Run from inside the package (the workspace root has no runtime alias for the
 * drizzle-kit binary):
 *
 *   pnpm --filter @radio/db exec drizzle-kit generate
 *   pnpm --filter @radio/db exec drizzle-kit diff      # schema vs current SQL
 *
 * Generated SQL lives in `packages/db/drizzle/` and is applied at runtime by
 * `drizzle-orm/better-sqlite3/migrator` (see `src/migrate.ts`). Drizzle only
 * writes SQL here — the `dbCredentials.url` below is the SQLite file it would
 * diff against, never the file migrations are applied to.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: "./data/drizzle-diff.db",
  },
});
