import { after } from "next/server";
import { z } from "zod";
import { completeJob } from "@/lib/server/jobs.ts";
import { advanceRun } from "@/lib/server/director.ts";
import { evaluateQcCompletion } from "@/lib/server/pipeline.ts";
import { onJobFinished } from "@/lib/server/production.ts";
import { isUuid, jsonError, parseJson, withWorker } from "@/lib/server/worker-api.ts";

const schema = z.object({
  result: z.record(z.string(), z.unknown()).optional(),
  message: z.string().max(500).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withWorker(req, async (worker) => {
    if (!isUuid(id)) return jsonError(404, "Unknown job");
    const input = await parseJson(req, schema);
    if (input instanceof Response) return input;
    const ok = await completeJob(id, worker.id, input.result ?? {}, input.message);
    if (!ok) return jsonError(409, "Job is not running on this worker");
    await evaluateQcCompletion(id);
    // A job that belongs to a pipeline run advances the run's production stage. Never throws.
    const runId = await onJobFinished(id);
    if (runId) after(() => advanceRun(runId));
    return Response.json({ ok: true });
  });
}
