import "server-only";
import { createHash } from "node:crypto";
import { db } from "./db.ts";
import { renderInstallFile } from "./install-files.ts";
import { privateSigningKey } from "./update-key.ts";
import {
  UPDATE_FILE_NAMES,
  UPDATE_MODES,
  buildManifest,
  decideOffer,
  parseWorkerVersion,
  releaseOf,
  signManifest,
  type ManifestFile,
  type OfferDecision,
  type ServedRelease,
  type SignedManifest,
  type UpdateMode,
  type WorkerUpdateReport,
} from "../update-manifest.ts";

/** What this portal serves at /install/: the worker file, the Remotion bundle and the style packs index, hashed exactly as served. */
export async function servedRelease(): Promise<ServedRelease> {
  const files: ManifestFile[] = [];
  let version: string | null = null;
  for (const name of UPDATE_FILE_NAMES) {
    const body = await renderInstallFile(name);
    if (body === null) throw new Error(`install file ${name} is missing`);
    if (name === "venstudio-worker.ts") version = parseWorkerVersion(body);
    files.push({ name, sha256: createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body) });
  }
  if (!version) throw new Error("the served worker file has no VERSION line");
  return { version, release: releaseOf(version, files), files };
}

export interface UpdateSettings {
  mode: UpdateMode;
  pinnedVersion: string | null;
}

export async function updateSettings(): Promise<UpdateSettings> {
  const rows = await db()`SELECT mode, pinned_version FROM worker_update_settings WHERE id = 'default'`;
  const r = rows.map((x) => ({ mode: String(x.mode), pinned: x.pinned_version == null ? null : String(x.pinned_version) }))[0];
  const mode = UPDATE_MODES.includes(r?.mode as UpdateMode) ? (r!.mode as UpdateMode) : "auto";
  return { mode, pinnedVersion: r?.pinned ?? null };
}

/**
 * Answers a worker's update check: records what it was offered and returns a signed manifest when the owner's mode
 * allows it. Never changes a worker's channel, mapping or anything but its update columns.
 */
export async function updateOfferFor(
  workerId: string,
  report: WorkerUpdateReport & { keyId?: string },
): Promise<{ manifest: SignedManifest | null; decision: OfferDecision; served: ServedRelease }> {
  const sql = db();
  const [served, settings, rows] = await Promise.all([
    servedRelease(),
    updateSettings(),
    sql`SELECT update_approved_release FROM workers WHERE id = ${workerId}`,
  ]);
  const approved = rows.map((r) => (r.update_approved_release == null ? null : String(r.update_approved_release)))[0] ?? null;
  const decision = decideOffer({ mode: settings.mode, approvedRelease: approved, served, worker: report });
  await sql`
    UPDATE workers SET update_checked_at = now(),
      update_offered_version = ${decision.pending ? served.version : null},
      update_offered_release = ${decision.pending ? served.release : null},
      update_key_id = ${report.keyId ?? null}
    WHERE id = ${workerId}
  `;
  if (!decision.offer) return { manifest: null, decision, served };
  const key = await privateSigningKey();
  const manifest = signManifest(
    buildManifest({ keyId: key.keyId, workerId, served, pinnedVersion: settings.pinnedVersion, now: new Date(), worker: report }),
    key.privateKey,
  );
  return { manifest, decision, served };
}
