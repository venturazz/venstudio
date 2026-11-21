"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
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
import { kokoroHealth, voiceTest } from "@/lib/server/tts.ts";
import { generateImage, listHermesImageProviders } from "@/lib/server/executors/hermes-image.ts";
import { testRouterImages } from "@/lib/server/executors/router-image.ts";
import { runSkillCheck, scanCapabilities } from "@/lib/server/capabilities.ts";
import { makerLine, PROVIDER_NAME_MAX, refusedIssue } from "@/lib/studio/asset-plan.ts";
import { saveProviderTerms } from "@/lib/server/provider-terms.ts";
import { advanceRun, recheckTermsReviews } from "@/lib/server/director.ts";
import { listProviderTerms } from "@/lib/server/executors/persist.ts";

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

/** Makes a short test clip the same way the voice stage does and reports which path made it. Nothing is saved. */
export async function testVoice(_prev: TestState, _fd: FormData): Promise<TestState> {
  await requireUser("editor");
  const r = await voiceTest();
  if (!r.ok) return { ok: false, error: r.error };
  const how = r.via === "9router" ? "through 9router" : r.via === "hermes" ? "through Hermes" : "straight from your Kokoro server";
  const lines = [
    `Voice made by ${r.provider} ${how}`,
    ...(r.backend ? [`Spoken by ${r.backend}${r.plugin && r.plugin !== r.backend ? ` via ${r.plugin} plugin` : ""}`] : []),
    `Model ${r.model}`,
    `${r.durationSec === null ? "Length not known" : `${r.durationSec} s of audio`}, ${Math.round(r.bytes / 1024)} KB`,
    `Made in ${(r.ms / 1000).toFixed(1)} s`,
  ];
  if (r.skipped.length > 0) lines.push(`Not used: ${r.skipped.join(" ")}`);
  return { ok: true, lines };
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
    // Nothing is saved, so show what Hermes made even from a refused backend, and say so below.
    enforceTerms: false,
  });
  if (!img.ok) return { ok: false, error: [...lines, `Image: ${img.error}`].join("\n") };
  const { image } = img;
  const maker = { provider: image.provider, backend: image.backend, plugin: image.plugin };
  lines.push(makerLine("Image", maker, image.model));
  // The row terms are tracked under differs from the backend when the backend is not in HERMES_IMAGE_PROVIDER_ORDER.
  if (image.backend && image.provider !== image.backend) {
    lines.push(`Listed in Asset providers as ${image.provider}: ${image.backend} is not in HERMES_IMAGE_PROVIDER_ORDER`);
  }
  const refused = refusedIssue(maker, "image", await listProviderTerms().catch(() => []));
  if (refused) lines.push(`A production shot would refuse this image: ${refused}`);
  lines.push(
    `${image.info.width}x${image.info.height} ${image.info.mime}, ${Math.round(image.info.bytes / 1024)} KB`,
    image.originUrl ? "Hermes returned a download link" : "Hermes returned the image data inline",
    `Asked Hermes ${img.attempts} time${img.attempts === 1 ? "" : "s"}`,
  );
  const preview = image.info.bytes <= PREVIEW_MAX_BYTES ? `data:${image.info.mime};base64,${Buffer.from(image.bytes).toString("base64")}` : undefined;
  return { ok: true, lines, preview };
}

/**
 * Tries the 9router image models the last scan listed, one at a time, and stops at the first real image. Each outcome
 * is recorded: a model that works becomes proven (the automatic chain may use it), one that answers with a 4xx is set
 * aside. Nothing is saved and no provider terms change.
 */
export async function testRouterImage(_prev: TestState, _fd: FormData): Promise<TestState> {
  await requireUser("editor");
  const r = await testRouterImages();
  revalidatePath("/settings");
  const lines = r.lines.map((l) => l.text);
  if (!r.ok) return { ok: false, error: [...lines, r.error].join("\n") };
  const preview = r.image.info.bytes <= PREVIEW_MAX_BYTES ? `data:${r.image.info.mime};base64,${Buffer.from(r.image.bytes).toString("base64")}` : undefined;
  return { ok: true, lines, preview };
}

/**
 * Saves one provider's commercial-use terms (owner only; the write lives in lib/server/provider-terms.ts, shared
 * with the Review card). Afterwards, in after() so the save never waits on it, every open assets or voice card that
 * is held up only by provider terms and uses this row is checked again (bounded, best effort), and runs whose check
 * now passes on their own continue. after() rather than the reaper: the reaper only runs when a page renders.
 */
export async function setProviderTerms(fd: FormData) {
  const owner = await requireUser("owner");
  const saved = await saveProviderTerms(owner, { name: str(fd, "name", PROVIDER_NAME_MAX), kind: str(fd, "kind", 10), status: str(fd, "status", 10), note: str(fd, "note", 300) });
  if (!saved.ok) return;
  revalidatePath("/settings");
  revalidatePath("/review");
  after(async () => {
    const r = await recheckTermsReviews({ name: saved.name, kind: saved.kind }, owner.id);
    for (const runId of r.runIds) await advanceRun(runId);
  });
}

/** Asks Hermes and 9router what they can do and stores the answer. Slow (up to three minutes: the Hermes chat turn and the skills listing fallback run side by side), so it runs on demand. */
export async function scanCapabilitiesNow() {
  await requireUser("editor");
  await scanCapabilities();
  revalidatePath("/settings");
}

/** Hermes's own answer to "can you load these skills?". One chat turn, nothing is generated. The answer is stored and shown on the card. */
export async function checkHermesSkills() {
  await requireUser("editor");
  await runSkillCheck();
  revalidatePath("/settings");
}
