import "server-only";
import { db } from "./db.ts";
import { cancelJob, createJob } from "./jobs.ts";
import { museFlagOn, museWorkerFacts, readArtifactText } from "./muse-tasks.ts";
import { MUSE_RESULT_MAX_BYTES } from "../studio/muse-task.ts";
import type { ChatMessage } from "../studio/director.ts";
import {
  MUSE_POLL_SEC,
  messagesText,
  museStageJson,
  museStagePayload,
  museStagePayloadIssues,
  museStagePoll,
  museStageRefusals,
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
