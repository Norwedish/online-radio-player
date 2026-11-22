/**
 * Password hashing and opaque token helpers (PLAN 6.10).
 *
 * Argon2id with OWASP-recommended parameters (19 MiB memory, 2 iterations,
 * parallelism 1). Session/reset/API tokens are 32 random bytes; only their
 * SHA-256 hash is stored.
 */
import { hash, verify } from "@node-rs/argon2";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ARGON2ID = 2; // @node-rs/argon2 Algorithm.Argon2id (const enum not usable with isolatedModules)

const ARGON_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
