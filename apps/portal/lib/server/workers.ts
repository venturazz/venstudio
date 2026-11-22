import "server-only";
import { CAPABILITIES, type Capability } from "@venstudio/protocol";
import { ENV_CAPABILITY_RE, PACK_CAPABILITY_RE, parseWorkerEnvironments, type WorkerEnvironment } from "../studio/style-registry.ts";
import { db } from "./db.ts";
import { enrollmentCode, normalizeCode, randomToken, sha256Hex } from "../crypto/tokens.ts";

export const ENROLLMENT_MINUTES = 30;

export interface AuthedWorker {
  id: string;
  name: string;
  status: "active" | "draining";
}

/** Authenticate a worker request by bearer token. Revoked workers have no token hash, so they fail here. */
export async function authenticateWorker(req: Request, ip: string): Promise<AuthedWorker | null> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(header);
  if (!m) return null;
  const rows = await db()`
    UPDATE workers SET last_seen_at = now(), last_ip = ${ip}
    WHERE token_hash = ${sha256Hex(m[1])} AND status <> 'revoked'
    RETURNING id, name, status
  `;
  return (rows[0] as AuthedWorker | undefined) ?? null;
}

/** Most capabilities a worker can report: the named ones plus one per installed style pack. */
export const MAX_REPORTED_CAPABILITIES = 100;

/** Known capabilities, plus pack:<id>@<version> for installed style packs (worker 0.9.0+); anything else is dropped. */
export function sanitizeCapabilities(input: unknown): Capability[] {
  if (!Array.isArray(input)) return [];
  const ok = (c: unknown): c is Capability => typeof c === "string" && (CAPABILITIES.includes(c as Capability) || PACK_CAPABILITY_RE.test(c) || ENV_CAPABILITY_RE.test(c));
  return [...new Set(input.filter(ok))].slice(0, MAX_REPORTED_CAPABILITIES);
}

export async function createEnrollmentCode(input: {
  label: string;
  host: "muse" | "vps" | "local";
  channelId: string | null;
  createdBy: string;
}) {
  const code = enrollmentCode();
  const expiresAt = new Date(Date.now() + ENROLLMENT_MINUTES * 60_000);
  await db()`
    INSERT INTO enrollment_codes (code_hash, label, host, channel_id, created_by, expires_at)
    VALUES (${sha256Hex(code)}, ${input.label}, ${input.host}, ${input.channelId}, ${input.createdBy}, ${expiresAt})
  `;
  return { code, expiresAt };
}

/**
 * Exchange a one-time enrollment code for a worker token.
 * The code is consumed atomically, so it can't be used twice even with concurrent requests.
 */
export async function enrollWorker(input: {
  code: string;
  name: string;
  capabilities: Capability[];
  version: string;
  ip: string;
}) {
  const sql = db();
  return sql.begin(async (tx) => {
    const [code] = await tx`
      UPDATE enrollment_codes SET used_at = now()
      WHERE code_hash = ${sha256Hex(normalizeCode(input.code))} AND used_at IS NULL AND expires_at > now()
      RETURNING id, label, host, channel_id
    `;
    if (!code) return null;
    const token = randomToken(32);
    const name = (input.name.trim() || code.label).slice(0, 80);
    const [worker] = await tx`
      INSERT INTO workers (name, host, token_hash, capabilities, version, last_seen_at, last_ip)
      VALUES (${name}, ${code.host}, ${sha256Hex(token)}, ${input.capabilities}::text[], ${input.version.slice(0, 40)},
              now(), ${input.ip})
      RETURNING id
    `;
    await tx`UPDATE enrollment_codes SET worker_id = ${worker.id} WHERE id = ${code.id}`;
    if (code.channel_id) {
      await tx`UPDATE channels SET home_worker_id = ${worker.id}, updated_at = now() WHERE id = ${code.channel_id}`;
    }
    await tx`
      INSERT INTO audit_log (worker_id, action, target, ip)
      VALUES (${worker.id}, 'worker.enrolled', ${name}, ${input.ip})
    `;
    return { workerId: worker.id as string, token };
  });
}

export type Presence = "working" | "online" | "sleeping" | "offline" | "never";

/**
 * Presence from last contact. Muse workers in tick mode only wake hourly, so "sleeping"
 * (seen within ~75 min) is healthy for them.
 */
export function presence(lastSeen: Date | string | null, running: number): Presence {
  if (!lastSeen) return "never";
  const ageMin = (Date.now() - new Date(lastSeen).getTime()) / 60_000;
  if (ageMin < 2) return running > 0 ? "working" : "online";
  if (ageMin < 75) return "sleeping";
  return "offline";
}

/** Message the owner sends to a Muse agent (app or WhatsApp) to run the worker right away. */
export const RUN_NOW_MESSAGE =
  "Run /home/hatch/venstudio/run.sh tick and wait until it exits. Then send me the last 5 lines of " +
  "/home/hatch/venstudio/logs/worker.log, and tell me whether the hourly \"VenStudio worker\" scheduled task exists and is active.";

/** A Muse worker needs a person when it has missed its hourly runs, or jobs are waiting for it. */
export function needsAttention(w: { host: string; status: string }, p: Presence, waitingJobs: number) {
  if (w.status !== "active" || w.host !== "muse") return false;
  return p === "offline" || p === "never" || (waitingJobs > 0 && p === "sleeping");
}

/** Capabilities any enrolled, not revoked worker reports, from the stored rows (no call to a worker). */
export async function reportedCapabilities(): Promise<string[]> {
  const rows = await db()`SELECT DISTINCT unnest(capabilities) AS cap FROM workers WHERE status <> 'revoked'`;
  return rows.map((r) => String(r.cap)).filter(Boolean);
}

/**
 * Every non-revoked worker's name, capabilities and reported environments (workers.environments, worker 0.12.0+), for
 * the availability lines on Styles and New Video. Read from stored rows only; no worker is called.
 */
export async function workerEnvironmentRows(): Promise<Array<{ name: string; capabilities: string[]; environments: WorkerEnvironment[] }>> {
  const rows = await db()`SELECT name, capabilities, environments FROM workers WHERE status <> 'revoked' ORDER BY name`;
  return rows.map((r) => ({
    name: String(r.name),
    capabilities: Array.isArray(r.capabilities) ? (r.capabilities as unknown[]).map(String) : [],
    environments: parseWorkerEnvironments(r.environments),
  }));
}
