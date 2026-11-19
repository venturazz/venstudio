import { getSession } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { serveStored } from "@/lib/server/serve.ts";
import { isUuid, jsonError } from "@/lib/server/worker-api.ts";

/** Download or stream a worker output. Signed-in users only. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.mfaPending) return jsonError(401, "Sign in required");
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError(404, "Not found");
  const [a] = await db()`SELECT content_type, bytes, sha256, storage_path FROM artifacts WHERE id = ${id}`;
  if (!a) return jsonError(404, "Not found");
  const download = new URL(req.url).searchParams.get("download") === "1";
  return serveStored(req, a as Parameters<typeof serveStored>[1], download);
}
