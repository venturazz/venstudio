import "server-only";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "./env.ts";

/**
 * Local-disk artifact storage (phase 1). The interface is small on purpose so it can be swapped
 * for S3/R2 presigned uploads later without touching the worker API shape.
 */

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSafeArtifactName(name: string) {
  return NAME_RE.test(name) && !name.includes("..");
}

function artifactPath(jobId: string, name: string) {
  if (!UUID_RE.test(jobId) || !isSafeArtifactName(name)) throw new Error("Invalid artifact path");
  const root = path.resolve(env().ARTIFACT_DIR);
  const full = path.resolve(root, jobId, name);
  if (!full.startsWith(root + path.sep)) throw new Error("Invalid artifact path");
  return full;
}

export class TooLargeError extends Error {}

export async function saveArtifact(jobId: string, name: string, body: ReadableStream<Uint8Array>) {
  const full = artifactPath(jobId, name);
  await mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.upload-${process.pid}-${Date.now()}`;
  const limit = env().MAX_ARTIFACT_MB * 1024 * 1024;
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > limit) return cb(new TooLargeError(`Artifact exceeds ${env().MAX_ARTIFACT_MB} MB`));
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

export async function openArtifact(storagePath: string, range?: { start: number; end: number }) {
  const root = path.resolve(env().ARTIFACT_DIR);
  const full = path.resolve(storagePath);
  if (!full.startsWith(root + path.sep)) throw new Error("Invalid artifact path");
  const info = await stat(full);
  return { size: info.size, stream: createReadStream(full, range ? { start: range.start, end: range.end } : undefined) };
}

export { parseRange } from "../range.ts";

export function contentTypeFor(name: string, declared: string | null) {
  const ext = path.extname(name).toLowerCase();
  const known: Record<string, string> = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".json": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
  };
  return known[ext] ?? (declared && /^[\w.+-]+\/[\w.+-]+$/.test(declared) ? declared : "application/octet-stream");
}
