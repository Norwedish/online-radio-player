/**
 * App access tokens (mobile / remote-control apps).
 *
 * A signed-in device holds two opaque tokens, both stored only as SHA-256 hashes:
 * - access token  `rat_…`  short-lived (default 60 min), sent as `Authorization: Bearer`;
 *   the request then acts as the user, with the user's current role (RBAC unchanged).
 * - refresh token `rrt_…`  long-lived (default 90 days, sliding), exchanged for a new pair.
 *   Every refresh rotates it; presenting an already-rotated refresh token again means it
 *   was copied, so the whole device grant is revoked (refresh-token reuse detection).
 *
 * Devices sign in either with username + password (+ TOTP) or with a one-time
 * pairing code created in the web console (QR code), so no password needs to be
 * typed on the phone. Bearer requests are not cookie-based, so CSRF does not apply.
 */
import { randomInt } from "node:crypto";
import {
  randomToken,
  sha256,
  toPublicUser,
  type DeviceGrantRow,
  type PublicUser,
  type Repositories,
} from "@radio/db";
import type { RuntimeConfig } from "@radio/shared";
import { AuthError, type AuthService } from "./auth.js";

export const ACCESS_PREFIX = "rat_";
export const REFRESH_PREFIX = "rrt_";
/** Pairing code alphabet: no 0/O/1/I/L confusion when typed by hand. */
const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export interface TokenResponse {
  tokenType: "Bearer";
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresIn: number;
  deviceId: number;
  user: PublicUser;
}

export interface DeviceInfo {
  deviceName?: string | null;
  platform?: string | null;
  appVersion?: string | null;
  ip: string;
}

export interface PublicDevice {
  id: number;
  userId: number;
  name: string;
  platform: string | null;
  appVersion: string | null;
  status: "active" | "pending";
  createdAt: string;
  lastUsedAt: string | null;
  lastIp: string | null;
  expiresAt: string | null;
}

export function publicDevice(row: DeviceGrantRow): PublicDevice {
  const pending = row.refresh_expires_at === null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    platform: row.platform,
    appVersion: row.app_version,
    status: pending ? "pending" : "active",
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    lastIp: row.last_ip,
    expiresAt: pending ? row.pairing_expires_at : row.refresh_expires_at,
  };
}

/** "abcd efgh" / "ABCD-EFGH" → "ABCDEFGH" */
export function normalizePairingCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export class DeviceAuthService {
  constructor(
    private readonly repos: Repositories,
    private readonly config: RuntimeConfig,
    private readonly auth: AuthService,
    private readonly onSecurityEvent: (e: {
      type: "token_reused";
      userId: number;
      deviceId: number;
      device: string;
      ip: string;
    }) => void = () => {},
  ) {}

  private get settings() {
    return this.config.users.appTokens;
  }

  private assertEnabled(): void {
    if (!this.settings.enabled)
      throw new AuthError("app_access_disabled", "app access is disabled on this station", 403);
  }

  private newTokens() {
    const access = ACCESS_PREFIX + randomToken(32);
    const refresh = REFRESH_PREFIX + randomToken(32);
    const accessMs = this.settings.accessTokenMinutes * 60_000;
    const refreshMs = this.settings.refreshTokenDays * 86_400_000;
    return {
      access,
      refresh,
      accessMs,
      refreshMs,
      accessHash: sha256(access),
      refreshHash: sha256(refresh),
      accessExpiresAt: new Date(Date.now() + accessMs).toISOString(),
      refreshExpiresAt: new Date(Date.now() + refreshMs).toISOString(),
    };
  }

  private response(
    t: ReturnType<DeviceAuthService["newTokens"]>,
    deviceId: number,
    userId: number,
  ): TokenResponse {
    return {
      tokenType: "Bearer",
      accessToken: t.access,
      expiresIn: Math.round(t.accessMs / 1000),
      refreshToken: t.refresh,
      refreshExpiresIn: Math.round(t.refreshMs / 1000),
      deviceId,
      user: toPublicUser(this.repos.users.get(userId)!),
    };
  }

  private assertDeviceLimit(userId: number): void {
    if (this.repos.devices.countActive(userId) >= this.settings.maxDevicesPerUser)
      throw new AuthError(
        "too_many_devices",
        `this account already has ${this.settings.maxDevicesPerUser} connected devices; remove one in Account → Devices`,
        409,
      );
  }

  /** grant_type=password */
  async signIn(
    input: { login: string; password: string; totp?: string } & DeviceInfo,
  ): Promise<TokenResponse> {
    this.assertEnabled();
    const user = await this.auth.verifyCredentials(input.login, input.password, input.totp);
    this.assertDeviceLimit(user.id);
    const t = this.newTokens();
    const row = this.repos.devices.create({
      userId: user.id,
      name: (input.deviceName ?? "").trim() || "App",
      platform: input.platform ?? null,
      appVersion: input.appVersion ?? null,
      accessHash: t.accessHash,
      accessExpiresAt: t.accessExpiresAt,
      refreshHash: t.refreshHash,
      refreshExpiresAt: t.refreshExpiresAt,
      ip: input.ip,
    });
    this.repos.users.update(user.id, { last_login_at: new Date().toISOString() });
    return this.response(t, row.id, user.id);
  }

  /** Web console: create a one-time pairing code for the signed-in user. */
  createPairing(
    userId: number,
    name: string,
    ip: string,
  ): { deviceId: number; code: string; expiresAt: string } {
    this.assertEnabled();
    this.assertDeviceLimit(userId);
    const raw = Array.from(
      { length: 8 },
      () => PAIR_ALPHABET[randomInt(PAIR_ALPHABET.length)],
    ).join("");
    const expiresAt = new Date(
      Date.now() + this.settings.pairingCodeMinutes * 60_000,
    ).toISOString();
    const row = this.repos.devices.createPairing({
      userId,
      name: name.trim() || "Remote app",
      pairingHash: sha256(`pair:${raw}`),
      pairingExpiresAt: expiresAt,
      ip,
    });
    return { deviceId: row.id, code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt };
  }

  /** grant_type=pairing_code */
  pair(input: { code: string } & DeviceInfo): TokenResponse {
    this.assertEnabled();
    const t = this.newTokens();
    const row = this.repos.devices.completePairing(
      sha256(`pair:${normalizePairingCode(input.code)}`),
      {
        name: input.deviceName?.trim() || null,
        platform: input.platform ?? null,
        appVersion: input.appVersion ?? null,
        accessHash: t.accessHash,
        accessExpiresAt: t.accessExpiresAt,
        refreshHash: t.refreshHash,
        refreshExpiresAt: t.refreshExpiresAt,
        ip: input.ip,
      },
    );
    if (!row) throw new AuthError("invalid_token", "pairing code is invalid or expired", 400);
    const user = this.repos.users.get(row.user_id);
    if (!user?.is_active) {
      this.repos.devices.revoke(row.id, "user_inactive");
      throw new AuthError("account_disabled", "account is disabled", 403);
    }
    return this.response(t, row.id, row.user_id);
  }

  /** grant_type=refresh_token — rotates both tokens. */
  refresh(input: { refreshToken: string; appVersion?: string | null; ip: string }): TokenResponse {
    this.assertEnabled();
    const hash = sha256(input.refreshToken);
    const row = this.repos.devices.findByRefresh(hash);
    if (!row) {
      const reused = this.repos.devices.findByPreviousRefresh(hash);
      if (reused && !reused.revoked_at) {
        this.repos.devices.revoke(reused.id, "refresh_token_reused");
        this.onSecurityEvent({
          type: "token_reused",
          userId: reused.user_id,
          deviceId: reused.id,
          device: reused.name,
          ip: input.ip,
        });
        throw new AuthError(
          "token_reused",
          "this refresh token was already used; the device was signed out for safety",
        );
      }
      throw new AuthError("invalid_token", "refresh token is invalid or expired");
    }
    if (
      row.revoked_at ||
      !row.refresh_expires_at ||
      row.refresh_expires_at <= new Date().toISOString()
    )
      throw new AuthError("invalid_token", "refresh token is invalid or expired");
    const user = this.repos.users.get(row.user_id);
    if (!user?.is_active) {
      this.repos.devices.revoke(row.id, "user_inactive");
      throw new AuthError("account_disabled", "account is disabled", 403);
    }
    const t = this.newTokens();
    this.repos.devices.rotate(row.id, {
      accessHash: t.accessHash,
      accessExpiresAt: t.accessExpiresAt,
      refreshHash: t.refreshHash,
      refreshExpiresAt: t.refreshExpiresAt,
      ip: input.ip,
      appVersion: input.appVersion ?? null,
    });
    return this.response(t, row.id, row.user_id);
  }

  /** Bearer access token → user + device (null when unknown, expired or revoked). */
  resolve(token: string | undefined, ip: string): { user: PublicUser; deviceId: number } | null {
    if (!token?.startsWith(ACCESS_PREFIX) || !this.settings.enabled) return null;
    const row = this.repos.devices.findByAccess(sha256(token));
    if (!row) return null;
    const user = this.repos.users.get(row.user_id);
    if (!user?.is_active) return null;
    // Record activity at most once a minute (avoids a DB write per request).
    if (
      !row.last_used_at ||
      Date.now() - Date.parse(row.last_used_at) > 60_000 ||
      row.last_ip !== ip
    )
      this.repos.devices.touch(row.id, ip);
    return { user: toPublicUser(user), deviceId: row.id };
  }

  /** Sign-out by refresh token (works even when the access token has expired). */
  revokeByRefresh(refreshToken: string): DeviceGrantRow | null {
    const row = this.repos.devices.findByRefresh(sha256(refreshToken));
    if (!row || row.revoked_at) return null;
    this.repos.devices.revoke(row.id, "signed_out");
    return row;
  }
}
