import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** SHA-256 hex digest. Tokens are high-entropy, so a fast hash is fine for lookup. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

/**
 * Human-typable one-time code, e.g. "VS-7KQ2-M9XD-4TPA".
 * 12 chars from a 32-symbol alphabet = 60 bits, enough for a code that expires in 30 minutes.
 */
export function enrollmentCode(): string {
  const bytes = randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) out += CODE_ALPHABET[bytes[i] & 31];
  return `VS-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/** Normalize user-typed codes: uppercase, strip spaces. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, "");
}
