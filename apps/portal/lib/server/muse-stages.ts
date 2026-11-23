import "server-only";
import { db } from "./db.ts";
import { cancelJob, createJob } from "./jobs.ts";
import { museFlagOn, museWorkerFacts, readArtifactText } from "./muse-tasks.ts";
import { MUSE_RESULT_MAX_BYTES } from "../studio/muse-task.ts";
import { skillForPack } from "./style-packs.ts";
import { skillCapability } from "../agent-skills.ts";
import { openStored } from "./storage.ts";
import { checkRenderBytes } from "./executors/hermes-render.ts";
import { MAX_VIDEO_BYTES, type VideoInfo } from "../studio/image-result.ts";
import type { ChatMessage } from "../studio/director.ts";
import {
  MUSE_POLL_SEC,
  messagesText,
  museStageJson,
  museStagePayload,
  museStagePayloadIssues,
  museStagePoll,
  museRenderPayload,
  museRenderRefusals,
  museStageRefusals,
  type MuseRenderInput,
  type MuseThinkStage,
} from "../studio/muse-stage.ts";

/**
 * A thinking stage done by the Muse agent instead of Hermes (docs/muse-agent-tasks.md, "Stages on Muse"). Reads
 * Postgres and the artifact store only; the worker on Muse takes the job. Nothing here calls Hermes, so the stage
 * holds no Hermes slot while it waits.
 */

/** Why this portal cannot send thinking to Muse right now, or []. */
export async function museStageReadiness(): Promise<string[]> {
  return museStageRefusals({ portalFlag: museFlagOn(), workers: await museWorkerFacts() });
}

/** Queues the task for a stage: the Hermes prompt as PROMPT.md, result.json as the deliverable. Returns the job id. */
export async function startMuseStage(o: { runId: string; channelId: string | null; project: string; stage: MuseThinkStage; prompt: ChatMessage[] }): Promise<string> {
  const payload = museStagePayload({ stage: o.stage, prompt: messagesText(o.prompt), runId: o.runId, project: o.project });
  const issues = museStagePayloadIssues(payload);
  if (issues.length > 0) throw new Error(`The Muse task is not usable: ${issues.join("; ")}`);
  return createJob({ type: "agent-task", channelId: o.channelId, createdBy: null, payload });
}

export type MuseStageState =
  | { kind: "wait"; text: string; pollSec: number }
  | { kind: "done"; value: unknown }
  | { kind: "error"; error: string };

/** Where the task of a waiting stage stands: still going, its checked answer, or why it failed. */
export async function pollMuseStage(jobId: string, _stage: MuseThinkStage): Promise<MuseStageState> {
  const sql = db();
  const [j] = await sql`SELECT status, error, created_at FROM jobs WHERE id = ${jobId} AND type = 'agent-task'`;
  const next = museStagePoll(j ? { status: String(j.status), error: (j.error as string | null) ?? null, createdAt: j.created_at as Date } : null);
  if (next.kind === "wait") return { kind: "wait", text: next.text, pollSec: MUSE_POLL_SEC };
  if (next.kind === "error") {
    // A task nobody took must not be taken later by a worker the run no longer waits for.
    if (j && j.status === "queued") await cancelJob(jobId).catch(() => undefined);
    return { kind: "error", error: next.error };
  }
  const [a] = await sql`SELECT storage_path FROM artifacts WHERE job_id = ${jobId} AND name = 'agent-result.json' ORDER BY created_at DESC LIMIT 1`;
  const text = a ? await readArtifactText(String(a.storage_path), MUSE_RESULT_MAX_BYTES) : null;
  // Parsed only: the caller checks it with the same validator (and the same run facts) as the Hermes ask for this stage.
  const answer = museStageJson(text);
  return answer.ok ? { kind: "done", value: answer.value } : { kind: "error", error: answer.error };
}

/** Why Muse cannot render this pack's skill now, or []: the worker must have the exact skill version installed. */
export async function museRenderReadiness(packId: string): Promise<{ refusals: string[]; skill: { id: string; version: string; status: "curated" | "candidate" } | null }> {
  const flag = museFlagOn() ? [] : ["Set MUSE_AGENT_TASKS=1 on the portal"];
  const skill = await skillForPack(packId);
  const rows = await db()`SELECT id, name, status, job_types, version, last_seen_at, capabilities FROM workers WHERE status <> 'revoked'`;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const workers = rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    status: String(r.status),
    jobTypes: strings(r.job_types),
    capabilities: strings(r.capabilities),
    version: typeof r.version === "string" ? r.version : null,
    lastSeenAt: (r.last_seen_at as Date | null) ?? null,
  }));
  return { refusals: [...flag, ...museRenderRefusals({ skill, packId, workers })], skill };
}

/** Queues the render of a Hermes-skill video on Muse, under the skill's capability so only a worker that has it claims it. */
export async function startMuseRender(i: MuseRenderInput & { channelId: string | null }): Promise<string> {
  const payload = museRenderPayload(i);
  const issues = museStagePayloadIssues(payload);
  if (issues.length > 0) throw new Error(`The Muse render task is not usable: ${issues.join("; ")}`);
  return createJob({ type: "agent-task", channelId: i.channelId, createdBy: null, payload, capability: skillCapability(i.skillRef.id, i.skillRef.version) as `skill:${string}` });
}

export type MuseRenderState =
  | { kind: "wait"; text: string; pollSec: number }
  | { kind: "done"; bytes: Uint8Array; info: VideoInfo; workerId: string | null }
  | { kind: "error"; error: string };

/** Where a Muse render stands: still going, the checked video bytes, or why it failed. */
export async function pollMuseRender(jobId: string): Promise<MuseRenderState> {
  const sql = db();
  const [j] = await sql`SELECT status, error, created_at, worker_id FROM jobs WHERE id = ${jobId} AND type = 'agent-task'`;
  const next = museStagePoll(j ? { status: String(j.status), error: (j.error as string | null) ?? null, createdAt: j.created_at as Date } : null);
  if (next.kind === "wait") return { kind: "wait", text: next.text === "Muse is working on this step" ? "Muse is rendering the video" : "Waiting for a Muse worker to take the render", pollSec: MUSE_POLL_SEC };
  if (next.kind === "error") {
    if (j && j.status === "queued") await cancelJob(jobId).catch(() => undefined);
    return { kind: "error", error: next.error };
  }
  const [a] = await sql`SELECT storage_path FROM artifacts WHERE job_id = ${jobId} AND name = 'agent-video.mp4' ORDER BY created_at DESC LIMIT 1`;
  if (!a) return { kind: "error", error: "The Muse agent finished the render but no video.mp4 came back" };
  try {
    const f = await openStored(String(a.storage_path));
    if (f.size > MAX_VIDEO_BYTES) {
      f.stream.destroy();
      return { kind: "error", error: `The video Muse rendered is ${Math.round(f.size / 1048576)} MB; the limit is ${MAX_VIDEO_BYTES / 1048576} MB` };
    }
    const chunks: Buffer[] = [];
    for await (const c of f.stream) chunks.push(c as Buffer);
    const got = checkRenderBytes(new Uint8Array(Buffer.concat(chunks)));
    if (!got.ok) return { kind: "error", error: `The video Muse rendered is not usable: ${got.issue}` };
    return { kind: "done", bytes: got.bytes, info: got.info, workerId: (j?.worker_id as string | null) ?? null };
  } catch {
    return { kind: "error", error: "The video Muse rendered could not be read back" };
  }
}
