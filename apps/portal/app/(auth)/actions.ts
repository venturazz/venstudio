"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/server/db.ts";
import { env } from "@/lib/server/env.ts";
import { audit } from "@/lib/server/audit.ts";
import { requestMeta } from "@/lib/server/request.ts";
import {
  completeMfa,
  createSession,
  getSession,
  loginBlocked,
  recordLoginAttempt,
} from "@/lib/server/auth.ts";
import { getDummyHash, hashPassword, PASSWORD_MIN_LENGTH, verifyPassword } from "@/lib/crypto/password.ts";
import { decrypt } from "@/lib/crypto/secretbox.ts";
import { verifyTotp } from "@/lib/crypto/totp.ts";
import { safeEqual } from "@/lib/crypto/tokens.ts";
import { str, type FormState } from "@/lib/form.ts";

const GENERIC = "Email or password is incorrect.";
const BLOCKED = "Too many attempts. Wait 15 minutes and try again.";

export async function login(_prev: FormState, fd: FormData): Promise<FormState> {
  const email = str(fd, "email", 254).toLowerCase();
  const password = typeof fd.get("password") === "string" ? (fd.get("password") as string) : "";
  if (!email || !password) return { error: GENERIC };
  const meta = await requestMeta();
  if (await loginBlocked(email, meta.ip)) return { error: BLOCKED };

  const [user] = await db()`SELECT id, password_hash, totp_enabled FROM users WHERE email = ${email}`;
  // Always run one hash so response time doesn't reveal whether the email exists.
  const ok = await verifyPassword(password, user?.password_hash ?? (await getDummyHash()));
  if (!user || !ok) {
    await recordLoginAttempt(email, meta.ip, false);
    return { error: GENERIC };
  }

  if (user.totp_enabled) {
    await createSession(user.id, { mfaPending: true, ...meta });
    redirect("/login/verify");
  }
  await recordLoginAttempt(email, meta.ip, true);
  await createSession(user.id, { mfaPending: false, ...meta });
  await audit({ userId: user.id, action: "auth.login", ip: meta.ip });
  redirect("/");
}

export async function verifyMfa(_prev: FormState, fd: FormData): Promise<FormState> {
  const session = await getSession();
  if (!session || !session.mfaPending) redirect("/login");
  const meta = await requestMeta();
  if (await loginBlocked(session.email, meta.ip)) return { error: BLOCKED };

  const [user] = await db()`SELECT totp_secret_enc, totp_last_counter FROM users WHERE id = ${session.id}`;
  if (!user?.totp_secret_enc) redirect("/login");
  const secret = decrypt(user.totp_secret_enc, env().encryptionKey, `totp:${session.id}`);
  const counter = verifyTotp(secret, str(fd, "code", 10), {
    lastUsedCounter: user.totp_last_counter == null ? null : Number(user.totp_last_counter),
  });
  if (counter === null) {
    await recordLoginAttempt(session.email, meta.ip, false);
    return { error: "That code didn't match. Check your authenticator app and try again." };
  }
  await db()`UPDATE users SET totp_last_counter = ${counter} WHERE id = ${session.id}`;
  await recordLoginAttempt(session.email, meta.ip, true);
  await completeMfa(session.sessionId, session.id, meta);
  await audit({ userId: session.id, action: "auth.login", detail: { mfa: true }, ip: meta.ip });
  redirect("/");
}

const setupSchema = z.object({
  token: z.string().min(1),
  name: z.string().min(1, "Name is required").max(80),
  email: z.email("Enter a valid email").max(254),
  password: z.string().min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`).max(256),
});

export async function setupOwner(_prev: FormState, fd: FormData): Promise<FormState> {
  const expected = env().SETUP_TOKEN;
  if (!expected) return { error: "SETUP_TOKEN is not set on the server." };
  const parsed = setupSchema.safeParse({
    token: str(fd, "token", 200),
    name: str(fd, "name", 80),
    email: str(fd, "email", 254).toLowerCase(),
    password: typeof fd.get("password") === "string" ? fd.get("password") : "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  if (!safeEqual(parsed.data.token, expected)) return { error: "Setup token is incorrect." };

  const hash = await hashPassword(parsed.data.password);
  const meta = await requestMeta();
  const created = await db().begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(727002)`;
    const [{ n }] = await tx`SELECT count(*)::int AS n FROM users`;
    if (n > 0) return null;
    const [u] = await tx`
      INSERT INTO users (email, name, role, password_hash)
      VALUES (${parsed.data.email}, ${parsed.data.name}, 'owner', ${hash})
      RETURNING id
    `;
    return u.id as string;
  });
  if (!created) return { error: "Setup is already complete. Sign in instead." };
  await createSession(created, { mfaPending: false, ...meta });
  await audit({ userId: created, action: "auth.setup_owner", ip: meta.ip });
  redirect("/settings?welcome=1");
}
