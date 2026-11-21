# ADR 0005 — SQLite WAL concurrency

- **Status:** Proposed
- **Date:** TBD (M0.8)
- **Related:** M0.8, M1

## Context

The API writes to SQLite; the playout worker reads plans/media continuously. We need to avoid `SQLITE_BUSY` and keep backups safe.

## Options considered

1. WAL + single writer (API) + read-only worker connection.
2. Separate databases.
3. PostgreSQL.

## Decision

TBD after M0.8 spike.

## Consequences

TBD.

## Verification

TBD: 50 writes/s + continuous reads, busy timeout, `.backup` while reading, integrity check.
