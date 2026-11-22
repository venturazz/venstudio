/**
 * The hermes render as a job the portal starts once and then waits for (research only). Pure: the file name, the
 * render budget, the reply Hermes gives when it starts (or checks) a render, the poll state machine and the texts the
 * owner sees. The server side is lib/server/executors/hermes-render.ts and runHermesRenderStage in production.ts.
 *
 * Why: a long skill (stick-figure, zach-d-films, 3D) renders for longer than any chat turn the portal can wait on.
 * Asking again after a slow turn made Hermes start the same video from scratch, so it never finished. Now the request
 * names the output file, Hermes answers as soon as the render has started, and the studio checks the media host for
 * that file (no Hermes turn, no gate slot) until it is complete, or the budget is spent. It never asks Hermes to start
 * the same render again; Retry starts a new attempt with a new file name.
 */
import { extractJson, type ChatMessage } from "./director.ts";
import { clipUrlIssues, skillVoiceOf, type SkillVoice } from "./hermes-render.ts";
export { HERMES_RENDER_CHECK_TIMEOUT_MS, HERMES_RENDER_START_TIMEOUT_MS } from "./hermes-render.ts";
import { clockUtc, readTime, scaledMs } from "./pacing.ts";

/** The marker of the check ask, for logs and the e2e fake. */
export const HERMES_RENDER_CHECK_STAGE = "hermes-render-check";
/** Default render budgets, in minutes: a quick skill from a small spec, and a full project (its own voice, 3D...). */
export const RENDER_BUDGET_SPEC_MIN = 120;
export const RENDER_BUDGET_PROJECT_MIN = 240;
/** Bounds of a pack's own budget (style.json hermes.renderMinutes). */
export const RENDER_BUDGET_FLOOR_MIN = 10;
export const RENDER_BUDGET_CEILING_MIN = 720;
/** Poll intervals: every minute for the first 10 checks, every 2 min for the next 10, then every 3 min. */
export const RENDER_POLL_STEPS_MS: readonly number[] = [60_000, 120_000, 180_000];
const POLLS_PER_STEP = 10;
/** After the budget, how long the studio keeps trying to get its check ask through before it fails without one. */
export const RENDER_CHECK_GRACE_MS = 30 * 60_000;
/** A file that is complete (same size twice) but not a usable video this many times in a row fails the stage. */
export const RENDER_BAD_FETCHES = 3;
/** Provenance asks for a skill that voiced itself but did not name its voice backend. */
export const RENDER_VOICE_ASKS = 2;

/** The skill's render budget in minutes: the pack's own (hermes.renderMinutes), else by mode (spec 120, project 240). */
export function renderBudgetMinutes(skill: { mode: "spec" | "project"; renderMinutes?: number | null } | null | undefined): number {
  const own = skill?.renderMinutes;
  if (typeof own === "number" && Number.isFinite(own) && own > 0) {
    return Math.min(RENDER_BUDGET_CEILING_MIN, Math.max(RENDER_BUDGET_FLOOR_MIN, Math.round(own)));
  }
  return skill?.mode === "project" ? RENDER_BUDGET_PROJECT_MIN : RENDER_BUDGET_SPEC_MIN;
}

/** vs-<runId>-<attempt>-<rand>.mp4: unique per run and stage attempt, safe as a file name on the media host. */
export function renderFileName(runId: string, attempt: number, rand: string): string {
  const id = runId.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 64) || "run";
  const r = rand.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || "0";
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return `vs-${id}-${n}-${r}.mp4`;
}

export function renderFileUrl(base: string, file: string): string {
  return `${base.replace(/\/+$/, "")}/${file}`;
}

/** What Hermes answered to a start or check ask, read leniently: an unreadable answer is "unclear", never re-asked. */
export interface RenderReply {
  status: "started" | "done" | "error" | "missing" | "unclear";
  /** The file name Hermes says it writes (the requested one unless it says otherwise). */
  file: string;
  /** The URL to read the file from: Hermes's own when it named a usable one, else the requested one. */
  url: string;
  note: string;
  provider: string;
  backend: string;
  model: string;
  voice: SkillVoice | null;
}

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(mp4|webm|mov)$/;

function statusOf(v: unknown): RenderReply["status"] | null {
  const s = typeof v === "string" ? v.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (["started", "rendering", "running", "in_progress", "queued", "working", "pending"].includes(s)) return "started";
  if (["done", "ok", "finished", "complete", "completed", "ready"].includes(s)) return "done";
  if (["error", "failed", "failure", "cannot"].includes(s)) return "error";
  if (["missing", "not_found", "unknown", "none", "no"].includes(s)) return "missing";
  return null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Reads Hermes's answer to the start or the check ask. `expected` is the file the request named and its URL. A URL in
 * the answer is taken only when it is a /clip/ URL under the configured base on an origin the studio trusts; a
 * different file name alone is taken under the same base. The old answer ({"status":"ok","video":{"type":"url",...}})
 * reads as done. Never fails: an answer that is not JSON is "unclear" with the reason in `note`.
 */
export function parseRenderReply(reply: string, expected: { file: string; url: string }, clipBase: string | null, trusted: readonly string[]): RenderReply {
  const base = expected.url.slice(0, expected.url.length - expected.file.length).replace(/\/+$/, "");
  const out: RenderReply = { status: "unclear", file: expected.file, url: expected.url, note: "", provider: "", backend: "", model: "", voice: skillVoiceOf(reply) };
  let v: unknown;
  try {
    v = extractJson(reply);
  } catch {
    // A plain answer that links the finished clip on the trusted media host (an older Hermes) is taken as done.
    const link = /https?:\/\/[^\s)"'<>]+\/clip\/[^\s)"'<>]+\.(?:mp4|webm|mov)/i.exec(reply)?.[0] ?? "";
    const found = link ? parseRenderReply(JSON.stringify({ status: "done", url: link }), expected, clipBase, trusted) : null;
    if (found && found.url === link) return { ...found, voice: out.voice };
    out.note = `Hermes's answer was not JSON: ${reply.replace(/\s+/g, " ").trim().slice(0, 200)}`;
    return out;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    out.note = "Hermes's answer was not a JSON object";
    return out;
  }
  const r = v as Record<string, unknown>;
  const t = (x: unknown, n = 300) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim().slice(0, n) : "");
  out.status = statusOf(r.status) ?? "unclear";
  out.note = t(r.note) || t(r.error) || t(r.message);
  if (out.status === "unclear") out.note = `Hermes answered status "${t(r.status, 40) || "(none)"}"${out.note ? `: ${out.note}` : ""}`;
  out.provider = t(r.provider, 80);
  out.backend = t(r.source, 80) || t(r.backend, 80);
  out.model = t(r.model, 120);
  const video = typeof r.video === "object" && r.video !== null && !Array.isArray(r.video) ? (r.video as Record<string, unknown>) : null;
  let named = t(r.url, 2000) || (video && video.type === "url" ? t(video.value, 2000) : "");
  // A path in Hermes's own videos folder (what its tools hand back) names a file the media host serves under /clip/.
  const path = [named, t(r.file, 2000), video ? t(video.value, 2000) : ""].find((x) => /^\/\S*\/generated\/videos\/[^/]+$/.test(x)) ?? "";
  if (path) named = "";
  const issues: string[] = [];
  if (path) {
    const name = path.split("/").pop() ?? "";
    if (FILE_RE.test(name)) {
      out.file = name;
      out.url = renderFileUrl(base, name);
    } else issues.push(`The file name ${name.slice(0, 120)} is not a video file name`);
  } else if (named) {
    const urlIssues = clipUrlIssues({ type: "url", value: named }, clipBase);
    const origin = originOf(named);
    const name = named.split("?")[0].split("/").pop() ?? "";
    if (urlIssues.length > 0) issues.push(urlIssues[0]);
    else if (!origin || !trusted.includes(origin)) issues.push(`The URL ${named.slice(0, 120)} is not on a media host the studio trusts`);
    else if (!FILE_RE.test(name)) issues.push(`The file name ${name.slice(0, 120)} is not a video file name`);
    else {
      out.url = named;
      out.file = name;
    }
  } else {
    const file = t(r.file, 200).split("/").pop() ?? "";
    if (file && file !== expected.file) {
      if (FILE_RE.test(file)) {
        out.file = file;
        out.url = renderFileUrl(base, file);
      } else issues.push(`The file name ${file.slice(0, 120)} is not a video file name`);
    }
  }
  if (issues.length > 0) out.note = [out.note, `${issues[0]}; the studio reads ${out.url}`].filter(Boolean).join(". ");
  return out;
}

/** The render job, as stored in the render stage's output (`hermesRender`). Times are ISO texts. */
export interface RenderJob {
  file: string;
  url: string;
  /** When the render was asked for (the budget counts from here). */
  startedAt: string;
  /** When the start ask was sent; null while it still has to be sent (Hermes was busy or not reached). */
  askedAt: string | null;
  /** The stage attempt this render belongs to. */
  attempt: number;
  skill: string | null;
  budgetMin: number;
  reply: RenderReply | null;
  /** Hermes said the file is complete: take it at once, no second size check. */
  doneReported: boolean;
  polls: number;
  lastPollAt: string | null;
  /** The file's size at the last poll, or null when it was not there. */
  lastSize: number | null;
  badFetches: number;
  lastIssue: string;
  checkAskedAt: string | null;
  checkReply: RenderReply | null;
  checkTries: number;
  voiceAsks: number;
}

export function newRenderJob(i: { file: string; base: string; attempt: number; skill: string | null; budgetMin: number; nowMs: number }): RenderJob {
  return {
    file: i.file,
    url: renderFileUrl(i.base, i.file),
    startedAt: new Date(i.nowMs).toISOString(),
    askedAt: null,
    attempt: i.attempt,
    skill: i.skill,
    budgetMin: i.budgetMin,
    reply: null,
    doneReported: false,
    polls: 0,
    lastPollAt: null,
    lastSize: null,
    badFetches: 0,
    lastIssue: "",
    checkAskedAt: null,
    checkReply: null,
    checkTries: 0,
    voiceAsks: 0,
  };
}

function readReply(v: unknown): RenderReply | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const s = (x: unknown) => (typeof x === "string" ? x : "");
  const status = (["started", "done", "error", "missing", "unclear"] as const).find((x) => x === r.status) ?? "unclear";
  const voice = typeof r.voice === "object" && r.voice !== null && !Array.isArray(r.voice) ? (r.voice as Record<string, unknown>) : null;
  return {
    status,
    file: s(r.file),
    url: s(r.url),
    note: s(r.note),
    provider: s(r.provider),
    backend: s(r.backend),
    model: s(r.model),
    voice: voice && (s(voice.provider) || s(voice.backend)) ? { provider: s(voice.provider), backend: s(voice.backend), model: s(voice.model) } : null,
  };
}

/** A stored render job, or null when the output has none (a render from before this flow, or not started yet). */
export function readRenderJob(v: unknown): RenderJob | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.file !== "string" || !FILE_RE.test(r.file) || typeof r.url !== "string" || !/^https?:\/\//.test(r.url)) return null;
  if (readTime(r.startedAt) === null) return null;
  const n = (x: unknown, d = 0) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : d);
  const time = (x: unknown) => (readTime(x) === null ? null : new Date(readTime(x) as number).toISOString());
  return {
    file: r.file,
    url: r.url,
    startedAt: new Date(readTime(r.startedAt) as number).toISOString(),
    askedAt: time(r.askedAt),
    attempt: Math.max(1, Math.floor(n(r.attempt, 1))),
    skill: typeof r.skill === "string" && r.skill ? r.skill : null,
    budgetMin: n(r.budgetMin) > 0 ? n(r.budgetMin) : RENDER_BUDGET_SPEC_MIN,
    reply: readReply(r.reply),
    doneReported: r.doneReported === true,
    polls: Math.floor(n(r.polls)),
    lastPollAt: time(r.lastPollAt),
    lastSize: typeof r.lastSize === "number" && Number.isFinite(r.lastSize) ? r.lastSize : null,
    badFetches: Math.floor(n(r.badFetches)),
    lastIssue: typeof r.lastIssue === "string" ? r.lastIssue.slice(0, 300) : "",
    checkAskedAt: time(r.checkAskedAt),
    checkReply: readReply(r.checkReply),
    checkTries: Math.floor(n(r.checkTries)),
    voiceAsks: Math.floor(n(r.voiceAsks)),
  };
}

/** The wait before the next poll, after `polls` polls (1 min, then 2, then 3; shortened only by the test-only scale). */
export function renderPollEveryMs(polls: number, scale: number = 1): number {
  const step = Math.min(RENDER_POLL_STEPS_MS.length - 1, Math.floor(Math.max(0, polls) / POLLS_PER_STEP));
  return scaledMs(RENDER_POLL_STEPS_MS[step], scale);
}

/** What the start answer changes: the file and URL Hermes named, and whether it is already done. */
export function applyStartReply(job: RenderJob, reply: RenderReply): RenderJob {
  return { ...job, reply, file: reply.file, url: reply.url, doneReported: reply.status === "done" };
}

/** What the check answer changes. A "done" answer makes the next look take the file without a second size check. */
export function applyCheckReply(job: RenderJob, reply: RenderReply, nowMs: number): RenderJob {
  const done = reply.status === "done";
  return { ...job, checkAskedAt: new Date(nowMs).toISOString(), checkReply: reply, doneReported: job.doneReported || done, ...(done ? { file: reply.file, url: reply.url } : {}) };
}

/** What the studio saw at the expected URL. `size` is null when the host did not say (no Content-Length). */
export type RenderProbe = { kind: "missing" } | { kind: "present"; size: number | null } | { kind: "error"; message: string };

export type RenderStep =
  | { action: "wait"; job: RenderJob; untilMs: number }
  | { action: "fetch"; job: RenderJob }
  | { action: "check"; job: RenderJob }
  | { action: "fail"; job: RenderJob; reason: string };

function budgetMs(job: RenderJob): number {
  return job.budgetMin * 60_000;
}

/** The stage error when the file never came: what was waited for, what Hermes said, and what the owner can do. */
export function renderOverdueText(job: RenderJob): string {
  const c = job.checkReply;
  const said = !job.checkAskedAt
    ? "; Hermes could not be asked whether it is still rendering"
    : !c
      ? "; Hermes did not answer when asked whether it is still rendering"
      : c.status === "started"
        ? `; Hermes says it is still rendering it${c.note ? ` (${c.note})` : ""}`
        : c.status === "missing"
          ? `; Hermes says it has no such render${c.note ? ` (${c.note})` : ""}`
          : c.status === "error"
            ? `; Hermes says it failed${c.note ? `: ${c.note}` : ""}`
            : c.status === "done"
              ? "; Hermes says it is done, but the file is not on the media host"
              : c.note
                ? `; ${c.note}`
                : "";
  return `Hermes did not produce ${job.file} within ${job.budgetMin} min${said}. Nothing was restarted. Retry starts a new render with a new file name; Cancel stops the run.`;
}

/**
 * One poll of the media host, decided. The file is taken when Hermes said it is done, or when it has the same size
 * at two polls in a row (it is no longer being written). A file that is still growing is waited for. When the budget
 * is spent and the file is not there, Hermes is asked once whether it is still rendering (action "check"); after
 * that, or when the check could not be asked within the grace time, the stage fails. Never restarts the render.
 */
export function renderPollStep(job: RenderJob, probe: RenderProbe, nowMs: number, scale: number = 1): RenderStep {
  const polled: RenderJob = { ...job, polls: job.polls + 1, lastPollAt: new Date(nowMs).toISOString() };
  const start = readTime(job.startedAt) ?? nowMs;
  const elapsed = nowMs - start;
  const over = elapsed > budgetMs(job);
  const pastGrace = elapsed > budgetMs(job) + RENDER_CHECK_GRACE_MS;
  const wait = (j: RenderJob): RenderStep => ({ action: "wait", job: j, untilMs: nowMs + renderPollEveryMs(j.polls, scale) });
  if (probe.kind === "present") {
    const size = probe.size;
    if (job.doneReported || (size !== null && size > 0 && size === job.lastSize)) return { action: "fetch", job: { ...polled, lastSize: size } };
    // First sight of the file, or still growing: look again. Past the grace time a file that never settles fails.
    if (pastGrace) return { action: "fail", job: polled, reason: `Hermes was still writing ${job.file} after ${job.budgetMin} min and more. Nothing was restarted. Retry starts a new render with a new file name; Cancel stops the run.` };
    return wait({ ...polled, lastSize: size });
  }
  const seen: RenderJob = probe.kind === "missing" ? { ...polled, lastSize: null } : { ...polled, lastIssue: probe.message.slice(0, 300) };
  if (!over) return wait(seen);
  if (!job.checkAskedAt && !pastGrace) return { action: "check", job: seen };
  return { action: "fail", job: seen, reason: renderOverdueText(seen) };
}

/** A complete file that was not a usable video (cut short, not a video): look again, and fail after a few in a row. */
export function renderFetchFailed(job: RenderJob, issue: string, nowMs: number, scale: number = 1): RenderStep {
  const next: RenderJob = { ...job, badFetches: job.badFetches + 1, lastIssue: issue.slice(0, 300), lastSize: null, doneReported: false };
  if (next.badFetches >= RENDER_BAD_FETCHES) {
    return { action: "fail", job: next, reason: `The file Hermes wrote (${job.file}) is not a usable video: ${issue.slice(0, 200)}. Retry starts a new render with a new file name.` };
  }
  return { action: "wait", job: next, untilMs: nowMs + renderPollEveryMs(next.polls, scale) };
}

/** The wait stored in `output.hermesWait` while the studio waits for the file (pacing.ts stageWaitText reads it). */
export function renderingWait(job: RenderJob, everyMs: number): Record<string, unknown> {
  return { reason: "rendering", skill: job.skill ?? "", startedAt: job.startedAt, everyMs: Math.round(everyMs), file: job.file };
}

/** Minutes the render has run, and its budget, for the reaper. Null for a stage without a render job. */
export function renderClock(v: unknown, nowMs: number): { elapsedMinutes: number; budgetMinutes: number } | null {
  const job = readRenderJob(v);
  if (!job) return null;
  const start = readTime(job.startedAt) ?? nowMs;
  return { elapsedMinutes: Math.max(0, (nowMs - start) / 60_000), budgetMinutes: job.budgetMin };
}

/** The tiny check ask: is the named file still being rendered? Also asks for the provenance the studio still needs. */
export function renderCheckMessages(job: Pick<RenderJob, "file" | "url" | "skill" | "startedAt">, opts: { voice?: boolean; why?: "overdue" | "provenance" } = {}): ChatMessage[] {
  const started = readTime(job.startedAt);
  const voice = opts.voice ? ',"voice":{"provider":"<the voice tool>","source":"<the voice backend that spoke it>","model":"<voice model, if any>"}' : "";
  const lines = [
    `VENSTUDIO_STAGE: ${HERMES_RENDER_CHECK_STAGE}`,
    `At ${started === null ? "an earlier time" : `${clockUtc(started)} UTC`} the studio asked you to render a video${job.skill ? ` with your ${job.skill} skill` : ""} and save it as ${job.file} (served at ${job.url}). Do not start it again and do not render anything now.`,
    opts.why === "provenance"
      ? "The studio has the file. Say which tools made it."
      : "The file is not on the media host yet. Is it still being rendered?",
    `Answer with JSON only: {"status":"started" (still rendering) | "done" (the file is complete) | "missing" (you have no such render) | "error","file":"${job.file}","url":"<its URL, when done>","note":"<one line: progress or why>","provider":"<the plugin or tool you used>","source":"<the backend that rendered it>","model":"<model, if any>"${voice}}.`,
  ];
  return [{ role: "user", content: lines.join("\n") }];
}
