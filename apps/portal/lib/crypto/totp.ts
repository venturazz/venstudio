import { createHmac, randomBytes } from "node:crypto";

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), compatible with Google Authenticator, 1Password, Authy, etc. */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character");
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
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totp(secretB32: string, timeMs = Date.now(), step = 30, digits = 6): string {
  return hotp(base32Decode(secretB32), Math.floor(timeMs / 1000 / step), digits);
}

/**
 * Verify a code allowing +/- `window` steps of clock drift.
 * Returns the matched counter (store it to block replay) or null.
 */
export function verifyTotp(
  secretB32: string,
  code: string,
  opts: { timeMs?: number; window?: number; lastUsedCounter?: number | null } = {},
): number | null {
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const now = Math.floor((opts.timeMs ?? Date.now()) / 1000 / 30);
  const window = opts.window ?? 1;
  const key = base32Decode(secretB32);
  for (let i = -window; i <= window; i++) {
    const counter = now + i;
    if (opts.lastUsedCounter != null && counter <= opts.lastUsedCounter) continue;
    if (hotp(key, counter) === clean) return counter;
  }
  return null;
}

export function otpauthUri(secretB32: string, account: string, issuer = "VenStudio"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}
