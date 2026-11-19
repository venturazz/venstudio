import "server-only";
import path from "node:path";
import { Readable } from "node:stream";
import { parseRange } from "../range.ts";
import { openStored } from "./storage.ts";

export interface StoredFile {
  storage_path: string;
  content_type: string;
  bytes: number | string | null;
  sha256: string | null;
}

/**
 * Serves a stored file with HTTP Range support (browsers need it to stream and seek video; Safari won't play
 * without it). The caller has already checked who may read the file.
 */
export async function serveStored(
  req: Request,
  file: StoredFile,
  download: boolean,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const size = Number(file.bytes ?? 0);
  const name = path.basename(file.storage_path).replace(/[^A-Za-z0-9._-]/g, "_");
  const base: Record<string, string> = {
    "content-type": file.content_type,
    "content-disposition": `${download ? "attachment" : "inline"}; filename="${name}"`,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  };
  if (file.sha256) base.etag = `"${file.sha256}"`;

  if (file.sha256 && req.headers.get("if-none-match") === base.etag) {
    return new Response(null, { status: 304, headers: base });
  }
  const range = parseRange(req.headers.get("range"), size);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  }
  if (range) {
    const { stream } = await openStored(file.storage_path, range);
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        ...base,
        "content-range": `bytes ${range.start}-${range.end}/${size}`,
        "content-length": String(range.end - range.start + 1),
      },
    });
  }
  const { stream } = await openStored(file.storage_path);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { ...base, "content-length": String(size) },
  });
}
