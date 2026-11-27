import { createHash } from "node:crypto";

/**
 * Canonical JSON: keys sorted at every level, no whitespace, undefined dropped. Two payloads that mean the same thing
 * hash the same, which is what makes a freeze worth recording — a re-render of the same run must produce the same bytes.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

/** The fingerprint of a render payload: exactly what was sent, so the video can be re-rendered and compared. */
export function payloadSha256(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** Twelve hex is enough to tell two payloads apart in a card, and short enough to read out loud. */
export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/**
 * What a run was drawn from: the payload's hash and the pack version that drew it. The page itself is the pack's own
 * bundle, so the pack version names it; a run whose story was composed also froze its parts inside the payload, which
 * the hash covers.
 */
export interface FrozenRender {
  sha256: string;
  short: string;
  /** The style pack that drew it, id@version. Absent for a run without a pack. */
  pack?: string;
}

export function frozenRender(payload: unknown, pack: { id: string; version: string } | null): FrozenRender {
  const sha256 = payloadSha256(payload);
  return { sha256, short: shortSha(sha256), ...(pack ? { pack: `${pack.id}@${pack.version}` } : {}) };
}