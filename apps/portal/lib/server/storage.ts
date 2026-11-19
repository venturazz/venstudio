import "server-only";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "./env.ts";

/**
 * Local-disk storage (phase 1). Two scopes share one root:
 *   <ARTIFACT_DIR>/<jobId>/<name>        worker outputs
 *   <ARTIFACT_DIR>/assets/<assetId>/<name>  asset library files
 * The interface is small so it can move to S3/R2 later without changing callers.
 */

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSafeArtifactName(name: string) {
  return NAME_RE.test(name) && !name.includes("..");
}

function scopeRoot(scope: "jobs" | "assets") {
  const root = path.resolve(env().ARTIFACT_DIR);
  return scope === "assets" ? path.join(root, "assets") : root;
}

function safePath(scope: "jobs" | "assets", id: string, name: string) {
  if (!UUID_RE.test(id) || !isSafeArtifactName(name)) throw new Error("Invalid storage path");
  const root = scopeRoot(scope);
  const full = path.resolve(root, id, name);
  if (!full.startsWith(root + path.sep)) throw new Error("Invalid storage path");
  return full;
}

export class TooLargeError extends Error {}

async function writeBody(full: string, body: ReadableStream<Uint8Array>) {
  await mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.upload-${process.pid}-${Date.now()}`;
  const limitMb = env().MAX_ARTIFACT_MB;
  const limit = limitMb * 1024 * 1024;
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > limit) return cb(new TooLargeError(`File exceeds ${limitMb} MB`));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body as import("node:stream/web").ReadableStream), meter, createWriteStream(tmp));
    await rename(tmp, full);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return { storagePath: full, bytes, sha256: hash.digest("hex") };
}

export async function saveArtifact(jobId: string, name: string, body: ReadableStream<Uint8Array>) {
  return writeBody(safePath("jobs", jobId, name), body);
}

export async function saveAsset(assetId: string, name: string, body: ReadableStream<Uint8Array>) {
  return writeBody(safePath("assets", assetId, name), body);
}

/** Opens a stored file for reading. Only files under the artifact root can be opened. */
export async function openStored(storagePath: string, range?: { start: number; end: number }) {
  const root = path.resolve(env().ARTIFACT_DIR);
  const full = path.resolve(storagePath);
  if (!full.startsWith(root + path.sep)) throw new Error("Invalid storage path");
  const info = await stat(full);
  return { size: info.size, stream: createReadStream(full, range ? { start: range.start, end: range.end } : undefined) };
}

export function contentTypeFor(name: string, declared: string | null) {
  const ext = path.extname(name).toLowerCase();
  const known: Record<string, string> = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".json": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".glb": "model/gltf-binary",
  };
  return known[ext] ?? (declared && /^[\w.+-]+\/[\w.+-]+$/.test(declared) ? declared : "application/octet-stream");
}
