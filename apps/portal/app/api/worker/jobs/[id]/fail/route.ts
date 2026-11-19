import { z } from "zod";
import { failJob } from "@/lib/server/jobs.ts";
import { evaluateQcCompletion } from "@/lib/server/pipeline.ts";
import { isUuid, jsonError, parseJson, withWorker } from "@/lib/server/worker-api.ts";

const schema = z.object({
  error: z.string().min(1).max(4000),
  retryable: z.boolean(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withWorker(req, async (worker) => {
    if (!isUuid(id)) return jsonError(404, "Unknown job");
    const input = await parseJson(req, schema);
    if (input instanceof Response) return input;
    const ok = await failJob(id, worker.id, input.error, input.retryable);
    if (!ok) return jsonError(409, "Job is not running on this worker");
    await evaluateQcCompletion(id);
    return Response.json({ ok: true });
  });
}
