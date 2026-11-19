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
import { kokoroHealth, kokoroTest } from "@/lib/server/tts.ts";
import { generateImage, listHermesImageProviders } from "@/lib/server/executors/hermes-image.ts";
import { scanCapabilities } from "@/lib/server/capabilities.ts";
import { PROVIDER_NAME_MAX } from "@/lib/studio/asset-plan.ts";

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

export async function recheckKokoro() {
  await requireUser("editor");
  await kokoroHealth({ fresh: true });
  revalidatePath("/settings");
}

export type TestState =
  | { ok: true; lines: string[]; preview?: string }
  | { ok: false; error: string }
  | undefined;

/** Makes a short test clip with Kokoro and reports how long it took. Nothing is saved. */
export async function testKokoroVoice(_prev: TestState, _fd: FormData): Promise<TestState> {
  await requireUser("editor");
  const r = await kokoroTest();
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, lines: [`Voice ${r.voice}`, `${r.durationSec} s of audio, ${Math.round(r.bytes / 1024)} KB`, `Made in ${(r.ms / 1000).toFixed(1)} s`] };
}

const PREVIEW_MAX_BYTES = 400_000;

/**
 * Asks Hermes which image_gen providers it has, then makes one test image and shows the raw outcome. Nothing is
 * saved and no provider is registered, so the test cannot change what the owner has confirmed.
 */
export async function testHermesImage(_prev: TestState, _fd: FormData): Promise<TestState> {
  await requireUser("editor");
  const lines: string[] = [];
  const providers = await listHermesImageProviders();
  if (providers.ok) lines.push(`Providers Hermes reports: ${providers.providers.map((p) => p.name).join(", ")}`);
  else lines.push(`Provider list: ${providers.error}`);
  const img = await generateImage({
    prompt: "A simple 512 pixel test picture: a red circle on a plain light background. No text.",
    beatRole: "hook",
    format: "short",
    shotRef: "test",
  });
  if (!img.ok) return { ok: false, error: [...lines, `Image: ${img.error}`].join("\n") };
  const { image } = img;
  lines.push(
    `Image made by ${image.provider}${image.model ? ` (${image.model})` : ""}`,
    `${image.info.width}x${image.info.height} ${image.info.mime}, ${Math.round(image.info.bytes / 1024)} KB`,
    image.originUrl ? "Hermes returned a download link" : "Hermes returned the image data inline",
    `Asked Hermes ${img.attempts} time${img.attempts === 1 ? "" : "s"}`,
  );
  const preview = image.info.bytes <= PREVIEW_MAX_BYTES ? `data:${image.info.mime};base64,${Buffer.from(image.bytes).toString("base64")}` : undefined;
  return { ok: true, lines, preview };
}

const termsSchema = z.object({
  name: z.string().min(1).max(PROVIDER_NAME_MAX),
  kind: z.enum(["image", "tts", "library"]),
  status: z.enum(["unknown", "yes", "no"]),
  note: z.string().max(300),
});

/**
 * The only place asset_providers.commercial_ok is ever written. Owner only. Whether a provider's terms allow
 * commercial use is the owner's call; the studio never decides it from anything a model said.
 */
export async function setProviderTerms(fd: FormData) {
  const owner = await requireUser("owner");
  const p = termsSchema.safeParse({ name: str(fd, "name", PROVIDER_NAME_MAX), kind: str(fd, "kind", 10), status: str(fd, "status", 10), note: str(fd, "note", 300) });
  if (!p.success) return;
  const rows = await db()`
    UPDATE asset_providers
    SET commercial_ok = ${p.data.status}, note = ${p.data.note}, confirmed_by = ${owner.id}, confirmed_at = now()
    WHERE name = ${p.data.name} AND kind = ${p.data.kind}
    RETURNING name
  `;
  if (rows.length === 0) return;
  await audit({
    userId: owner.id,
    action: "asset_provider.terms",
    target: `${p.data.kind}:${p.data.name}`,
    detail: { commercialOk: p.data.status },
    ip: (await requestMeta()).ip,
  });
  revalidatePath("/settings");
}

/** Asks Hermes and 9router what they can do and stores the answer. Slow (up to two minutes), so it runs on demand. */
export async function scanCapabilitiesNow() {
  await requireUser("editor");
  await scanCapabilities();
  revalidatePath("/settings");
}
