/**
 * Narration made by Kokoro on a worker (the `tts` job): the job the portal queues, which worker may take it, what a
 * waiting voice stage does next, and how the result is checked. Pure: no database, no network.
 *
 * Why: Hermes answers one ask at a time. A worker that reaches its own Kokoro (VENSTUDIO_KOKORO_URL, for example on a
 * Muse VM) speaks in parallel with every other worker and needs no public address, because it only calls out to the
 * portal. It is tried after the owner's KOKORO_BASE_URL and 9router's voice and before the Hermes paths.
 */
import { chunkScript } from "./voice.ts";

export const TTS_WORKER_CHUNK_CHARS = 400;
export const TTS_WORKER_MAX_CHUNKS = 60;
/** The job's queue wait before the voice stage tries the next path instead. */
export const TTS_QUEUE_GIVE_UP_MIN = 20;
/** How often a waiting voice stage looks at its job. A finished job also resumes the run at once. */
export const TTS_POLL_SEC = 15;
export const TTS_WORKER_MODEL = "kokoro";
export const TTS_ARTIFACT_NAME = "narration.wav";
const WORKER_SEEN_MIN = 75;

export interface TtsWorkerFacts {
  status: string;
  jobTypes: readonly string[];
  /** Capabilities it reported; tts-kokoro means its Kokoro answered the worker's own check. */
  capabilities?: readonly string[];
  lastSeenAt?: Date | string | null;
}

/** True when an active worker that reports `tts` (and a Kokoro that answered) has contacted the portal recently. Pure. */
export function ttsWorkerReady(workers: readonly TtsWorkerFacts[], now: Date = new Date()): boolean {
  return workers.some(
    (w) => w.status === "active" && w.jobTypes.includes("tts") && (w.capabilities?.includes("tts-kokoro") ?? true) && w.lastSeenAt != null && now.getTime() - new Date(w.lastSeenAt).getTime() < WORKER_SEEN_MIN * 60_000,
  );
}

/** The text pieces of a script for the worker, or null when it has none or too many. Pure. */
export function ttsWorkerChunks(script: string): string[] | null {
  const chunks = chunkScript(script, TTS_WORKER_CHUNK_CHARS);
  return chunks.length > 0 && chunks.length <= TTS_WORKER_MAX_CHUNKS ? chunks : null;
}

/** The `tts` job payload the worker's handler reads (chunks, voice, model, pause). Pure. */
export function ttsJobPayload(o: { chunks: string[]; voice: string; runId: string }): Record<string, unknown> {
  return { chunks: o.chunks, voice: o.voice, model: TTS_WORKER_MODEL, pauseSec: 0.25, runId: o.runId, stage: "voice" };
}

export interface TtsJobFacts {
  status: string;
  error: string | null;
  createdAt: Date | string;
  result?: Record<string, unknown> | null;
}

export type TtsPoll = { kind: "wait"; text: string } | { kind: "read" } | { kind: "error"; error: string };

/** What a voice stage waiting on its worker job does next. Pure. */
export function ttsJobPoll(job: TtsJobFacts | null, now: Date = new Date()): TtsPoll {
  if (!job) return { kind: "error", error: "The narration job no longer exists" };
  switch (job.status) {
    case "succeeded":
      return { kind: "read" };
    case "failed":
      return { kind: "error", error: job.error ? `Kokoro on the worker failed: ${job.error}` : "Kokoro on the worker failed" };
    case "cancelled":
      return { kind: "error", error: "The narration job was cancelled" };
    case "running":
      return { kind: "wait", text: "A worker is speaking the narration with Kokoro" };
    default: {
      const waited = (now.getTime() - new Date(job.createdAt).getTime()) / 60_000;
      if (waited >= TTS_QUEUE_GIVE_UP_MIN) return { kind: "error", error: `No worker took the narration within ${TTS_QUEUE_GIVE_UP_MIN} min` };
      return { kind: "wait", text: "Waiting for a worker with Kokoro to take the narration" };
    }
  }
}

/** Checks the uploaded WAV against what the worker reported about it (the SHA-256 it computed). Pure. */
export function ttsResultIssue(result: Record<string, unknown> | null | undefined, sha256: string): string | null {
  const told = typeof result?.sha256 === "string" ? result.sha256.toLowerCase() : "";
  if (told && told !== sha256.toLowerCase()) return "The narration file does not match what the worker reported";
  return null;
}
