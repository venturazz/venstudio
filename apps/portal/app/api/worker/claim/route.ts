import { z } from "zod";
import type { ClaimResponse } from "@venstudio/protocol";
import { db } from "@/lib/server/db.ts";
import { claimJob } from "@/lib/server/jobs.ts";
import { sanitizeCapabilities } from "@/lib/server/workers.ts";
import { parseJson, withWorker } from "@/lib/server/worker-api.ts";

const schema = z.object({
  capabilities: z.array(z.string()).max(20),
  mode: z.enum(["tick", "daemon"]),
  version: z.string().max(40),
});

export async function POST(req: Request) {
  return withWorker(req, async (worker) => {
    const input = await parseJson(req, schema);
    if (input instanceof Response) return input;
    const capabilities = sanitizeCapabilities(input.capabilities);
    await db()`
      UPDATE workers SET capabilities = ${capabilities}::text[], mode = ${input.mode}, version = ${input.version}
      WHERE id = ${worker.id}
    `;
    // Draining workers finish what they have but get nothing new.
    if (worker.status !== "active") return new Response(null, { status: 204 });
    const job = await claimJob(worker.id, capabilities);
    if (!job) return new Response(null, { status: 204 });
    return Response.json({ job } satisfies ClaimResponse, { headers: { "cache-control": "no-store" } });
  });
}
