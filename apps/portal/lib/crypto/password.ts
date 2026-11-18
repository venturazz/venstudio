import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

/**
 * Password hashing with scrypt (node:crypto, no native addons).
 * Format: scrypt$N$r$p$saltB64$hashB64
 * N=2^17, r=8, p=1 follows the OWASP recommendation for scrypt.
 */
const N = 2 ** 17;
const R = 8;
const P = 1;
const KEYLEN = 64;
// scrypt needs 128 * N * r bytes; allow headroom.
const MAXMEM = 256 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize("NFKC"), salt, keylen, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`);
  }
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, N, R, P, KEYLEN);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > PASSWORD_MAX_LENGTH) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  const actual = await scrypt(password, salt, n, r, p, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A valid hash of a random password, used to keep login timing equal for unknown emails. */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString("base64"));
  return dummyHash;
}
