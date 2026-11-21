/**
 * Signed worker updates: the manifest, its canonical form, its signature and the owner's update mode. Pure (node:crypto
 * only), so unit tests and the e2e proxy can import it. See docs/worker-updates.md.
 *
 * The worker is one file with no imports, so it carries its own copy of `canonicalJson`, `updateKeyId`,
 * `compareVersions` and the verification; apps/worker/venstudio-worker.test.ts checks both copies agree byte for byte.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

export const MANIFEST_FORMAT = 1;
/** Prefix of the signed bytes, so a signature over a manifest can never be read as a signature over anything else. */
export const MANIFEST_CONTEXT = "venstudio-update-manifest-v1\n";
/** A manifest is valid this long after it is signed. Short, so an old manifest cannot be replayed later. */
export const MANIFEST_LIFETIME_SECONDS = 600;
/** The files a manifest can name, in this order. Both are served from /install/ (lib/server/install-files.ts). */
export const UPDATE_FILE_NAMES = ["venstudio-worker.ts", "render-remotion.json"] as const;
export type UpdateFileName = (typeof UPDATE_FILE_NAMES)[number];

export type UpdateMode = "auto" | "approve" | "off";
export const UPDATE_MODES: readonly UpdateMode[] = ["auto", "approve", "off"];
export const UPDATE_MODE_LABEL: Record<UpdateMode, string> = {
  auto: "Automatic",
  approve: "Approve each update",
  off: "Off (manual only)",
};

/** Results a worker reports after it acted on a manifest. */
export type UpdateResult = "ok" | "refused" | "rolled_back" | "failed";
export const UPDATE_RESULTS: readonly UpdateResult[] = ["ok", "refused", "rolled_back", "failed"];

export interface ManifestFile {
  name: UpdateFileName;
  sha256: string;
  bytes: number;
}

export interface UnsignedManifest {
  format: typeof MANIFEST_FORMAT;
  /** Id of the key that signed it (first 16 hex of the SHA-256 of the public key). */
  keyId: string;
  /** The worker this manifest is for: a manifest fetched by one worker is refused by every other. */
  workerId: string;
  /** Worker version in the served venstudio-worker.ts. */
  version: string;
  /** True only when the owner pinned exactly this version: the worker then accepts it even when it is older. */
  pin: boolean;
  /** Version plus a short hash of the files; what the owner approves in "Approve each update" mode. */
  release: string;
  issuedAt: string;
  expiresAt: string;
  files: ManifestFile[];
}

export interface SignedManifest extends UnsignedManifest {
  /** Ed25519 over MANIFEST_CONTEXT + canonicalJson(the manifest without this field), base64. */
  signature: string;
}

/**
 * Canonical JSON: object keys sorted (by UTF-16 code unit, as Array.prototype.sort does), no whitespace, undefined
 * object members dropped. Strings and numbers use JSON.stringify. Throws on values JSON cannot carry exactly.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("canonicalJson: numbers must be finite");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
      const rec = value as Record<string, unknown>;
      const keys = Object.keys(rec)
        .filter((k) => rec[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`).join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: cannot encode ${typeof value}`);
  }
}

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/** Key id: the first 16 hex characters of the SHA-256 of the public key (SPKI DER). */
export function updateKeyId(publicKeySpkiB64: string): string {
  return sha256Hex(Buffer.from(publicKeySpkiB64, "base64")).slice(0, 16);
}

export interface SigningKeyPair {
  keyId: string;
  /** SPKI DER, base64. Public; install.sh carries it. */
  publicKey: string;
  /** PKCS#8 DER, base64. Secret; stored encrypted. */
  privateKey: string;
}

export function newSigningKey(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const priv = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  return { keyId: updateKeyId(pub), publicKey: pub, privateKey: priv };
}

/** The AAD the private key is encrypted under, so the ciphertext cannot be moved to another row or purpose. */
export const signingKeyAad = (keyId: string) => `update-signing-key:${keyId}`;

/** The bytes that are signed. */
export function signingInput(m: UnsignedManifest): Buffer {
  const { signature: _drop, ...rest } = m as UnsignedManifest & { signature?: string };
  return Buffer.from(MANIFEST_CONTEXT + canonicalJson(rest), "utf8");
}

export function signManifest(m: UnsignedManifest, privateKeyPkcs8B64: string): SignedManifest {
  const key = createPrivateKey({ key: Buffer.from(privateKeyPkcs8B64, "base64"), format: "der", type: "pkcs8" });
  const signature = sign(null, signingInput(m), key).toString("base64");
  return { ...m, signature };
}

/** True when `m` carries a valid signature by this public key. Used by tests; the worker has its own copy. */
export function verifyManifestSignature(m: SignedManifest, publicKeySpkiB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpkiB64, "base64"), format: "der", type: "spki" });
    return verify(null, signingInput(m), key, Buffer.from(m.signature, "base64"));
  } catch {
    return false;
  }
}

/** Compares dotted numeric versions ("0.8.0" < "0.10.0"). NaN when either is not of that form. */
export function compareVersions(a: string, b: string): number {
  const re = /^\d{1,6}(\.\d{1,6}){0,3}$/;
  if (!re.test(a) || !re.test(b)) return Number.NaN;
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The VERSION constant of a worker source file, or null. */
export function parseWorkerVersion(source: string): string | null {
  return /^export const VERSION = "(\d{1,6}(?:\.\d{1,6}){0,3})";$/m.exec(source)?.[1] ?? null;
}

/** Version plus the first 8 hex of the hash of the file list: changes whenever any served file changes. */
export function releaseOf(version: string, files: readonly ManifestFile[]): string {
  return `${version}+${sha256Hex(canonicalJson(files)).slice(0, 8)}`;
}

export interface ServedRelease {
  version: string;
  release: string;
  files: ManifestFile[];
}

/**
 * What a worker reports when it asks for an update: its version, and the SHA-256 of each file it has. The worker file
 * is always reported; the Remotion bundle is null when this worker has no Remotion project installed (it is never
 * installed by an update), or "unknown" when the project exists but predates the bundle marker.
 */
export interface WorkerUpdateReport {
  version: string;
  files?: Partial<Record<UpdateFileName, string | null>>;
}

/** Names of the served files this worker does not have. */
export function pendingFiles(served: ServedRelease, worker: WorkerUpdateReport): UpdateFileName[] {
  const out: UpdateFileName[] = [];
  for (const f of served.files) {
    const have = worker.files?.[f.name];
    if (f.name === "venstudio-worker.ts") {
      // Without a reported hash (should not happen from 0.8.0 on), compare versions.
      if (have ? have !== f.sha256 : worker.version !== served.version) out.push(f.name);
    } else if (have !== null && have !== undefined && have !== f.sha256) out.push(f.name);
  }
  return out;
}

export interface OfferDecision {
  /** The worker lacks a served file. Shown on the Workers page as "Update to v… available". */
  pending: boolean;
  /** A signed manifest is sent. */
  offer: boolean;
  reason: "current" | "off" | "awaiting-approval" | "approved" | "auto";
}

/**
 * Whether to send this worker a manifest. Off: never. Approve: only after the owner approved this exact release for
 * this worker. Automatic: whenever it lacks a served file. The worker still refuses anything older than itself
 * unless the manifest is pinned, so this decides what is offered, never what is trusted.
 */
export function decideOffer(input: {
  mode: UpdateMode;
  approvedRelease: string | null;
  served: ServedRelease;
  worker: WorkerUpdateReport;
}): OfferDecision {
  const pending = pendingFiles(input.served, input.worker).length > 0;
  if (!pending) return { pending, offer: false, reason: "current" };
  if (input.mode === "off") return { pending, offer: false, reason: "off" };
  if (input.mode === "approve") {
    return input.approvedRelease === input.served.release
      ? { pending, offer: true, reason: "approved" }
      : { pending, offer: false, reason: "awaiting-approval" };
  }
  return { pending, offer: true, reason: "auto" };
}

export function buildManifest(input: {
  keyId: string;
  workerId: string;
  served: ServedRelease;
  /** The version the owner pinned, if any. Pins only when it equals the served version. */
  pinnedVersion: string | null;
  now: Date;
}): UnsignedManifest {
  return {
    format: MANIFEST_FORMAT,
    keyId: input.keyId,
    workerId: input.workerId,
    version: input.served.version,
    pin: input.pinnedVersion !== null && input.pinnedVersion === input.served.version,
    release: input.served.release,
    issuedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + MANIFEST_LIFETIME_SECONDS * 1000).toISOString(),
    files: input.served.files.map((f) => ({ name: f.name, sha256: f.sha256, bytes: f.bytes })),
  };
}

/** One line for the Workers page about a worker's last update result. */
export function describeUpdateResult(status: string | null, detail: string | null, version: string | null): string | null {
  if (!status) return null;
  const v = version ? `v${version}` : "the update";
  switch (status) {
    case "ok":
      return `Updated to ${v}.`;
    case "refused":
      return `Refused ${v}: ${detail ?? "no reason given"}`;
    case "rolled_back":
      return `Rolled back from ${v}: ${detail ?? "no reason given"}`;
    case "failed":
      return `Update to ${v} failed: ${detail ?? "no reason given"}`;
    default:
      return null;
  }
}
