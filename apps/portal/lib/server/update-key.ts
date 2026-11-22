import "server-only";
import { db } from "./db.ts";
import { env } from "./env.ts";
import { decrypt, encrypt } from "../crypto/secretbox.ts";
import { newSigningKey, signingKeyAad, updateKeyId } from "../update-manifest.ts";

/**
 * The portal's update signing key (Ed25519), generated on first use and stored in Postgres with the private key
 * encrypted by ENCRYPTION_KEY. No new environment variable. See migration 0014.
 */

export interface PublicSigningKey {
  keyId: string;
  /** SPKI DER, base64. */
  publicKey: string;
}

let cachedPrivate: { keyId: string; privateKey: string } | undefined;

async function keyRow(): Promise<{ keyId: string; publicKey: string; privateKeyEnc: string }> {
  const sql = db();
  const read = async () => {
    const rows = await sql`SELECT key_id, public_key, private_key_enc FROM update_signing_keys WHERE id = 'portal'`;
    return rows.map((r) => ({ keyId: String(r.key_id), publicKey: String(r.public_key), privateKeyEnc: String(r.private_key_enc) }))[0];
  };
  const found = await read();
  if (found) return found;
  const k = newSigningKey();
  const enc = encrypt(k.privateKey, env().encryptionKey, signingKeyAad(k.keyId));
  // Two first requests at once: one insert wins, both read the winner.
  await sql`
    INSERT INTO update_signing_keys (id, key_id, algorithm, public_key, private_key_enc)
    VALUES ('portal', ${k.keyId}, 'ed25519', ${k.publicKey}, ${enc})
    ON CONFLICT (id) DO NOTHING
  `;
  const created = await read();
  if (!created) throw new Error("update signing key could not be stored");
  return created;
}

/** The public half (creates the pair on first use). Never decrypts anything. */
export async function publicSigningKey(): Promise<PublicSigningKey> {
  const row = await keyRow();
  if (updateKeyId(row.publicKey) !== row.keyId) throw new Error("update signing key: stored key id does not match the public key");
  return { keyId: row.keyId, publicKey: row.publicKey };
}

/** The private half, decrypted with ENCRYPTION_KEY. Throws when ENCRYPTION_KEY changed since the key was made. */
export async function privateSigningKey(): Promise<{ keyId: string; privateKey: string }> {
  const row = await keyRow();
  if (cachedPrivate?.keyId === row.keyId) return cachedPrivate;
  let privateKey: string;
  try {
    privateKey = decrypt(row.privateKeyEnc, env().encryptionKey, signingKeyAad(row.keyId));
  } catch {
    throw new Error("update signing key cannot be decrypted: ENCRYPTION_KEY changed since it was created");
  }
  cachedPrivate = { keyId: row.keyId, privateKey };
  return cachedPrivate;
}
