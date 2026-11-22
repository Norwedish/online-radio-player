# ADR 0005 — SQLite with WAL for one writer and concurrent readers

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Norwedish
- **Related:** M0.8, M1.2 (schema/Drizzle), M6 (API), M2 (playout worker)

## Context

The station runs on a small Proxmox LXC (2 vCPU / 4 GB). Persistence needs to cover
media metadata, playlists, play history, requests, users, audit trail, and settings.

Constraints that shaped this decision:

- The **API is the only writer**; the playout worker only reads state (hour plan, next
  track, skip/pause flags) and appends play history through the API, not directly.
- Reads happen continuously while writes stream in (the worker polls, the public
  `/listen` page shows now-playing, stats poll listeners).
- The database must be **backed up while live**, without stopping playout.
- No extra service is acceptable: no Postgres/MySQL container on a 2 vCPU host.
- Media files can live on NAS/SMB/NFS, but the database must stay on local disk.
- Dev host is Windows, target is Debian 13; both must behave the same.

## Options considered

1. **better-sqlite3 + WAL, one writer process, readers via their own connections**
   - Pros: zero extra service, synchronous API, single-file backup, WAL gives
     readers a consistent snapshot without blocking the writer.
   - Cons: one writer at a time; WAL file grows between checkpoints; SQLite on
     network filesystems is unsafe (so the DB cannot live on the NAS).
2. **`node:sqlite` (Node built-in)** — experimental surface, no stable backup API in
   the runtime we target; rejected for now.
3. **Postgres** — overkill for a single station, adds a service, memory, and ops
   burden on a 2 vCPU host; rejected.
4. **Rollup: copy the file with `cp`** — can capture a torn state; rejected in favor
   of SQLite's own backup API.

## Decision

Use **better-sqlite3 12.x** with the database on local disk:

- `PRAGMA journal_mode = WAL` (note: the `=` is required; `PRAGMA journal_mode WAL`
  is a syntax error in this build).
- `PRAGMA busy_timeout = 5000` so short lock contention waits instead of failing.
- `PRAGMA synchronous = NORMAL` — safe in WAL mode against process crashes; only an
  OS/power crash can lose the last commits.
- `PRAGMA foreign_keys = ON` — schema integrity is enforced.
- The API owns the only read-write connection; the playout worker opens
  `readonly: true`.
- Backups use `await db.backup(path)` (consistent snapshot, works while readers and
  the writer are active). Nightly backup + retention policy is M12.
- Schema is plain standard SQLite SQL today; Drizzle ORM lands in M1.2. The spike
  confirmed this SQLite build rejects the abbreviated `CREATE tbl(...)` /
  `INSERT VALUES(...)` / FROM-elision forms some Drizzle examples show, so keep the
  schema SQL standard and re-check Drizzle output when it is added.
- Migrations are **generated, not hand-written** (owner decision 2026-11-22): drizzle-kit
  (`^0.31.11`, devDependency of `@radio/db` only) emits standard SQLite SQL from
  `packages/db/src/schema.ts` into the committed `packages/db/drizzle/`. The runtime stays
  better-sqlite3 with the pragmas above — drizzle-orm (`^0.45.4`) is used only by
  `drizzle-orm/better-sqlite3/migrator`, so no ORM query layer is introduced. `runMigrations()`
  applies the pending SQL to the `openDatabase()` handle and then asserts that every table in
  `SCHEMA_TABLE_NAMES` exists and `PRAGMA integrity_check` is `ok`.
- `better-sqlite3` is CommonJS: import it as `import Database from "better-sqlite3"`.

## Consequences

- Writes serialize; measured cost is ~0.1 ms per insert, so 50 writes/s uses well
  under 1 % of the write path's capacity.
- WAL steady state is bounded by `wal_autocheckpoint` (1000 pages ≈ 4 MB) as long as
  read transactions stay short. Do not hold long-running read transactions open
  (e.g. streaming a large result set while writing) or the WAL cannot checkpoint.
- Read-only connections cannot checkpoint; the writer's connection performs
  checkpointing. Keep the writer alive (the API is always running).
- Never place the DB file on SMB/NFS. Media may be remote; the DB may not.
- On Windows the `-wal` file was not deleted immediately after the last connection
  closed; on Linux a clean close normally removes it. Treat leftover `-wal`/`-shm`
  as harmless: SQLite recovers from them.
- `VACUUM` must not run during active writes; schedule it in maintenance windows.

## Verification

Reproduce:

```bash
pnpm spike:sqlite 30 50
# one writer (50 inserts/s for 30 s) + two readers polling every 250 ms,
# with db.backup() taken mid-load
```

Result file: `data/spike/sqlite/spike-result.json` (git-ignored; numbers below).

| Metric                      | Measured (Windows dev host, Node 26.12.1, better-sqlite3 12.11.1)    |
| --------------------------- | -------------------------------------------------------------------- |
| `journal_mode`              | `wal`                                                                |
| Writer throughput           | 1500 inserts in 30.0 s = **50.0/s**, 0 failures                      |
| `SQLITE_BUSY` retries       | **0** (writer + 2 readers combined)                                  |
| Write latency               | avg **0.111 ms**, max **6 ms**                                       |
| Backup mid-load             | **ok**, 751 of 1500 rows captured at the halfway point               |
| Reader 1 (`playout-worker`) | 117 reads, 0 busy, max read **1 ms**, rows 4 → 1496                  |
| Reader 2 (`stats-poller`)   | 117 reads, 0 busy, max read **1 ms**, rows 4 → 1498                  |
| Reader freshness            | both saw rows advance 116 times; saw the final rows                  |
| WAL size                    | peak **4.13 MB**, 4.13 MB at rest (default 1000-page autocheckpoint) |
| Exit codes                  | writer 0, readers 0, 0, backup ok                                    |

Both readers opened `readonly: true` successfully while the writer was mid-stream,
and both observed new rows without retries — the WAL "one writer, many readers"
model holds for this workload with wide margin.

Host caveat: measurements are from the Windows dev machine; the LXC should be
re-measured in M0.9/M12 with the same script, though the margin is large enough
that the decision is not sensitive to host differences.

## M1.2 re-check of Drizzle output (2026-11-22)

The abbreviated-form risk flagged above did not materialise. `drizzle-kit generate --name init`
produced `packages/db/drizzle/0000_init.sql` (412 lines, 56 statement breakpoints) using standard
`CREATE TABLE name ( … )` forms, and this host's SQLite accepted it:

| Checked in the generated SQL / applied DB | Result                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| Tables created by migrating a fresh file  | 26 (25 from §6.3 + `generator_runs` from §7.1), `missing tables: none`                     |
| Primary keys                              | 26 × `integer PRIMARY KEY AUTOINCREMENT NOT NULL`                                          |
| FK constraints                            | 40, all `ON UPDATE no action ON DELETE no action`; only `backups` and `stations` have none |
| Named indexes                             | 31 (18 `index()` + 13 `unique()`), all present in `sqlite_schema` after migration          |
| Named constraints                         | 12 `CONSTRAINT "…" CHECK(…)` across 11 tables, full expressions rendered                   |
| `PRAGMA integrity_check`                  | `ok`                                                                                       |
| Migrator bookkeeping                      | `__drizzle_migrations` (1 row per applied migration + hash), so re-runs are no-ops         |

One drizzle-orm 0.45.4 pitfall was fixed during generation: a constraint must be written
`check(name, sql.raw(…))`; the bare backtick tag call truncates the CHECK body to its first
character (`CHECK(a)`), which SQLite still accepts but silently stops enforcing the rule.
