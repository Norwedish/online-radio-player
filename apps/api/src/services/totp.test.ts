import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUrl,
  totp,
  verifyTotp,
} from "./totp.js";

// RFC 4226 / RFC 6238 reference secret "12345678901234567890" (SHA-1).
const SECRET = Buffer.from("12345678901234567890", "ascii");
const SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("TOTP (in-house RFC 6238)", () => {
  it("matches the RFC 4226 HOTP test vectors", () => {
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    expect(expected.map((_, c) => hotp(SECRET, c))).toEqual(expected);
  });

  it("matches the RFC 6238 SHA-1 TOTP test vectors (8 digits)", () => {
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [t, code] of vectors) expect(totp(SECRET_B32, t * 1000, 30, 8)).toBe(code);
  });

  it("round-trips base32 and accepts ±1 step of clock skew only", () => {
    expect(base32Encode(SECRET)).toBe(SECRET_B32);
    expect(base32Decode(SECRET_B32.toLowerCase())).toEqual(SECRET);
    expect(() => base32Decode("not base32!")).toThrow();
    const secret = generateTotpSecret();
    expect(base32Decode(secret).length).toBeGreaterThanOrEqual(20);
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totp(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBe(false);
    expect(verifyTotp(secret, "12345", now)).toBe(false);
    expect(otpauthUrl(secret, "dj@example.org", "Radio FM")).toMatch(
      /^otpauth:\/\/totp\/.+secret=/,
    );
  });
});
