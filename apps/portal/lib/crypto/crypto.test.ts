import { test } from "node:test";
import assert from "node:assert/strict";
import { base32Decode, base32Encode, totp, verifyTotp, otpauthUri } from "./totp.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import { encrypt, decrypt, parseKey } from "./secretbox.ts";
import { enrollmentCode, normalizeCode, randomToken, sha256Hex, safeEqual } from "./tokens.ts";

test("TOTP matches RFC 6238 SHA-1 test vectors", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ];
  for (const [t, expected] of vectors) {
    assert.equal(totp(secret, t * 1000, 30, 8), expected);
    assert.equal(totp(secret, t * 1000), expected.slice(-6));
  }
});

test("base32 round-trips", () => {
  const buf = Buffer.from("venstudio-secret-bytes");
  assert.deepEqual(base32Decode(base32Encode(buf)), buf);
});

test("verifyTotp accepts drift window and blocks replay", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  const t = 1111111111 * 1000;
  const code = totp(secret, t);
  const counter = verifyTotp(secret, code, { timeMs: t });
  assert.equal(counter, Math.floor(1111111111 / 30));
  assert.equal(verifyTotp(secret, code, { timeMs: t + 30_000 }), counter, "one step of drift is accepted");
  assert.equal(verifyTotp(secret, code, { timeMs: t + 90_000 }), null, "three steps of drift is rejected");
  assert.equal(verifyTotp(secret, code, { timeMs: t, lastUsedCounter: counter }), null, "replay is rejected");
  assert.equal(verifyTotp(secret, "abc123", { timeMs: t }), null);
});

test("otpauth URI has issuer and secret", () => {
  const uri = otpauthUri("JBSWY3DPEHPK3PXP", "owner@example.com");
  assert.match(uri, /^otpauth:\/\/totp\/VenStudio%3Aowner%40example\.com\?/);
  assert.match(uri, /secret=JBSWY3DPEHPK3PXP/);
});

test("password hash verifies and rejects wrong password", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.match(hash, /^scrypt\$131072\$8\$1\$/);
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("wrong horse battery staple", hash), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
  await assert.rejects(hashPassword("short"));
});

test("secretbox encrypts, binds AAD and detects tampering", () => {
  const key = parseKey(Buffer.alloc(32, 7).toString("base64"));
  const box = encrypt("refresh-token-123", key, "yt:channel-1");
  assert.equal(decrypt(box, key, "yt:channel-1"), "refresh-token-123");
  assert.throws(() => decrypt(box, key, "yt:channel-2"));
  const parts = box.split(".");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => decrypt(parts.join("."), key, "yt:channel-1"));
  assert.throws(() => parseKey(Buffer.alloc(16).toString("base64")), /32 random bytes/);
  assert.throws(() => parseKey("abcdefghijklmnopqrstuvwxyz012345"), /32 characters/);
  assert.deepEqual(parseKey("ab".repeat(32)), Buffer.alloc(32, 0xab));
  assert.deepEqual(parseKey(` ${Buffer.alloc(32, 7).toString("base64")}\n`), Buffer.alloc(32, 7));
});

test("tokens and enrollment codes", () => {
  assert.equal(randomToken().length, 43);
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const code = enrollmentCode();
  assert.match(code, /^VS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(normalizeCode(` ${code.toLowerCase()} `), code);
  assert.equal(safeEqual("a", "a"), true);
  assert.equal(safeEqual("a", "b"), false);
});
