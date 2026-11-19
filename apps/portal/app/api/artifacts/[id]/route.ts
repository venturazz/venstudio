import { Readable } from "node:stream";
import { getSession } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { openArtifact, parseRange } from "@/lib/server/storage.ts";
import { isUuid, jsonError } from "@/lib/server/worker-api.ts";

/**
 * Download or stream an artifact. Signed-in users only.
 * Supports HTTP Range requests, which browsers need to stream and seek video (Safari won't play without them).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.mfaPending) return jsonError(401, "Sign in required");
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError(404, "Not found");
  const [a] = await db()`SELECT name, content_type, bytes, sha256, storage_path FROM artifacts WHERE id = ${id}`;
  if (!a) return jsonError(404, "Not found");

  const size = Number(a.bytes);
  const download = new URL(req.url).searchParams.get("download") === "1";
  const safeName = String(a.name).replace(/[^A-Za-z0-9._-]/g, "_");
  const base: Record<string, string> = {
    "content-type": a.content_type,
    "content-disposition": `${download ? "attachment" : "inline"}; filename="${safeName}"`,
    "accept-ranges": "bytes",
    // Artifacts never change once uploaded (same name -> new upload replaces the row), so the hash is a strong ETag.
    etag: `"${a.sha256}"`,
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
  };

  if (req.headers.get("if-none-match") === base.etag) return new Response(null, { status: 304, headers: base });

  const range = parseRange(req.headers.get("range"), size);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  }
  if (range) {
    const { stream } = await openArtifact(a.storage_path, range);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        ...base,
        "content-range": `bytes ${range.start}-${range.end}/${size}`,
        "content-length": String(range.end - range.start + 1),
      },
    });
  }
  const { stream } = await openArtifact(a.storage_path);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { ...base, "content-length": String(size) },
  });
}
