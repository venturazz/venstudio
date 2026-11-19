// Owner recovery: sets a new password for an account and signs it out everywhere.
// Optionally turns off two-factor sign-in (use it if the authenticator app is lost).
// Run it inside the portal container, so the password never appears in a command line or in logs:
//
//   read -s -p "New password (12+ characters): " P; echo
//   docker exec -e NEW_PASSWORD="$P" <portal-container> node apps/portal/scripts/owner-recovery.mjs owner@example.com [--disable-2fa]
//   unset P
//
// The hashing parameters must match apps/portal/lib/crypto/password.ts.
import { randomBytes, scrypt as scryptCb } from "node:crypto";
import postgres from "postgres";

function fail(message) {
  console.error(`owner-recovery: ${message}`);
  process.exit(1);
}

const email = String(process.argv[2] ?? "").trim().toLowerCase();
const disable2fa = process.argv.includes("--disable-2fa");
const password = process.env.NEW_PASSWORD ?? "";
if (!email.includes("@")) fail("give the account email as the first argument");
if (password.length < 12 || password.length > 256) fail("NEW_PASSWORD must be 12 to 256 characters");
if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set");

const N = 2 ** 17;
const R = 8;
const P = 1;
const KEYLEN = 64;
const salt = randomBytes(16);
const key = await new Promise((resolve, reject) =>
  scryptCb(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P, maxmem: 256 * 1024 * 1024 }, (err, k) => (err ? reject(err) : resolve(k))),
);
const hash = ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  const [user] = await sql`SELECT id, email, role FROM users WHERE email = ${email}`;
  if (!user) {
    const accounts = await sql`SELECT email, role FROM users ORDER BY created_at`;
    fail(`no account with that email. Accounts on this server: ${accounts.map((a) => `${a.email} (${a.role})`).join(", ") || "none"}`);
  }
  await sql.begin(async (tx) => {
    await tx`UPDATE users SET password_hash = ${hash}, updated_at = now() WHERE id = ${user.id}`;
    if (disable2fa) {
      await tx`UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_counter = NULL WHERE id = ${user.id}`;
    }
    await tx`DELETE FROM sessions WHERE user_id = ${user.id}`;
    await tx`DELETE FROM login_attempts WHERE email = ${email}`;
    await tx`INSERT INTO audit_log (user_id, action, target, detail) VALUES (${user.id}, 'auth.recovery_reset', ${user.id}, ${JSON.stringify({ disable2fa })}::text::jsonb)`;
  });
  console.log(`Password changed for ${email}. Signed out everywhere, and the login lock was cleared.`);
  console.log(disable2fa ? "Two-factor sign-in is now off. Turn it back on in Settings." : "Two-factor sign-in is unchanged.");
} finally {
  await sql.end();
}
