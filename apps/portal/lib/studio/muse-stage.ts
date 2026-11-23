/**
 * Thinking stages that the Muse agent can do instead of Hermes (docs/muse-agent-tasks.md, "Stages on Muse"): the task
 * the portal sends, how its answer is read back, and which runs may ask for it. Pure: no database, no network.
 *
 * Hermes answers one ask at a time through its gate. A run that asks for Muse sends the same prompt to the Muse
 * agent's inbox as a file, gets result.json back, and checks it with the validator that checks Hermes's answer for the
 * same stage. Gates, review cards and approval do not change.
 */
import { MUSE_RESULT_SCHEMA, MUSE_TIMEOUT_SEC, clipText, contextIssues, validateMuseResult, type ContextFile, type MuseWorkerFacts } from "./muse-task.ts";
import { versionBefore } from "./muse-task.ts";
import type { ChatMessage } from "./director.ts";

/** The stages that may run on Muse. html-design (it writes page files) and the production stages stay with Hermes. */
export const MUSE_THINK_STAGES = ["idea", "research", "script", "storyboard", "scene-spec", "skill-brief"] as const;
export type MuseThinkStage = (typeof MUSE_THINK_STAGES)[number];

export function isMuseThinkStage(v: unknown): v is MuseThinkStage {
  return typeof v === "string" && (MUSE_THINK_STAGES as readonly string[]).includes(v);
}

/** `pipeline_runs.config.executors`: the stages this run sends to Muse. Absent: everything goes to Hermes, as before. */
export type StageExecutors = Partial<Record<MuseThinkStage, "muse">>;

/** First worker that reports PROGRESS.json steps and FAILED.json reasons; a Muse stage needs both. */
export const MUSE_STAGE_WORKER_VERSION = "0.15.0";

/** Reads a stored `executors` value: known stages set to "muse" only, anything else dropped. */
export function parseStageExecutors(raw: unknown): StageExecutors {
  const out: StageExecutors = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  for (const stage of MUSE_THINK_STAGES) if (r[stage] === "muse") out[stage] = "muse";
  return out;
}

/** The stages sent to Muse when the owner chooses "Muse does the thinking" on New Video. */
export function museThinkingExecutors(): StageExecutors {
  return Object.fromEntries(MUSE_THINK_STAGES.map((s) => [s, "muse" as const])) as StageExecutors;
}

export function runsOnMuse(executors: StageExecutors | undefined, stage: string): boolean {
  return isMuseThinkStage(stage) && executors?.[stage] === "muse";
}

/** The label the run page shows, or null when nothing goes to Muse. */
export function executorsText(executors: StageExecutors | undefined): string | null {
  const stages = MUSE_THINK_STAGES.filter((s) => executors?.[s] === "muse");
  return stages.length === 0 ? null : `Muse does the ${stages.join(", ")}`;
}

/** The ask Hermes would get, as one document for PROMPT.md: each message under its role. Pure. */
export function messagesText(messages: readonly ChatMessage[]): string {
  return messages.map((m) => `## ${m.role}\n\n${m.content.trim()}\n`).join("\n");
}

const PROMPT_MAX_BYTES = 150 * 1024;

const SHORT_PROMPT =
  "Do the task written in PROMPT.md. Do not answer in chat. Save your answer as out/result.json: valid JSON in the schema given in SPEC.json, " +
  "and nothing else in that file. Keep out/PROGRESS.json up to date while you work. When result.json is complete, create out/DONE. " +
  "If you cannot do it, write out/FAILED.json with the reason.";

/**
 * The agent-task payload for one thinking stage: the Hermes prompt as PROMPT.md, the schema as SPEC.json, result.json
 * as the one output, and the run and stage so the portal finds the answer again. Pure.
 */
export function museStagePayload(o: { stage: MuseThinkStage; prompt: string; runId: string; project: string }): Record<string, unknown> {
  const context: ContextFile[] = [
    { name: "PROMPT.md", text: clipText(o.prompt, PROMPT_MAX_BYTES) },
    {
      name: "SPEC.json",
      text: JSON.stringify({ kind: "result", files: [{ name: "result.json", format: "json" }], stage: o.stage, schema: MUSE_RESULT_SCHEMA[o.stage] }, null, 2) + "\n",
    },
  ];
  return {
    inputs: [],
    mode: "hold",
    runId: o.runId,
    stage: o.stage,
    museStage: o.stage,
    project: o.project.slice(0, 120),
    prompt: SHORT_PROMPT,
    deliverable: `result.json for the ${o.stage} step`,
    outputs: ["result.json"],
    context,
    timeoutSec: MUSE_TIMEOUT_SEC,
  };
}

/** Problems with a payload before it is queued, using the worker's own context rules. [] when it is usable. */
export function museStagePayloadIssues(payload: Record<string, unknown>): string[] {
  return contextIssues(Array.isArray(payload.context) ? (payload.context as ContextFile[]) : []);
}

/** Why a run cannot send its thinking to Muse right now, or []. Each reason is the thing to change. Pure. */
export function museStageRefusals(o: { portalFlag: boolean; workers: readonly MuseWorkerFacts[]; now?: Date }): string[] {
  const reasons: string[] = [];
  if (!o.portalFlag) reasons.push("Set MUSE_AGENT_TASKS=1 on the portal");
  const now = (o.now ?? new Date()).getTime();
  const ready = o.workers.filter((w) => w.status === "active" && w.jobTypes.includes("agent-task"));
  if (ready.length === 0) {
    reasons.push("No Muse worker reports agent-task: set VENSTUDIO_AGENT_TASKS=1 in the hold cron line on Muse");
    return reasons;
  }
  const current = ready.filter((w) => w.version && !versionBefore(w.version, MUSE_STAGE_WORKER_VERSION));
  if (current.length === 0) reasons.push(`Update the Muse worker to ${MUSE_STAGE_WORKER_VERSION} or later (older workers cannot report progress or failures)`);
  else if (!current.some((w) => w.lastSeenAt !== undefined && w.lastSeenAt !== null && now - new Date(w.lastSeenAt).getTime() < 75 * 60_000)) {
    reasons.push("No Muse worker has contacted the portal in the last 75 min");
  }
  return reasons;
}

/** result.json as parsed data, for a caller that checks it with the exact validator its Hermes ask uses. Pure. */
export function museStageJson(text: string | null): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text === null) return { ok: false, error: "The Muse agent finished but no result.json came back" };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return { ok: false, error: `The Muse agent's result.json is not valid JSON: ${(err as Error).message.slice(0, 120)}` };
  }
}

export type MuseStageAnswer = { ok: true; value: unknown } | { ok: false; error: string };

/** Reads result.json for a stage with the stage's own validator. Pure. */
export function museStageAnswer(stage: MuseThinkStage, text: string | null): MuseStageAnswer {
  if (text === null) return { ok: false, error: "The Muse agent finished but no result.json came back" };
  const checked = validateMuseResult(stage, text);
  if (checked.ok) return { ok: true, value: checked.value };
  return { ok: false, error: `The Muse agent's ${stage} answer was not usable: ${checked.issues.slice(0, 5).join("; ")}` };
}

/** How long a Muse stage waits for a worker to take its task before it is reported. */
export const MUSE_QUEUE_GIVE_UP_MIN = 90;
/** How often a waiting stage looks at its job. A finished job also resumes the run at once. */
export const MUSE_POLL_SEC = 30;

export type MuseJobFacts = { status: string; error: string | null; createdAt: Date | string };

export type MuseStagePoll = { kind: "wait"; text: string } | { kind: "read" } | { kind: "error"; error: string };

/** What a stage waiting on its Muse job does next. Pure. */
export function museStagePoll(job: MuseJobFacts | null, now: Date = new Date()): MuseStagePoll {
  if (!job) return { kind: "error", error: "The Muse task for this step no longer exists" };
  switch (job.status) {
    case "succeeded":
      return { kind: "read" };
    case "failed":
      return { kind: "error", error: job.error ? `The Muse agent's task failed: ${job.error}` : "The Muse agent's task failed" };
    case "cancelled":
      return { kind: "error", error: "The Muse agent's task was cancelled" };
    case "running":
      return { kind: "wait", text: "Muse is working on this step" };
    default: {
      const waitedMin = (now.getTime() - new Date(job.createdAt).getTime()) / 60_000;
      if (waitedMin >= MUSE_QUEUE_GIVE_UP_MIN) return { kind: "error", error: `No Muse worker took this step within ${MUSE_QUEUE_GIVE_UP_MIN} min` };
      return { kind: "wait", text: "Waiting for a Muse worker to take this step" };
    }
  }
}

/**
 * Whether a stage that this run gave to Hermes may move to Muse because Hermes is busy: only a thinking stage, only
 * when overflow is on, and never one that already goes to Muse. Pure.
 */
export function museOverflowApplies(o: { stage: string; executors: StageExecutors | undefined; overflowOn: boolean }): boolean {
  return o.overflowOn && isMuseThinkStage(o.stage) && !runsOnMuse(o.executors, o.stage);
}
