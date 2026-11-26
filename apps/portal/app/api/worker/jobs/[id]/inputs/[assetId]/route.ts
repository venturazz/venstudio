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
    // The qc job also names the approved stills of its own run, to check the finished video against them.
    const compare = Array.isArray(job.payload?.compareStills) ? (job.payload.compareStills as unknown[]) : [];
    const extra = new Set(
      compare.flatMap((raw) => {
        const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
        return typeof o.assetId === "string" && isUuid(o.assetId) ? [o.assetId] : [];
      }),
    );
    if (!inputs.includes(assetId) && !extra.has(assetId)) return jsonError(403, "That asset is not an input of this job");
    const a = await getAssetRow(assetId);
    if (a?.storage_path) {
      return serveStored(
        req,
        { storage_path: a.storage_path, content_type: "application/octet-stream", bytes: a.bytes, sha256: a.sha256 },
        false,
        { "x-sha256": a.sha256 ?? "" },
      );
    }
    // Not an asset: a preview still, which is an artifact. Only one of this job's own run, never any other.
    const [art] = await db()`
      SELECT a.storage_path, a.bytes, a.sha256
      FROM artifacts a JOIN jobs j ON j.id = a.job_id
      WHERE a.id = ${assetId}
        AND j.payload->>'runId' = (SELECT payload->>'runId' FROM jobs WHERE id = ${id})
      LIMIT 1`;
    if (!art?.storage_path) return jsonError(404, "Asset not found");
    return serveStored(
      req,
      { storage_path: art.storage_path as string, content_type: "application/octet-stream", bytes: art.bytes as number | null, sha256: art.sha256 as string | null },
      false,
      { "x-sha256": (art.sha256 as string | null) ?? "" },
    );
  });
}
