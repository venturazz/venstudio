import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db.ts";
import { isProduction } from "./env.ts";
import { randomToken, sha256Hex } from "../crypto/tokens.ts";

// The __Host- prefix makes the browser reject the cookie unless it is Secure, path=/ and has no Domain.
export const SESSION_COOKIE = isProduction ? "__Host-vs_session" : "vs_session";
const SESSION_DAYS = 30;
const MFA_PENDING_MINUTES = 10;

export type Role = "owner" | "editor" | "viewer";

export interface SessionUser {
  sessionId: string;
  mfaPending: boolean;
  id: string;
  email: string;
  name: string;
  role: Role;
  totpEnabled: boolean;
}

export async function createSession(userId: string, opts: { mfaPending: boolean; ip: string; userAgent: string }) {
  const token = randomToken(32);
  const expiresMs = opts.mfaPending ? MFA_PENDING_MINUTES * 60_000 : SESSION_DAYS * 86_400_000;
  const expiresAt = new Date(Date.now() + expiresMs);
  await db()`
    INSERT INTO sessions (user_id, token_hash, mfa_pending, ip, user_agent, expires_at)
    VALUES (${userId}, ${sha256Hex(token)}, ${opts.mfaPending}, ${opts.ip}, ${opts.userAgent}, ${expiresAt})
  `;
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** Promote an MFA-pending session to a full session with a fresh token (prevents session fixation). */
export async function completeMfa(sessionId: string, userId: string, meta: { ip: string; userAgent: string }) {
  await db()`DELETE FROM sessions WHERE id = ${sessionId}`;
  await createSession(userId, { mfaPending: false, ...meta });
}

/** Current session, including MFA-pending ones. Cached per request. */
export const getSession = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || token.length > 100) return null;
  const rows = await db()`
    SELECT s.id AS session_id, s.mfa_pending, s.last_seen_at,
           u.id, u.email, u.name, u.role, u.totp_enabled
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${sha256Hex(token)} AND s.expires_at > now()
  `;
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - new Date(row.last_seen_at).getTime() > 5 * 60_000) {
    await db()`UPDATE sessions SET last_seen_at = now() WHERE id = ${row.session_id}`;
  }
  return {
    sessionId: row.session_id,
    mfaPending: row.mfa_pending,
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    totpEnabled: row.totp_enabled,
  };
});

/** For pages and server actions: a fully signed-in user, or redirect to login. */
export async function requireUser(minRole: Role = "viewer"): Promise<SessionUser> {
  const s = await getSession();
  if (!s) redirect("/login");
  if (s.mfaPending) redirect("/login/verify");
  if (!hasRole(s.role, minRole)) redirect("/?denied=1");
  return s;
}

const RANK: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
export function hasRole(role: Role, min: Role) {
  return RANK[role] >= RANK[min];
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db()`DELETE FROM sessions WHERE token_hash = ${sha256Hex(token)}`;
  jar.delete(SESSION_COOKIE);
}

// ---- brute-force protection ----

const WINDOW_MINUTES = 15;
const MAX_FAILS_PER_EMAIL = 8;
const MAX_FAILS_PER_IP = 30;

export async function loginBlocked(email: string, ip: string): Promise<boolean> {
  const [row] = await db()`
    SELECT
      count(*) FILTER (WHERE email = ${email})::int AS by_email,
      count(*) FILTER (WHERE ip = ${ip})::int AS by_ip
    FROM login_attempts
    WHERE success = false AND created_at > now() - make_interval(mins => ${WINDOW_MINUTES})
      AND (email = ${email} OR ip = ${ip})
  `;
  return row.by_email >= MAX_FAILS_PER_EMAIL || row.by_ip >= MAX_FAILS_PER_IP;
}

export async function recordLoginAttempt(email: string, ip: string, success: boolean) {
  await db()`INSERT INTO login_attempts (email, ip, success) VALUES (${email}, ${ip}, ${success})`;
  if (success) {
    await db()`DELETE FROM login_attempts WHERE email = ${email} AND success = false`;
  }
  // Keep the table small.
  await db()`DELETE FROM login_attempts WHERE created_at < now() - interval '7 days'`;
}
