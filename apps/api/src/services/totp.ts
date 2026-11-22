/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) with RFC 4648 base32 secrets. */
import { createHmac, randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, "0");
}

export function totp(secretBase32: string, timeMs = Date.now(), step = 30, digits = 6): string {
  return hotp(base32Decode(secretBase32), Math.floor(timeMs / 1000 / step), digits);
}

/** Accepts the current step ±`window` steps (clock skew). */
export function verifyTotp(
  secretBase32: string,
  code: string,
  timeMs = Date.now(),
  window = 1,
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(timeMs / 1000 / 30);
  const secret = base32Decode(secretBase32);
  for (let w = -window; w <= window; w += 1) if (hotp(secret, counter + w) === code) return true;
  return false;
}

export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
