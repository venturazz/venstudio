import "server-only";
import { WORKER_VERSION } from "@venstudio/protocol";
import { db } from "./db.ts";
import { HOME_WORKER_GRACE_MINUTES, URGENT_PRIORITY } from "./jobs.ts";
import { queueReasons, type WorkerForReasons } from "../queue-reasons.ts";

/** Loads a job and the workers, then explains why it is still queued. */
export async function explainQueuedJob(jobId: string): Promise<string[]> {
  const sql = db();
  const [job] = await sql`
    SELECT type, capability, status, priority, preferred_worker_id, created_at, run_after FROM jobs WHERE id = ${jobId}
  `;
  if (!job) return [];
  const rows = await sql`
    SELECT id, name, status, version, capabilities, job_types, last_claim_at FROM workers WHERE status <> 'revoked' ORDER BY name
  `;
  const workers: WorkerForReasons[] = rows.map((w) => ({
    id: w.id as string,
    name: w.name as string,
    status: w.status as string,
    version: (w.version as string | null) ?? null,
    capabilities: (w.capabilities as string[]) ?? [],
    jobTypes: (w.job_types as string[]) ?? [],
    lastClaimAt: w.last_claim_at ? new Date(w.last_claim_at as string) : null,
  }));
  return queueReasons(
    {
      type: job.type,
      capability: job.capability,
      status: job.status,
      priority: Number(job.priority),
      preferredWorkerId: job.preferred_worker_id ?? null,
      createdAt: new Date(job.created_at),
      runAfter: new Date(job.run_after),
    },
    workers,
    {
      now: new Date(),
      latestVersion: WORKER_VERSION,
      graceMinutes: HOME_WORKER_GRACE_MINUTES,
      urgentPriority: URGENT_PRIORITY,
      legacyJobTypes: ["echo", "smoke-test"],
    },
  );
}
