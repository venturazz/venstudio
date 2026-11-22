import { after } from "next/server";
import { z } from "zod";
import type { ClaimResponse } from "@venstudio/protocol";
import { db } from "@/lib/server/db.ts";
import { claimJob } from "@/lib/server/jobs.ts";
import { sanitizeCapabilities } from "@/lib/server/workers.ts";
import { parseJson, withWorker } from "@/lib/server/worker-api.ts";
import { nudgeRecovery } from "@/lib/server/director.ts";

export const dynamic = "force-dynamic";
// Long-poll requests stay open up to MAX_WAIT_SECONDS.
export const maxDuration = 60;

const MAX_WAIT_SECONDS = 25;
const POLL_MS = 1500;

const schema = z.object({
  capabilities: z.array(z.string().max(80)).max(100),
  mode: z.enum(["tick", "hold", "daemon"]),
  version: z.string().max(40),
  waitSeconds: z.number().int().min(0).max(300).optional(),
  jobTypes: z.array(z.string().max(40)).max(20).optional(),
  // Worker 0.12.0+: how each environment its packs need stands (installing, ready after its probe, failed with why).
  environments: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
        version: z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/),
        status: z.enum(["installing", "ready", "failed"]),
        detail: z.string().max(500),
        packs: z.array(z.string().max(80)).max(20),
        at: z.string().max(40),
      }),
    )
    .max(50)
    .optional(),
});

/** Workers released before job types were sent can only run these. */
const LEGACY_JOB_TYPES = ["echo", "smoke-test"];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: Request) {
  return withWorker(req, async (worker) => {
    const input = await parseJson(req, schema);
    if (input instanceof Response) return input;
    const capabilities = sanitizeCapabilities(input.capabilities);
    const jobTypes = input.jobTypes ?? LEGACY_JOB_TYPES;
    // A worker before 0.12.0 sends no environments: stored as an empty list, so nothing stale is shown for it.
    const environments = JSON.stringify((input.environments ?? []).map((e) => ({ ...e, detail: e.detail.slice(0, 300) })));
    const sql = db();
    await sql`
      UPDATE workers SET capabilities = ${capabilities}::text[], mode = ${input.mode}, version = ${input.version},
        job_types = ${jobTypes}::text[], environments = ${environments}::jsonb, last_claim_at = now()
      WHERE id = ${worker.id}
    `;
    // Workers in hold mode call here every ~25 s, so this is the studio's heartbeat when no page is open: it resumes
    // stages whose wait for Hermes is over and repairs stuck work. Throttled to one pass a minute, after the response.
    after(() => nudgeRecovery());
    // Draining workers finish what they have but get nothing new.
    if (worker.status !== "active") return new Response(null, { status: 204 });

    const waitMs = Math.min(input.waitSeconds ?? 0, MAX_WAIT_SECONDS) * 1000;
    const until = Date.now() + waitMs;
    let touched = Date.now();
    for (;;) {
      const job = await claimJob(worker.id, capabilities, jobTypes);
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
