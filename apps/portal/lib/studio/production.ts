/**
 * Phase 4 production decisions, pure: which work orders to retry, which production stages are stuck or orphaned,
 * how an autonomy decision is adjusted for stages that a revision cannot fix, and the plain texts the owner sees.
 * The database side lives in lib/server/production.ts.
 */
import type { Decision } from "./autonomy.ts";
import { chunkScript } from "./voice.ts";
import type { GateId, GateResult } from "./qc.ts";
import type { BeatRole } from "./templates.ts";
import type { ProductionStage, RunStage } from "./engine.ts";
import type { ReviewKind } from "./review.ts";

/** Hermes image attempts per shot before the CC0 library (each attempt already re-asks Hermes up to 2 times). */
export const HERMES_IMAGE_ATTEMPTS = 2;
/** A work order is given up after this many claims (a crash or restart consumes one). */
export const ORDER_MAX_ATTEMPTS = 3;
/** One work order's worst case: 2 Hermes attempts of 3 asks at 180 s, plus the CC0 search. */
export const ORDER_WORST_CASE_SEC = HERMES_IMAGE_ATTEMPTS * 3 * 180 + 2 * 180;
/** A work order or assets stage with no activity this long is treated as lost. */
export const ORDER_STUCK_MINUTES = Math.ceil(ORDER_WORST_CASE_SEC / 60) + 6;
/** Voice, render-without-job and qc-without-job stages are lost after this long. */
export const PRODUCTION_STUCK_MINUTES = 20;
/** Most captions the worker accepts is 300; lines are cut at this many characters. */
export const CAPTION_LINE_CHARS = 90;
export const MAX_CAPTION_LINES = 300;

export interface OrderSpec {
  prompt: string;
  seconds: number;
  beatRole: BeatRole;
  /** The owner's revision note for this shot. Untrusted text, sent to Hermes inside a DATA block. */
  note: string;
}

const BEATS: readonly BeatRole[] = ["hook", "setup", "body", "payoff", "cta", "outro"];

/** Reads a work order spec back from the database. Missing or odd fields get safe defaults. */
export function parseOrderSpec(raw: unknown): OrderSpec {
  const r = (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const beat = BEATS.find((b) => b === r.beatRole) ?? "body";
  return {
    prompt: typeof r.prompt === "string" ? r.prompt : "",
    seconds: typeof r.seconds === "number" && r.seconds > 0 ? r.seconds : 4,
    beatRole: beat,
    note: typeof r.note === "string" ? r.note : "",
  };
}

export type OrderAction = "keep" | "requeue" | "fail";

export interface OrderActivity {
  state: string;
  attempts: number;
  /** True when the order waits on a worker job (CC0 fetch or agent task). */
  hasJob: boolean;
  /** Minutes since the order last changed. */
  idleMinutes: number;
}

/**
 * What to do with an order the reaper found. Only a running order with no job and no recent activity is lost: an
 * order waiting on a job is settled by the job's result instead. A lost order is retried until it runs out of attempts.
 */
export function orderStaleAction(o: OrderActivity, limitMinutes: number = ORDER_STUCK_MINUTES): OrderAction {
  if (o.state !== "running" || o.hasJob) return "keep";
  if (o.idleMinutes <= limitMinutes) return "keep";
  return o.attempts >= ORDER_MAX_ATTEMPTS ? "fail" : "requeue";
}

export interface OrderCounts {
  pending: number;
  running: number;
  done: number;
  failed: number;
}

export function countOrders(states: readonly string[]): OrderCounts {
  const c: OrderCounts = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const s of states) {
    if (s === "pending") c.pending++;
    else if (s === "running") c.running++;
    else if (s === "done") c.done++;
    else if (s === "failed") c.failed++;
  }
  return c;
}

/** The assets stage is complete when no order is waiting or running. Failed orders then end it in a stage error. */
export function assetsSettled(c: OrderCounts): boolean {
  return c.pending === 0 && c.running === 0;
}

export interface StageProbe {
  stage: ProductionStage;
  /** Minutes since the stage started (or last had activity for assets). */
  idleMinutes: number;
  /** Status of the stage's job, or null when it has none. */
  jobStatus: string | null;
  jobError?: string | null;
  orders?: OrderCounts;
}

export type StageAction =
  | { action: "none" }
  /** Assets: every order is settled but nobody concluded the stage. */
  | { action: "finalize" }
  /** Assets: orders are pending and nothing is running; run the stage again. */
  | { action: "resume" }
  /** Render or qc: the job finished, the hook was lost. */
  | { action: "complete" }
  | { action: "fail"; reason: string };

/** What the reaper does with one running production stage. Pure and idempotent: the same facts give the same answer. */
export function productionStageAction(p: StageProbe): StageAction {
  if (p.stage === "assets") {
    const o = p.orders ?? { pending: 0, running: 0, done: 0, failed: 0 };
    if (o.running > 0) return { action: "none" };
    if (o.pending === 0) return p.idleMinutes >= 1 ? { action: "finalize" } : { action: "none" };
    return p.idleMinutes > ORDER_STUCK_MINUTES ? { action: "resume" } : { action: "none" };
  }
  if (p.stage === "voice") {
    return p.idleMinutes > PRODUCTION_STUCK_MINUTES ? { action: "fail", reason: "The voice step stopped answering and was cancelled" } : { action: "none" };
  }
  const what = p.stage === "render" ? "The video render" : "The quality check";
  if (p.jobStatus === null) {
    return p.idleMinutes > PRODUCTION_STUCK_MINUTES ? { action: "fail", reason: `${what} was never queued` } : { action: "none" };
  }
  if (p.jobStatus === "succeeded") return { action: "complete" };
  if (p.jobStatus === "failed") return { action: "fail", reason: `${what} failed: ${(p.jobError ?? "").trim().slice(0, 300) || "the worker gave no reason"}` };
  if (p.jobStatus === "cancelled") return { action: "fail", reason: `${what} was cancelled` };
  return { action: "none" };
}

/**
 * Production stages are never revised automatically: a gate failure here (provider terms, a clipped voice, a
 * technical problem) is not fixed by running the same step again, so the owner is asked. Auto-publish does not
 * exist before Phase 5.
 */
export function productionDecision(d: Decision): Decision {
  if (d.action === "revise") return { action: "ask-owner", reason: `${d.reason}. Automatic revision is off for production steps` };
  if (d.action === "auto-publish") return { action: "ask-owner", reason: "Publishing is not automatic yet. Approve the video to finish this run" };
  return d;
}

/** Which stage a Retry restarts. A failed quality gate means the video itself is the problem, so it re-renders. */
export function retryStageFor(stage: RunStage, kind: ReviewKind): RunStage {
  return stage === "qc" && kind === "gate-failure" ? "render" : stage;
}

/** The text on the final approval card. G-presentation (the vision check) is not produced in Phase 4. */
export function finalReason(reason: string, missing: readonly GateId[]): string {
  const manual: string[] = [];
  if (missing.includes("G-presentation")) manual.push("how the video looks (presentation)");
  if (missing.includes("G-compliance") || missing.includes("G-claims")) manual.push("copyright and compliance");
  if (manual.length === 0) return reason;
  return `${reason}. These checks do not run automatically yet, so they are your call: ${manual.join(" and ")}.`;
}

/** Adds issues to a gate result and fails it. An empty list returns the gate unchanged. */
export function addGateIssues(g: GateResult, extra: readonly string[]): GateResult {
  if (extra.length === 0) return g;
  const out: GateResult = { gate: g.gate, passed: false, issues: [...g.issues, ...extra], executor: g.executor };
  return out;
}

/** True when every issue is about provider terms, which Settings fixes and a retry only re-checks. */
export function onlyTermsIssues(issues: readonly string[]): boolean {
  return issues.length > 0 && issues.every((i) => /commercial-use terms|cannot be published: Settings says/.test(i));
}

export interface FailedOrder {
  shotRef: string;
  error: string;
}

/** One plain line naming each failed shot and why, cut to fit the review card. */
export function failedOrdersMessage(orders: readonly FailedOrder[], max: number = 500): string {
  const lines = orders.map((o) => `${o.shotRef}: ${o.error.trim() || "no reason given"}`);
  let text = lines.join(" | ");
  if (text.length > max) text = `${text.slice(0, max - 3)}...`;
  return text || "An asset could not be made";
}

/** Licence text for the finished video, listing where each input came from. Written by code, never by a model. */
export function renderLicenseText(inputs: ReadonlyArray<{ title: string; provider: string; license: string }>): string {
  const head = "Own render made with VenStudio from these inputs.";
  const parts = inputs.map((i) => `${i.title} (${i.provider || "unknown provider"}): ${i.license}`.trim());
  const text = [head, ...parts].join(" ");
  return text.length > 1800 ? `${text.slice(0, 1797)}...` : text;
}

/** Caption lines for the render: the script cut into short sentences, at most what the worker accepts. */
export function captionLines(script: string): string[] {
  return chunkScript(script, CAPTION_LINE_CHARS).slice(0, MAX_CAPTION_LINES);
}

export const IMAGE_EXT: Record<string, "png" | "jpg" | "webp"> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** Every uuid the SQL casts from job payloads must pass this first, so a bad payload cannot throw in a query. */
export function asUuid(v: unknown): string | null {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
}

/** One short line for the review card and the run timeline. */
export function productionSummary(stage: ProductionStage, result: unknown): string {
  const r = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (stage === "assets") {
    const done = num(r.done);
    const providers = Array.isArray(r.providers) ? r.providers.filter((p): p is string => typeof p === "string") : [];
    return `${done} image${done === 1 ? "" : "s"} ready${providers.length ? ` from ${providers.join(", ")}` : ""}`;
  }
  if (stage === "voice") {
    const sec = num(r.narrationSec);
    const provider = typeof r.provider === "string" ? r.provider : "unknown";
    return `Narration by ${provider}${sec > 0 ? `, ${Math.round(sec)} seconds` : ""}`;
  }
  if (stage === "render") {
    const sec = num(r.durationSec);
    return `Video rendered${sec > 0 ? `, ${Math.round(sec)} seconds` : ""}`;
  }
  return "Quality check finished";
}
