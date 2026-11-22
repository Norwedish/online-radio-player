/**
 * Authentication (PLAN §5.6 / §6.10 / M7): argon2id passwords, opaque session
 * tokens (32 random bytes, SHA-256 hashed at rest, sliding expiry), CSRF
 * double-submit token, TOTP 2FA with one-time recovery codes, email password
 * reset (1 h, single use) and scoped API keys.
 */
import { randomBytes } from "node:crypto";
import {
  hashPassword,
  randomToken,
  sha256,
  verifyPassword,
  type PublicUser,
  type Repositories,
  type UserRow,
} from "@radio/db";
import { toPublicUser } from "@radio/db";
import type { ApiKeyScope, RuntimeConfig } from "@radio/shared";
import type { Mailer } from "./mailer.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "./totp.js";

export class AuthError extends Error {
  constructor(
    readonly code:
      | "invalid_credentials"
      | "totp_required"
      | "totp_invalid"
      | "account_disabled"
      | "weak_password"
      | "invalid_token",
    message: string,
    readonly statusCode = 401,
  ) {
    super(message);
  }
}

const DUMMY_HASH_PROMISE = hashPassword("timing-equalizer-not-a-password");

export interface SessionInfo {
  user: PublicUser;
  sessionId: number;
  csrf: string;
}

export class AuthService {
  constructor(
    private readonly repos: Repositories,
    private readonly config: RuntimeConfig,
    private readonly mailer: Mailer,
  ) {}

  get sessionHours(): number {
    return this.config.users.sessionHours;
  }

  checkPasswordPolicy(password: string): void {
    const min = this.config.users.passwordMinLength;
    if (password.length < min)
      throw new AuthError("weak_password", `password must be at least ${min} characters`, 400);
    if (password.length > 256) throw new AuthError("weak_password", "password is too long", 400);
  }

  async login(input: {
    login: string;
    password: string;
    totp?: string;
    ip: string;
    userAgent: string | null;
  }): Promise<{ user: PublicUser; token: string; csrf: string; expiresAt: string }> {
    const user = this.repos.users.findByLogin(input.login.trim());
    const ok = user
      ? await verifyPassword(user.password_hash, input.password)
      : (await verifyPassword(await DUMMY_HASH_PROMISE, input.password), false);
    if (!user || !ok) throw new AuthError("invalid_credentials", "invalid username or password");
    if (!user.is_active) throw new AuthError("account_disabled", "account is disabled", 403);
    if (user.totp_enabled && user.totp_secret) {
      if (!input.totp) throw new AuthError("totp_required", "two-factor code required");
      if (!this.verifySecondFactor(user, input.totp))
        throw new AuthError("totp_invalid", "invalid two-factor code");
    }
    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + this.sessionHours * 3_600_000).toISOString();
    this.repos.sessions.create({
      userId: user.id,
      tokenHash: sha256(token),
      ip: input.ip,
      userAgent: input.userAgent,
      expiresAt,
    });
    this.repos.users.update(user.id, { last_login_at: new Date().toISOString() });
    return {
      user: toPublicUser(this.repos.users.get(user.id)!),
      token,
      csrf: csrfFor(token),
      expiresAt,
    };
  }

  /** TOTP code or a one-time recovery code (consumed on use). */
  private verifySecondFactor(user: UserRow, code: string): boolean {
    const clean = code.replace(/\s|-/g, "");
    if (/^\d{6}$/.test(clean)) return verifyTotp(user.totp_secret!, clean);
    const hashes = this.repos.users.getRecoveryCodes(user.id);
    const h = sha256(clean.toLowerCase());
    if (!hashes.includes(h)) return false;
    this.repos.users.setRecoveryCodes(
      user.id,
      hashes.filter((x) => x !== h),
    );
    return true;
  }

  /** Resolves a session cookie token; extends the expiry when past half-life (sliding). */
  resolveSession(token: string | undefined): SessionInfo | null {
    if (!token) return null;
    const session = this.repos.sessions.findActive(sha256(token));
    if (!session) return null;
    const user = this.repos.users.get(session.user_id);
    if (!user || !user.is_active) return null;
    const remaining = Date.parse(session.expires_at) - Date.now();
    if (remaining < (this.sessionHours * 3_600_000) / 2) {
      this.repos.sessions.touch(
        session.id,
        new Date(Date.now() + this.sessionHours * 3_600_000).toISOString(),
      );
    }
    return { user: toPublicUser(user), sessionId: session.id, csrf: csrfFor(token) };
  }

  logout(sessionId: number): void {
    this.repos.sessions.revoke(sessionId);
  }

  logoutEverywhere(userId: number, exceptSessionId?: number): number {
    return this.repos.sessions.revokeAllForUser(userId, exceptSessionId);
  }

  async changePassword(
    userId: number,
    current: string,
    next: string,
    keepSessionId?: number,
  ): Promise<void> {
    const user = this.repos.users.get(userId);
    if (!user || !(await verifyPassword(user.password_hash, current)))
      throw new AuthError("invalid_credentials", "current password is wrong");
    this.checkPasswordPolicy(next);
    this.repos.users.update(userId, { password_hash: await hashPassword(next) });
    this.repos.sessions.revokeAllForUser(userId, keepSessionId);
  }

  /* ── TOTP ────────────────────────────────────────────────────────── */

  setupTotp(userId: number): { secret: string; otpauthUrl: string } {
    const user = this.repos.users.get(userId)!;
    if (user.totp_enabled)
      throw new AuthError("totp_invalid", "two-factor authentication is already enabled", 409);
    const secret = generateTotpSecret();
    this.repos.users.update(userId, { totp_secret: secret, totp_enabled: false });
    return { secret, otpauthUrl: otpauthUrl(secret, user.username, this.config.station.name) };
  }

  enableTotp(userId: number, code: string): { recoveryCodes: string[] } {
    const user = this.repos.users.get(userId)!;
    if (!user.totp_secret || !verifyTotp(user.totp_secret, code))
      throw new AuthError("totp_invalid", "invalid two-factor code", 400);
    const codes = Array.from({ length: 10 }, () => randomBytes(5).toString("hex"));
    this.repos.users.setRecoveryCodes(
      userId,
      codes.map((c) => sha256(c)),
    );
    this.repos.users.update(userId, { totp_enabled: true });
    return { recoveryCodes: codes };
  }

  async disableTotp(userId: number, password: string): Promise<void> {
    const user = this.repos.users.get(userId)!;
    if (!(await verifyPassword(user.password_hash, password)))
      throw new AuthError("invalid_credentials", "password is wrong");
    this.repos.users.update(userId, { totp_enabled: false, totp_secret: null });
    this.repos.users.setRecoveryCodes(userId, []);
  }

  /* ── Password reset ──────────────────────────────────────────────── */

  /** Always resolves (never reveals whether the account exists). */
  async forgotPassword(email: string, baseUrl: string): Promise<string | null> {
    if (!this.config.users.emailResetEnabled) return null;
    const user = this.repos.users.findByLogin(email);
    if (!user || !user.is_active || user.email.toLowerCase() !== email.toLowerCase()) return null;
    const token = randomToken(32);
    this.repos.passwordResets.create(
      user.id,
      sha256(token),
      new Date(Date.now() + 3_600_000).toISOString(),
    );
    const link = `${baseUrl.replace(/\/$/, "")}/reset-password?token=${token}`;
    await this.mailer.send(
      [user.email],
      this.config.email.resetSubject,
      `A password reset was requested for ${user.username}.\n\nOpen this link within 1 hour:\n${link}\n\nIf you did not request this, ignore this email.`,
    );
    return token;
  }

  async resetPassword(token: string, password: string): Promise<number> {
    this.checkPasswordPolicy(password);
    const userId = this.repos.passwordResets.consume(sha256(token));
    if (!userId) throw new AuthError("invalid_token", "reset link is invalid or expired", 400);
    this.repos.users.update(userId, { password_hash: await hashPassword(password) });
    this.repos.sessions.revokeAllForUser(userId);
    return userId;
  }

  /* ── API keys ────────────────────────────────────────────────────── */

  createApiKey(
    name: string,
    scopes: ApiKeyScope[],
    createdBy: number | null,
  ): { key: string; id: number; prefix: string } {
    const prefix = `rk_${randomBytes(4).toString("hex")}`;
    const key = `${prefix}_${randomToken(24)}`;
    const row = this.repos.apiKeys.create({
      name,
      prefix,
      keyHash: sha256(key),
      scopes,
      createdBy,
    });
    return { key, id: row.id, prefix };
  }

  resolveApiKey(key: string | undefined): { id: number; scopes: string[]; name: string } | null {
    if (!key || !key.startsWith("rk_")) return null;
    const row = this.repos.apiKeys.findActive(sha256(key));
    if (!row) return null;
    this.repos.apiKeys.markUsed(row.id);
    return { id: row.id, scopes: row.scopes, name: row.name };
  }
}

/** CSRF token bound to the session token (double-submit; stateless). */
export function csrfFor(sessionToken: string): string {
  return sha256(`csrf:${sessionToken}`).slice(0, 40);
}
