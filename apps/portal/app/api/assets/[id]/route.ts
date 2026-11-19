import { getSession } from "@/lib/server/auth.ts";
import { getAssetRow } from "@/lib/server/assets.ts";
import { serveStored } from "@/lib/server/serve.ts";
import { isUuid, jsonError } from "@/lib/server/worker-api.ts";

/** Preview or download an asset. Any signed-in user can read the library. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.mfaPending) return jsonError(401, "Sign in required");
  const { id } = await ctx.params;
  if (!isUuid(id)) return jsonError(404, "Not found");
  const a = await getAssetRow(id);
  if (!a?.storage_path) return jsonError(404, "Not found");
  const download = new URL(req.url).searchParams.get("download") === "1";
  return serveStored(
    req,
    {
      storage_path: a.storage_path,
      content_type: a.content_type ?? "application/octet-stream",
      bytes: a.bytes,
      sha256: a.sha256,
    },
    download,
  );
}
