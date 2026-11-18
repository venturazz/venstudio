import { z } from "zod";
import type { HeartbeatResponse } from "@venstudio/protocol";
import { heartbeat } from "@/lib/server/jobs.ts";
import { isUuid, jsonError, parseJson, withWorker } from "@/lib/server/worker-api.ts";

const schema = z.object({
  progress: z.number().min(0).max(1).optional(),
  message: z.string().max(500).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return withWorker(req, async (worker) => {
    if (!isUuid(id)) return jsonError(404, "Unknown job");
    const input = await parseJson(req, schema);
    if (input instanceof Response) return input;
    const res = await heartbeat(id, worker.id, input.progress, input.message);
    if (!res) return jsonError(409, "Job is not running on this worker (lease lost or cancelled)");
    return Response.json(res satisfies HeartbeatResponse);
  });
}
