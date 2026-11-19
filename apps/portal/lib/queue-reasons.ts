/**
 * Explains, in plain words, why a queued job has not started. Pure: the caller loads the job and workers.
 */
export interface JobForReasons {
  type: string;
  capability: string;
  status: string;
  priority: number;
  preferredWorkerId: string | null;
  createdAt: Date;
  runAfter: Date;
}

export interface WorkerForReasons {
  id: string;
  name: string;
  status: string;
  version: string | null;
  capabilities: string[];
  jobTypes: string[];
  lastClaimAt: Date | null;
}

export interface ReasonOptions {
  now: Date;
  latestVersion: string;
  graceMinutes: number;
  urgentPriority: number;
  /** Job types older workers have always been able to run. */
  legacyJobTypes: string[];
}

export function queueReasons(job: JobForReasons, workers: WorkerForReasons[], opts: ReasonOptions): string[] {
  if (job.status !== "queued") return [];
  const reasons: string[] = [];
  if (job.runAfter.getTime() > opts.now.getTime()) {
    reasons.push(`Scheduled to retry at ${job.runAfter.toLocaleTimeString()}.`);
  }
  const live = workers.filter((w) => w.status !== "revoked");
  if (live.length === 0) {
    reasons.push("No worker is enrolled. Add one on the Workers page.");
    return reasons;
  }

  for (const w of live) {
    if (w.status === "draining") {
      reasons.push(`${w.name} is draining, so it takes no new jobs. Resume it on the Workers page.`);
      continue;
    }
    if (!w.capabilities.includes(job.capability)) {
      const reports = w.capabilities.length ? w.capabilities.join(", ") : "nothing yet";
      reasons.push(`${w.name} has no "${job.capability}" capability (it reports: ${reports}).`);
      continue;
    }
    const types = w.jobTypes.length ? w.jobTypes : opts.legacyJobTypes;
    if (!types.includes(job.type)) {
      reasons.push(`${w.name} (v${w.version ?? "unknown"}) can't run "${job.type}" yet. Update it to v${opts.latestVersion} on the Workers page.`);
      continue;
    }
    const minutesSinceClaim = w.lastClaimAt ? (opts.now.getTime() - w.lastClaimAt.getTime()) / 60_000 : Infinity;
    if (minutesSinceClaim > 10) {
      const when = w.lastClaimAt ? `since ${w.lastClaimAt.toLocaleTimeString()}` : "yet";
      reasons.push(`${w.name} hasn't asked for work ${when}. It is probably asleep: run its scheduled task or send the run-now message.`);
    } else {
      reasons.push(`${w.name} is asking for work and should take this job within about a minute.`);
    }
  }

  if (job.preferredWorkerId && job.priority < opts.urgentPriority) {
    const waited = (opts.now.getTime() - job.createdAt.getTime()) / 60_000;
    if (waited < opts.graceMinutes) {
      const left = Math.ceil(opts.graceMinutes - waited);
      reasons.push(`Waiting up to ${left} more minutes for its home worker. Urgent jobs skip this wait.`);
    }
  }
  return reasons;
}
