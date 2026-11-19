import { db } from "@/lib/server/db.ts";
import { getAssetRow } from "@/lib/server/assets.ts";
import { serveStored } from "@/lib/server/serve.ts";
import { isUuid, jsonError, withWorker } from "@/lib/server/worker-api.ts";

/**
 * A worker downloads an input asset of its own running job, and nothing else.
 * The job's payload lists the allowed asset ids; the response carries the file's SHA-256 so the worker can verify it.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; assetId: string }> }) {
  const { id, assetId } = await ctx.params;
  return withWorker(req, async (worker) => {
    if (!isUuid(id) || !isUuid(assetId)) return jsonError(404, "Not found");
    const [job] = await db()`SELECT payload FROM jobs WHERE id = ${id} AND worker_id = ${worker.id} AND status = 'running'`;
    if (!job) return jsonError(409, "Job is not running on this worker");
    const inputs = Array.isArray(job.payload?.inputs) ? (job.payload.inputs as unknown[]) : [];
    if (!inputs.includes(assetId)) return jsonError(403, "That asset is not an input of this job");
    const a = await getAssetRow(assetId);
    if (!a?.storage_path) return jsonError(404, "Asset not found");
    return serveStored(
      req,
      { storage_path: a.storage_path, content_type: "application/octet-stream", bytes: a.bytes, sha256: a.sha256 },
      false,
      { "x-sha256": a.sha256 ?? "" },
    );
  });
}
