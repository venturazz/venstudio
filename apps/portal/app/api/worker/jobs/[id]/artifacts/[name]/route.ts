import type { ArtifactResponse } from "@venstudio/protocol";
import { db } from "@/lib/server/db.ts";
import { addJobEvent } from "@/lib/server/jobs.ts";
import { contentTypeFor, isSafeArtifactName, saveArtifact, TooLargeError } from "@/lib/server/storage.ts";
import { isUuid, jsonError, withWorker } from "@/lib/server/worker-api.ts";

export async function PUT(req: Request, ctx: { params: Promise<{ id: string; name: string }> }) {
  const { id, name } = await ctx.params;
  return withWorker(req, async (worker) => {
    if (!isUuid(id)) return jsonError(404, "Unknown job");
    if (!isSafeArtifactName(name)) return jsonError(400, "Invalid artifact name");
    if (!req.body) return jsonError(400, "Empty body");
    const [job] = await db()`SELECT id FROM jobs WHERE id = ${id} AND worker_id = ${worker.id} AND status = 'running'`;
    if (!job) return jsonError(409, "Job is not running on this worker");

    let saved;
    try {
      saved = await saveArtifact(id, name, req.body);
    } catch (err) {
      if (err instanceof TooLargeError) return jsonError(413, err.message);
      throw err;
    }
    const contentType = contentTypeFor(name, req.headers.get("content-type"));
    await db()`
      INSERT INTO artifacts (job_id, name, content_type, bytes, sha256, storage_path)
      VALUES (${id}, ${name}, ${contentType}, ${saved.bytes}, ${saved.sha256}, ${saved.storagePath})
      ON CONFLICT (job_id, name) DO UPDATE SET
        content_type = EXCLUDED.content_type, bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256,
        storage_path = EXCLUDED.storage_path, created_at = now()
    `;
    await addJobEvent(id, "info", `Uploaded ${name} (${(saved.bytes / 1024 / 1024).toFixed(2)} MB)`);
    return Response.json({ name, bytes: saved.bytes, sha256: saved.sha256 } satisfies ArtifactResponse);
  });
}
