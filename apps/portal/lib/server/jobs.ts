import "server-only";
import type { Capability, ClaimedJob, JobType } from "@venstudio/protocol";
import { db } from "./db.ts";

/** Lease length. A worker must heartbeat within this window or the job is requeued. */
export const LEASE_SECONDS = 120;
export const HEARTBEAT_SECONDS = 30;
/**
 * A job for a channel waits this long for the channel's home worker before any idle worker may take it.
 * Hourly Muse wakes + margin.
 */
export const HOME_WORKER_GRACE_MINUTES = 75;
/** Jobs at or above this priority skip the home-worker wait: the first free worker takes them. */
export const URGENT_PRIORITY = 10;

export const JOB_TYPES: Record<JobType, { capability: Capability; label: string; description: string }> = {
  echo: {
    capability: "echo",
    label: "Echo (connectivity test)",
    description: "Worker reports back its environment. Needs nothing installed.",
  },
  "smoke-test": {
    capability: "ffmpeg",
    label: "Render smoke test",
    description: "Renders a 5-second 1080x1920 test clip with ffmpeg and uploads it. Measures render speed.",
  },
  "analyze-video": {
    capability: "ffmpeg",
    label: "Analyze reference video",
    description: "Finds cuts, pacing, hook timing and loudness. Study only: nothing from the video is copied.",
  },
};

export async function createJob(input: {
  type: JobType;
  payload?: Record<string, unknown>;
  channelId?: string | null;
  priority?: number;
  createdBy: string;
}) {
  const def = JOB_TYPES[input.type];
  const sql = db();
  const [job] = await sql`
    INSERT INTO jobs (type, capability, payload, channel_id, preferred_worker_id, priority, created_by)
    VALUES (
      ${input.type}, ${def.capability}, ${JSON.stringify(input.payload ?? {})}::text::jsonb,
      ${input.channelId ?? null},
      (SELECT home_worker_id FROM channels WHERE id = ${input.channelId ?? null}),
      ${input.priority ?? 0}, ${input.createdBy}
    )
    RETURNING id
  `;
  await addJobEvent(job.id, "info", `Job created (${input.type})`);
  return job.id as string;
}

export async function addJobEvent(jobId: string, level: "info" | "warn" | "error", message: string) {
  await db()`INSERT INTO job_events (job_id, level, message) VALUES (${jobId}, ${level}, ${message.slice(0, 2000)})`;
}

/**
 * Requeue (or fail) running jobs whose lease expired. Cheap; called on every claim and dashboard load,
 * so no separate scheduler process is needed.
 */
export async function reapExpiredLeases() {
  const sql = db();
  const rows = await sql`
    UPDATE jobs SET
      status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'queued' END,
      error = CASE WHEN attempts >= max_attempts THEN 'Worker stopped responding (lease expired)' ELSE error END,
      finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
      worker_id = NULL,
      lease_expires_at = NULL
    WHERE status = 'running' AND lease_expires_at < now()
    RETURNING id, status
  `;
  for (const r of rows) {
    await addJobEvent(r.id, "warn", r.status === "failed" ? "Lease expired; out of attempts" : "Lease expired; requeued");
  }
  return rows.length;
}

export async function claimJob(workerId: string, capabilities: Capability[]): Promise<ClaimedJob | null> {
  await reapExpiredLeases();
  const sql = db();
  const rows = await sql.begin(async (tx) => {
    return tx`
      WITH next AS (
        SELECT j.id FROM jobs j
        WHERE j.status = 'queued'
          AND j.run_after <= now()
          AND j.capability = ANY(${capabilities}::text[])
          AND (
            j.preferred_worker_id IS NULL
            OR j.preferred_worker_id = ${workerId}
            OR j.priority >= ${URGENT_PRIORITY}
            OR j.created_at < now() - make_interval(mins => ${HOME_WORKER_GRACE_MINUTES})
            OR NOT EXISTS (SELECT 1 FROM workers w WHERE w.id = j.preferred_worker_id AND w.status = 'active')
          )
        ORDER BY (j.priority >= ${URGENT_PRIORITY}) DESC, (j.preferred_worker_id = ${workerId}) DESC NULLS LAST,
                 j.priority DESC, j.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE jobs SET
        status = 'running',
        worker_id = ${workerId},
        attempts = jobs.attempts + 1,
        lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS}),
        started_at = COALESCE(jobs.started_at, now()),
        progress = 0,
        message = 'Claimed'
      FROM next WHERE jobs.id = next.id
      RETURNING jobs.id, jobs.type, jobs.capability, jobs.payload, jobs.attempts, jobs.lease_expires_at
    `;
  });
  const job = rows[0];
  if (!job) return null;
  const [w] = await sql`SELECT name FROM workers WHERE id = ${workerId}`;
  await addJobEvent(job.id, "info", `Claimed by ${w?.name ?? workerId} (attempt ${job.attempts})`);
  return {
    id: job.id,
    type: job.type,
    capability: job.capability,
    payload: job.payload ?? {},
    attempt: job.attempts,
    leaseExpiresAt: new Date(job.lease_expires_at).toISOString(),
    heartbeatIntervalSeconds: HEARTBEAT_SECONDS,
  };
}

/** Returns null if the job isn't running on this worker any more (lease lost). */
export async function heartbeat(jobId: string, workerId: string, progress?: number, message?: string) {
  const sql = db();
  const p = progress === undefined ? null : Math.max(0, Math.min(1, progress));
  const rows = await sql`
    UPDATE jobs SET
      lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS}),
      progress = COALESCE(${p}::real, progress),
      message = COALESCE(${message?.slice(0, 500) ?? null}::text, message)
    WHERE id = ${jobId} AND worker_id = ${workerId} AND status = 'running'
    RETURNING lease_expires_at, cancel_requested
  `;
  if (!rows[0]) return null;
  if (message) await addJobEvent(jobId, "info", message);
  return { leaseExpiresAt: new Date(rows[0].lease_expires_at).toISOString(), cancel: rows[0].cancel_requested as boolean };
}

export async function completeJob(jobId: string, workerId: string, result: Record<string, unknown>, message?: string) {
  const rows = await db()`
    UPDATE jobs SET status = 'succeeded', result = ${JSON.stringify(result)}::text::jsonb, progress = 1,
      message = ${message?.slice(0, 500) ?? "Done"}, finished_at = now(), lease_expires_at = NULL, error = NULL
    WHERE id = ${jobId} AND worker_id = ${workerId} AND status = 'running'
    RETURNING id
  `;
  if (rows[0]) await addJobEvent(jobId, "info", message ?? "Completed");
  return rows.length > 0;
}

export async function failJob(jobId: string, workerId: string, error: string, retryable: boolean) {
  const rows = await db()`
    UPDATE jobs SET
      status = CASE WHEN ${retryable}::boolean AND attempts < max_attempts AND NOT cancel_requested THEN 'queued'
                    WHEN cancel_requested THEN 'cancelled' ELSE 'failed' END,
      run_after = now() + make_interval(secs => 60 * attempts),
      error = ${error.slice(0, 4000)},
      worker_id = NULL,
      lease_expires_at = NULL,
      finished_at = CASE WHEN ${retryable}::boolean AND attempts < max_attempts AND NOT cancel_requested
                         THEN NULL ELSE now() END
    WHERE id = ${jobId} AND worker_id = ${workerId} AND status = 'running'
    RETURNING status
  `;
  if (rows[0]) {
    await addJobEvent(jobId, "error", `${error.slice(0, 1000)} -> ${rows[0].status}`);
  }
  return rows.length > 0;
}

export async function cancelJob(jobId: string) {
  const sql = db();
  // Queued jobs cancel immediately; running jobs are told on their next heartbeat.
  const [row] = await sql`
    UPDATE jobs SET
      cancel_requested = true,
      status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
      finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END
    WHERE id = ${jobId} AND status IN ('queued', 'running')
    RETURNING status
  `;
  if (row) await addJobEvent(jobId, "warn", row.status === "cancelled" ? "Cancelled" : "Cancel requested");
}

export async function retryJob(jobId: string) {
  const [row] = await db()`
    UPDATE jobs SET status = 'queued', attempts = 0, error = NULL, cancel_requested = false,
      run_after = now(), finished_at = NULL, progress = 0, message = 'Requeued'
    WHERE id = ${jobId} AND status IN ('failed', 'cancelled')
    RETURNING id
  `;
  if (row) await addJobEvent(jobId, "info", "Requeued manually");
}
