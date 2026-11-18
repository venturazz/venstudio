"use server";

import { revalidatePath } from "next/cache";
import QRCode from "qrcode";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { env } from "@/lib/server/env.ts";
import { audit } from "@/lib/server/audit.ts";
import { requestMeta } from "@/lib/server/request.ts";
import { hashPassword, PASSWORD_MIN_LENGTH, verifyPassword } from "@/lib/crypto/password.ts";
import { decrypt, encrypt } from "@/lib/crypto/secretbox.ts";
import { generateTotpSecret, otpauthUri, verifyTotp } from "@/lib/crypto/totp.ts";
import { randomToken } from "@/lib/crypto/tokens.ts";
import { str, type FormState } from "@/lib/form.ts";

function raw(fd: FormData, key: string) {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}

export async function changePassword(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  const current = raw(fd, "current");
  const next = raw(fd, "next");
  if (next.length < PASSWORD_MIN_LENGTH) return { error: `New password must be at least ${PASSWORD_MIN_LENGTH} characters.` };
  if (next !== raw(fd, "confirm")) return { error: "New passwords don't match." };
  const [row] = await db()`SELECT password_hash FROM users WHERE id = ${user.id}`;
  if (!(await verifyPassword(current, row.password_hash))) return { error: "Current password is incorrect." };
  const hash = await hashPassword(next);
  await db()`UPDATE users SET password_hash = ${hash}, updated_at = now() WHERE id = ${user.id}`;
  // Sign out every other device.
  await db()`DELETE FROM sessions WHERE user_id = ${user.id} AND id <> ${user.sessionId}`;
  await audit({ userId: user.id, action: "auth.password_changed", ip: (await requestMeta()).ip });
  return { ok: "Password changed. Other devices were signed out." };
}

export type TotpState = { error?: string; ok?: string; secret?: string; qr?: string } | undefined;

export async function startTotp(_prev: TotpState, _fd: FormData): Promise<TotpState> {
  const user = await requireUser();
  if (user.totpEnabled) return { error: "Two-factor is already on." };
  const secret = generateTotpSecret();
  const enc = encrypt(secret, env().encryptionKey, `totp:${user.id}`);
  await db()`UPDATE users SET totp_secret_enc = ${enc}, totp_last_counter = NULL WHERE id = ${user.id}`;
  const qr = await QRCode.toDataURL(otpauthUri(secret, user.email), { margin: 1, width: 220 });
  return { secret, qr };
}

export async function confirmTotp(_prev: TotpState, fd: FormData): Promise<TotpState> {
  const user = await requireUser();
  const [row] = await db()`SELECT totp_secret_enc FROM users WHERE id = ${user.id}`;
  if (!row?.totp_secret_enc) return { error: "Start setup again." };
  const secret = decrypt(row.totp_secret_enc, env().encryptionKey, `totp:${user.id}`);
  const counter = verifyTotp(secret, str(fd, "code", 10));
  if (counter === null) {
    const qr = await QRCode.toDataURL(otpauthUri(secret, user.email), { margin: 1, width: 220 });
    return { error: "That code didn't match. Try the newest code.", secret, qr };
  }
  await db()`UPDATE users SET totp_enabled = true, totp_last_counter = ${counter}, updated_at = now() WHERE id = ${user.id}`;
  await audit({ userId: user.id, action: "auth.totp_enabled", ip: (await requestMeta()).ip });
  revalidatePath("/settings");
  return { ok: "Two-factor is on. You'll be asked for a code at sign-in." };
}

export async function disableTotp(_prev: FormState, fd: FormData): Promise<FormState> {
  const user = await requireUser();
  const [row] = await db()`SELECT password_hash FROM users WHERE id = ${user.id}`;
  if (!(await verifyPassword(raw(fd, "password"), row.password_hash))) return { error: "Password is incorrect." };
  await db()`UPDATE users SET totp_enabled = false, totp_secret_enc = NULL, totp_last_counter = NULL WHERE id = ${user.id}`;
  await audit({ userId: user.id, action: "auth.totp_disabled", ip: (await requestMeta()).ip });
  revalidatePath("/settings");
  return { ok: "Two-factor is off." };
}

export async function signOutOtherSessions() {
  const user = await requireUser();
  await db()`DELETE FROM sessions WHERE user_id = ${user.id} AND id <> ${user.sessionId}`;
  revalidatePath("/settings");
}

export type InviteState = { error?: string; email?: string; password?: string } | undefined;

const inviteSchema = z.object({
  name: z.string().min(1).max(80),
  email: z.email().max(254),
  role: z.enum(["editor", "viewer"]),
});

/** Owner adds a teammate with a one-time temporary password, shown once. */
export async function addUser(_prev: InviteState, fd: FormData): Promise<InviteState> {
  const owner = await requireUser("owner");
  const p = inviteSchema.safeParse({ name: str(fd, "name", 80), email: str(fd, "email", 254).toLowerCase(), role: str(fd, "role", 10) });
  if (!p.success) return { error: p.error.issues[0]?.message ?? "Invalid input" };
  const temp = randomToken(12);
  const hash = await hashPassword(temp);
  const rows = await db()`
    INSERT INTO users (email, name, role, password_hash) VALUES (${p.data.email}, ${p.data.name}, ${p.data.role}, ${hash})
    ON CONFLICT (email) DO NOTHING RETURNING id
  `;
  if (!rows[0]) return { error: "A user with that email already exists." };
  await audit({ userId: owner.id, action: "user.create", target: rows[0].id, detail: { role: p.data.role }, ip: (await requestMeta()).ip });
  revalidatePath("/settings");
  return { email: p.data.email, password: temp };
}

export async function removeUser(id: string) {
  const owner = await requireUser("owner");
  if (!z.uuid().safeParse(id).success || id === owner.id) return;
  await db()`DELETE FROM users WHERE id = ${id} AND role <> 'owner'`;
  await audit({ userId: owner.id, action: "user.delete", target: id, ip: (await requestMeta()).ip });
  revalidatePath("/settings");
}
