import "server-only";
import { env } from "./env.ts";
import { db } from "./db.ts";
import { createJob, URGENT_PRIORITY } from "./jobs.ts";
import { openStored } from "./storage.ts";
import {
  MUSE_RESULT_MAX_BYTES,
  MUSE_TEST_FRAME,
  museTestDisabledReasons,
  museTestPayload,
  museTimeline,
  museTimelineText,
  validateMuseResult,
  type MuseStep,
  type MuseTestVariant,
  type MuseWorkerFacts,
} from "../studio/muse-task.ts";

/**
 * The owner's Muse test task (Workers page, docs/muse-agent-tasks.md): queue it for one worker, and read back how it
 * went. Reads Postgres and the artifact store only; never calls a worker or Muse.
 */

export function museFlagOn(): boolean {
  return env().MUSE_AGENT_TASKS === "1";
}

function asStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export async function museWorkerFacts(): Promise<MuseWorkerFacts[]> {
  const rows = await db()`SELECT id, name, status, job_types FROM workers WHERE status <> 'revoked' ORDER BY name`;
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), status: String(r.status), jobTypes: asStrings(r.job_types) }));
}

export type QueueResult = { ok: true; jobId: string } | { ok: false; error: string };

/** Queues the test for this worker: preferred worker, urgent priority, the tiny context. Refused with the exact reason. */
export async function queueMuseTest(workerId: string, variant: MuseTestVariant, createdBy: string): Promise<QueueResult> {
  const workers = await museWorkerFacts();
  const worker = workers.find((w) => w.id === workerId) ?? null;
  const reasons = museTestDisabledReasons({ portalFlag: museFlagOn(), worker: worker ?? { id: workerId, name: "", status: "unknown", jobTypes: [] }, anyWorker: workers.length > 0 });
  if (reasons.length > 0) return { ok: false, error: reasons.join(". ") };
  const jobId = await createJob({ type: "agent-task", payload: museTestPayload(variant), priority: URGENT_PRIORITY, preferredWorkerId: workerId, createdBy });
  return { ok: true, jobId };
}

async function readArtifactText(storagePath: string, max: number): Promise<string | null> {
  try {
    const f = await openStored(storagePath);
    if (f.size > max) {
      f.stream.destroy();
      return null;
    }
    const chunks: Buffer[] = [];
    for await (const c of f.stream) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return null;
  }
}

export interface MuseTestView {
  jobId: string;
  variant: MuseTestVariant;
  status: string;
  workerId: string;
  steps: MuseStep[];
  lines: string[];
  wakeSec: number | null;
  image: { artifactId: string; name: string; width: number | null; height: number | null; sizeOk: boolean | null } | null;
  json: { ok: true; value: unknown } | { ok: false; issues: string[] } | null;
  resultText: string | null;
}

/** The newest test task of each worker, by worker id. */
export async function latestMuseTests(): Promise<Map<string, MuseTestView>> {
  const rows = await db()`
    SELECT DISTINCT ON (preferred_worker_id) id, preferred_worker_id FROM jobs
    WHERE type = 'agent-task' AND payload ? 'museTest' AND preferred_worker_id IS NOT NULL
    ORDER BY preferred_worker_id, created_at DESC
  `;
  const out = new Map<string, MuseTestView>();
  for (const r of rows) {
    const v = await museTestView(String(r.id));
    if (v) out.set(String(r.preferred_worker_id), v);
  }
  return out;
}

export async function museTestView(jobId: string): Promise<MuseTestView | null> {
  const sql = db();
  const [j] = await sql`
    SELECT id, status, payload, result, error, created_at, started_at, finished_at, preferred_worker_id
    FROM jobs WHERE id = ${jobId} AND type = 'agent-task'
  `;
  if (!j) return null;
  const payload = (j.payload ?? {}) as Record<string, unknown>;
  const variant: MuseTestVariant = payload.museTest === "json" ? "json" : "picture";
  const result = (j.result ?? null) as Record<string, unknown> | null;
  const events = (await sql`SELECT message, created_at FROM job_events WHERE job_id = ${jobId} ORDER BY id`).map((e) => ({ message: String(e.message), createdAt: e.created_at as Date }));
  const artifacts = (await sql`SELECT id, name, content_type, storage_path FROM artifacts WHERE job_id = ${jobId} ORDER BY created_at`).map((a) => ({
    id: String(a.id),
    name: String(a.name),
    contentType: String(a.content_type),
    storagePath: String(a.storage_path),
  }));
  const facts = {
    status: String(j.status),
    createdAt: j.created_at as Date,
    startedAt: (j.started_at as Date | null) ?? null,
    finishedAt: (j.finished_at as Date | null) ?? null,
    error: (j.error as string | null) ?? null,
    result,
    events,
  };
  const { steps, wakeSec } = museTimeline(facts);
  let image: MuseTestView["image"] = null;
  const img = artifacts.find((a) => a.name.startsWith("agent-") && a.contentType.startsWith("image/"));
  if (img) {
    const files = Array.isArray(result?.files) ? (result?.files as Array<Record<string, unknown>>) : [];
    const file = files.find((f) => `agent-${String(f.name)}` === img.name);
    const width = typeof file?.width === "number" ? file.width : null;
    const height = typeof file?.height === "number" ? file.height : null;
    image = { artifactId: img.id, name: img.name.slice("agent-".length), width, height, sizeOk: width === null ? null : width === MUSE_TEST_FRAME.width && height === MUSE_TEST_FRAME.height };
  }
  let json: MuseTestView["json"] = null;
  let resultText: string | null = null;
  const res = artifacts.find((a) => a.name === "agent-result.json");
  if (res) {
    resultText = await readArtifactText(res.storagePath, MUSE_RESULT_MAX_BYTES);
    // The test checks the files the agent says it read against the folder TASK.md listed.
    const folder = ["TASK.md", ...asStrings(result?.contextFiles), ...asStrings(result?.inputFiles).map((n) => `in/${n}`)];
    json = resultText === null ? { ok: false, issues: ["result.json could not be read back"] } : validateMuseResult("test", resultText, { folder });
  } else if (variant === "json" && j.status === "succeeded") {
    json = { ok: false, issues: ["The task finished but no result.json came back"] };
  }
  return {
    jobId: String(j.id),
    variant,
    status: String(j.status),
    workerId: String(j.preferred_worker_id ?? ""),
    steps,
    lines: museTimelineText(facts),
    wakeSec,
    image,
    json,
    resultText,
  };
}
