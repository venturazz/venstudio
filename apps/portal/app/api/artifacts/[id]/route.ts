import { Readable } from "node:stream";
import { getSession } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { openArtifact } from "@/lib/server/storage.ts";
import { isUuid, jsonError } from "@/lib/server/worker-api.ts";

/** Download or stream an artifact. Signed-in users only. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.mfaPending) return jsonError(401, "Sign in required");
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError(404, "Not found");
  const [a] = await db()`SELECT name, content_type, storage_path FROM artifacts WHERE id = ${id}`;
  if (!a) return jsonError(404, "Not found");

  const { size, stream } = await openArtifact(a.storage_path);
  const download = new URL(req.url).searchParams.get("download") === "1";
  const safeName = String(a.name).replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "content-type": a.content_type,
      "content-length": String(size),
      "content-disposition": `${download ? "attachment" : "inline"}; filename="${safeName}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
