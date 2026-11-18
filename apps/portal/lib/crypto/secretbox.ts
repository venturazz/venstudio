import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for secrets at rest (TOTP secrets, later YouTube refresh tokens).
 * Format: v1.<ivB64url>.<tagB64url>.<ciphertextB64url>
 * `aad` binds a ciphertext to its context (e.g. "totp:<userId>") so it can't be swapped between rows.
 */

export function parseKey(keyB64: string | undefined): Buffer {
  if (!keyB64) throw new Error("ENCRYPTION_KEY is not set");
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  return key;
}

export function encrypt(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(payload: string, key: Buffer, aad: string): string {
  const [version, ivB64, tagB64, ctB64] = payload.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error("Unsupported ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}
