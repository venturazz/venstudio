import { z } from "zod";
import type { ClaimResponse } from "@venstudio/protocol";
import { db } from "@/lib/server/db.ts";
import { claimJob } from "@/lib/server/jobs.ts";
import { sanitizeCapabilities } from "@/lib/server/workers.ts";
import { parseJson, withWorker } from "@/lib/server/worker-api.ts";

export const dynamic = "force-dynamic";
// Long-poll requests stay open up to MAX_WAIT_SECONDS.
export const maxDuration = 60;

const MAX_WAIT_SECONDS = 25;
const POLL_MS = 1500;

const schema = z.object({
  capabilities: z.array(z.string()).max(20),
  mode: z.enum(["tick", "hold", "daemon"]),
  version: z.string().max(40),
  waitSeconds: z.number().int().min(0).max(300).optional(),
  jobTypes: z.array(z.string().max(40)).max(20).optional(),
});

/** Workers released before job types were sent can only run these. */
const LEGACY_JOB_TYPES = ["echo", "smoke-test"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: Request) {
  return withWorker(req, async (worker) => {
    const input = await parseJson(req, schema);
    if (input instanceof Response) return input;
    const capabilities = sanitizeCapabilities(input.capabilities);
    const sql = db();
    await sql`
      UPDATE workers SET capabilities = ${capabilities}::text[], mode = ${input.mode}, version = ${input.version},
        last_claim_at = now()
      WHERE id = ${worker.id}
    `;
    // Draining workers finish what they have but get nothing new.
    if (worker.status !== "active") return new Response(null, { status: 204 });

    const waitMs = Math.min(input.waitSeconds ?? 0, MAX_WAIT_SECONDS) * 1000;
    const until = Date.now() + waitMs;
    let touched = Date.now();
    for (;;) {
      const job = await claimJob(worker.id, capabilities, input.jobTypes ?? LEGACY_JOB_TYPES);
      if (job) return Response.json({ job } satisfies ClaimResponse, { headers: { "cache-control": "no-store" } });
      if (Date.now() + POLL_MS > until || req.signal.aborted) break;
      await sleep(POLL_MS);
      // Stop waiting if the worker was drained or revoked meanwhile.
      const [w] = await sql`SELECT status FROM workers WHERE id = ${worker.id}`;
      if (!w || w.status !== "active") break;
      if (Date.now() - touched > 15_000) {
        touched = Date.now();
        await sql`UPDATE workers SET last_seen_at = now(), last_claim_at = now() WHERE id = ${worker.id}`;
      }
    }
    return new Response(null, { status: 204 });
  });
}
