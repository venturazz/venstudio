import "server-only";
import { createHash } from "node:crypto";
import { db } from "./db.ts";
import { cancelJob, createJob } from "./jobs.ts";
import { openStored } from "./storage.ts";
import { MAX_AUDIO_BYTES } from "../studio/image-result.ts";
import { TTS_POLL_SEC, TTS_ARTIFACT_NAME, ttsJobPayload, ttsJobPoll, ttsResultIssue, ttsWorkerReady } from "../studio/tts-worker.ts";

/** Narration by Kokoro on a worker (docs/muse-agent-tasks.md, "Voice on a worker"). Reads Postgres and the artifact store only. */

export async function ttsWorkerAvailable(): Promise<boolean> {
  try {
    const rows = await db()`SELECT status, job_types, capabilities, last_seen_at FROM workers WHERE status = 'active'`;
    return ttsWorkerReady(
      rows.map((r) => ({
        status: String(r.status),
        jobTypes: Array.isArray(r.job_types) ? (r.job_types as unknown[]).filter((x): x is string => typeof x === "string") : [],
        capabilities: Array.isArray(r.capabilities) ? (r.capabilities as unknown[]).filter((x): x is string => typeof x === "string") : [],
        lastSeenAt: (r.last_seen_at as Date | null) ?? null,
      })),
    );
  } catch (err) {
    console.error("could not read workers for the voice", err);
    return false;
  }
}

export async function startTtsJob(o: { runId: string; channelId: string | null; chunks: string[]; voice: string }): Promise<string> {
  return createJob({ type: "tts", channelId: o.channelId, createdBy: null, payload: ttsJobPayload({ chunks: o.chunks, voice: o.voice, runId: o.runId }) });
}

export type TtsJobState = { kind: "wait"; text: string; pollSec: number } | { kind: "done"; audio: Uint8Array } | { kind: "error"; error: string };

export async function pollTtsJob(jobId: string): Promise<TtsJobState> {
  const sql = db();
  const [j] = await sql`SELECT status, error, created_at, result FROM jobs WHERE id = ${jobId} AND type = 'tts'`;
  const next = ttsJobPoll(
    j ? { status: String(j.status), error: (j.error as string | null) ?? null, createdAt: j.created_at as Date, result: (j.result ?? null) as Record<string, unknown> | null } : null,
  );
  if (next.kind === "wait") return { kind: "wait", text: next.text, pollSec: TTS_POLL_SEC };
  if (next.kind === "error") {
    if (j && j.status === "queued") await cancelJob(jobId).catch(() => undefined);
    return { kind: "error", error: next.error };
  }
  const [a] = await sql`SELECT storage_path FROM artifacts WHERE job_id = ${jobId} AND name = ${TTS_ARTIFACT_NAME} ORDER BY created_at DESC LIMIT 1`;
  if (!a) return { kind: "error", error: "The narration job finished but its audio is missing" };
  try {
    const f = await openStored(String(a.storage_path));
    if (f.size > MAX_AUDIO_BYTES) {
      f.stream.destroy();
      return { kind: "error", error: "The narration file is larger than the portal accepts" };
    }
    const chunks: Buffer[] = [];
    for await (const c of f.stream) chunks.push(c as Buffer);
    const audio = Buffer.concat(chunks);
    const issue = ttsResultIssue((j?.result ?? null) as Record<string, unknown> | null, createHash("sha256").update(audio).digest("hex"));
    return issue ? { kind: "error", error: issue } : { kind: "done", audio: new Uint8Array(audio) };
  } catch {
    return { kind: "error", error: "The narration file could not be read back" };
  }
}
