import type Database from "better-sqlite3";
import type { Role } from "@radio/shared";
import { bool, buildSet, fromJson, int, nowIso, toJson } from "../util.js";
import type { ApiKeyRow, PublicUser, SessionRow, UserRow } from "./types.js";

type Raw = Record<string, unknown>;

function mapUser(row: Raw | undefined): UserRow | undefined {
  if (!row) return undefined;
  return {
    ...(row as unknown as UserRow),
    totp_enabled: bool(row.totp_enabled),
    is_active: bool(row.is_active),
  };
}

export function toPublicUser(user: UserRow): PublicUser {
  const { password_hash: _p, totp_secret: _t, ...rest } = user;
  return rest;
}

export class UserRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly stationId: number,
  ) {}

  list(): UserRow[] {
    return this.db
      .prepare("SELECT * FROM users WHERE station_id = ? ORDER BY username")
      .all(this.stationId)
      .map((r) => mapUser(r as Raw)!);
  }

  get(id: number): UserRow | undefined {
    return mapUser(
      this.db
        .prepare("SELECT * FROM users WHERE id = ? AND station_id = ?")
        .get(id, this.stationId) as Raw,
    );
  }

  findByLogin(login: string): UserRow | undefined {
    return mapUser(
      this.db
        .prepare(
          "SELECT * FROM users WHERE station_id = ? AND (lower(username) = lower(?) OR lower(email) = lower(?))",
        )
        .get(this.stationId, login, login) as Raw,
    );
  }

  create(input: {
    username: string;
    email: string;
    passwordHash: string;
    role: Role;
    isActive?: boolean;
  }): UserRow {
    const now = nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO users (station_id, username, email, password_hash, role, is_active, totp_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        this.stationId,
        input.username,
        input.email,
        input.passwordHash,
        input.role,
        int(input.isActive ?? true),
        now,
        now,
      );
    return this.get(Number(info.lastInsertRowid))!;
  }

  update(
    id: number,
    patch: Partial<{
      username: string;
      email: string;
      password_hash: string;
      role: Role;
      is_active: boolean;
      totp_secret: string | null;
      totp_enabled: boolean;
      last_login_at: string;
    }>,
  ): UserRow | undefined {
    const { sql, params } = buildSet(patch, [
      "username",
      "email",
      "password_hash",
      "role",
      "is_active",
      "totp_secret",
      "totp_enabled",
      "last_login_at",
    ]);
    if (sql) {
      this.db
        .prepare(`UPDATE users SET ${sql}, updated_at = @now WHERE id = @id AND station_id = @sid`)
        .run({ ...params, now: nowIso(), id, sid: this.stationId });
    }
    return this.get(id);
  }

  count(): number {
    return Number(
      (
        this.db
          .prepare("SELECT COUNT(*) AS n FROM users WHERE station_id = ?")
          .get(this.stationId) as Raw
      ).n,
    );
  }

  /** TOTP recovery codes live in settings-like JSON on the user via a side table-free approach. */
  getRecoveryCodes(userId: number): string[] {
    const row = this.db
      .prepare("SELECT value_json FROM settings WHERE key = ?")
      .get(`user.${userId}.recovery_codes`) as Raw | undefined;
    return fromJson<string[]>(row?.value_json as string | undefined, []);
  }

  setRecoveryCodes(userId: number, hashes: string[]): void {
    this.db
      .prepare(
        `INSERT INTO settings (station_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      )
      .run(this.stationId, `user.${userId}.recovery_codes`, toJson(hashes), nowIso());
  }
}

export class SessionRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: {
    userId: number;
    tokenHash: string;
    ip: string;
    userAgent: string | null;
    expiresAt: string;
  }): SessionRow {
    const info = this.db
      .prepare(
        `INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.userId, input.tokenHash, input.ip, input.userAgent, input.expiresAt, nowIso());
    return this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(info.lastInsertRowid) as SessionRow;
  }

  findActive(tokenHash: string, now = nowIso()): SessionRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?",
      )
      .get(tokenHash, now) as SessionRow | undefined;
  }

  touch(id: number, expiresAt: string): void {
    this.db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(expiresAt, id);
  }

  revoke(id: number): void {
    this.db
      .prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(nowIso(), id);
  }

  revokeAllForUser(userId: number, exceptId?: number): number {
    return this.db
      .prepare(
        "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?",
      )
      .run(nowIso(), userId, exceptId ?? null).changes;
  }

  listForUser(userId: number): SessionRow[] {
    return this.db
      .prepare(
        "SELECT * FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC",
      )
      .all(userId, nowIso()) as SessionRow[];
  }

  purgeExpired(before = nowIso()): number {
    return this.db
      .prepare("DELETE FROM sessions WHERE expires_at < ? OR revoked_at IS NOT NULL")
      .run(before).changes;
  }
}

export class PasswordResetRepository {
  constructor(private readonly db: Database.Database) {}

  create(userId: number, tokenHash: string, expiresAt: string): void {
    this.db
      .prepare(
        "INSERT INTO password_resets (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(userId, tokenHash, expiresAt, nowIso());
  }

  /** Atomically consumes a valid token; returns the user id or undefined. */
  consume(tokenHash: string): number | undefined {
    const tx = this.db.transaction((hash: string) => {
      const row = this.db
        .prepare(
          "SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
        )
        .get(hash, nowIso()) as Raw | undefined;
      if (!row) return undefined;
      this.db.prepare("UPDATE password_resets SET used_at = ? WHERE id = ?").run(nowIso(), row.id);
      return Number(row.user_id);
    });
    return tx(tokenHash);
  }
}

function mapKey(row: Raw | undefined): ApiKeyRow | undefined {
  if (!row) return undefined;
  const { scopes_json, ...rest } = row;
  return {
    ...(rest as unknown as ApiKeyRow),
    scopes: fromJson<string[]>(scopes_json as string, []),
  };
}

export class ApiKeyRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly stationId: number,
  ) {}

  list(): ApiKeyRow[] {
    return this.db
      .prepare("SELECT * FROM api_keys WHERE station_id = ? ORDER BY created_at DESC")
      .all(this.stationId)
      .map((r) => mapKey(r as Raw)!);
  }

  create(input: {
    name: string;
    prefix: string;
    keyHash: string;
    scopes: string[];
    createdBy: number | null;
  }): ApiKeyRow {
    const info = this.db
      .prepare(
        `INSERT INTO api_keys (station_id, name, key_prefix, key_hash, scopes_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.stationId,
        input.name,
        input.prefix,
        input.keyHash,
        toJson(input.scopes),
        input.createdBy,
        nowIso(),
      );
    return mapKey(
      this.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(info.lastInsertRowid) as Raw,
    )!;
  }

  findActive(keyHash: string): ApiKeyRow | undefined {
    return mapKey(
      this.db
        .prepare(
          "SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL AND station_id = ?",
        )
        .get(keyHash, this.stationId) as Raw,
    );
  }

  markUsed(id: number): void {
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(nowIso(), id);
  }

  revoke(id: number): boolean {
    return (
      this.db
        .prepare(
          "UPDATE api_keys SET revoked_at = ? WHERE id = ? AND station_id = ? AND revoked_at IS NULL",
        )
        .run(nowIso(), id, this.stationId).changes > 0
    );
  }
}
