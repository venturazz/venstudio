/**
 * Pacing for calls to Hermes, pure: Retry-After parsing, backoff, error classes, the systemic-pause decision and the
 * plain texts the owner sees while the studio waits. No network and no database, so node --test can load it. The
 * shared call gate that uses these lives in lib/server/hermes-gate.ts.
 */

/**
 * Why a call failed.
 * - busy: rate limited or overloaded (HTTP 429 or 503, or a reply that says so), or slow: Hermes took the request but
 *   had not finished within the call timeout. Not a failure: the work waits.
 * - auth: the key was refused (401, 403).
 * - client: the request was refused as invalid (other 4xx). Retrying the same request on the same model cannot help.
 * - server: a 5xx or similar fault on the other side.
 * - unreachable: no connection: refused, a DNS failure or a connect timeout.
 * - content: the call worked but the answer was not usable for this item (bad JSON, no image, a file path).
 */
export type FailureClass = "busy" | "auth" | "client" | "server" | "unreachable" | "content";

export const FAILURE_CLASSES: readonly FailureClass[] = ["busy", "auth", "client", "server", "unreachable", "content"];

/** Causes that do not depend on the shot: when the first shots all fail with one of these, the stage pauses. */
export const SYSTEMIC_CAUSES: readonly FailureClass[] = ["busy", "auth", "unreachable", "server"];

/** First wait after a rate limit without Retry-After. Doubles per consecutive rate limit. */
export const BACKOFF_BASE_MS = 15_000;
/** Longest wait computed by backoff. */
export const BACKOFF_CAP_MS = 10 * 60_000;
/** Longest single wait taken from a Retry-After header. A day-long value is cut to this and asked again. */
export const MAX_RETRY_AFTER_MS = 60 * 60_000;
/** Shortest wait, so a Retry-After of 0 does not turn into a busy loop. */
export const MIN_WAIT_MS = 1_000;
/** A stage that has waited on Hermes this long becomes a stage error the owner can Retry. */
export const HERMES_WAIT_GIVE_UP_MS = 3 * 60 * 60_000;
/** A model turn waits at most this long for a free gate slot, then answers busy (and the stage waits a minute). */
export const GATE_QUEUE_TIMEOUT_SEC = 120;
/**
 * Call timeout of a Hermes ask that names no kind: images, voice through Hermes, the CC0 search, the presentation
 * advisory without its own limit. One image per turn takes about 150 s on the owner's Hermes, so 180 s stays.
 */
export const HERMES_DEFAULT_ASK_TIMEOUT_SEC = 180;
/** One Hermes ask without a kind in the worst case: the gate queue plus the 180 s call timeout. Media limits use it. */
export const HERMES_ASK_WORST_SEC = HERMES_DEFAULT_ASK_TIMEOUT_SEC + GATE_QUEUE_TIMEOUT_SEC;

/** The Hermes asks that have a call timeout of their own: the director stages and the script fit of the voice stage. */
export type HermesAskKind = "idea" | "research" | "script" | "storyboard" | "scene-spec" | "skill-brief" | "html-design" | "script-fit";

/**
 * Call timeout per ask, in seconds, sized to the work. Research searches the web with Hermes's tools; the HTML design
 * writes a whole page. The revision classifier (45 s), Test Hermes JSON (60 s), the capability scan, Check skills,
 * the lab analyses and the Hermes render keep the limits their callers set.
 */
export const HERMES_ASK_TIMEOUT_SEC: Readonly<Record<HermesAskKind, number>> = {
  idea: 4 * 60,
  research: 10 * 60,
  script: 6 * 60,
  storyboard: 8 * 60,
  "scene-spec": 8 * 60,
  "skill-brief": 8 * 60,
  "html-design": 12 * 60,
  "script-fit": 6 * 60,
};
/** A director stage asks at most this many times in one pass: the first ask and 2 retries (hermesJson's default). */
export const HERMES_STAGE_ASKS = 3;
/** Longest pause hermesText takes between two asks after a server error. */
export const HERMES_RETRY_PAUSE_SEC = 10;

/** One ask of this kind in the worst case: its gate queue wait, its call timeout and the pause before the next ask. */
export function hermesAskWorstSec(kind: HermesAskKind): number {
  return HERMES_ASK_TIMEOUT_SEC[kind] + GATE_QUEUE_TIMEOUT_SEC + HERMES_RETRY_PAUSE_SEC;
}

/** One pass of a stage in the worst case: every ask it may make. A slow answer ends the pass early (it waits instead). */
export function hermesStageWorstSec(kind: HermesAskKind, asks: number = HERMES_STAGE_ASKS): number {
  return Math.max(1, Math.floor(asks)) * hermesAskWorstSec(kind);
}

/**
 * Test use only: a factor (0 < f <= 1) that shortens the per-kind call timeouts and the slow-answer backoff, so the
 * browser end-to-end can make a research ask time out in seconds. Read only when NODE_ENV is "test" or CI is set
 * ("true" or "1", as GitHub Actions sets it); anywhere else, and for any unreadable value, it is 1. The stuck-stage
 * limits never use it, so a shortened run is only ever reaped later than it would be, never earlier.
 */
export function hermesTimeoutScale(e: Readonly<Record<string, string | undefined>>): number {
  const testing = e.NODE_ENV === "test" || e.CI === "true" || e.CI === "1";
  if (!testing) return 1;
  const f = Number((e.VENSTUDIO_TEST_HERMES_TIMEOUT_SCALE ?? "").trim());
  return Number.isFinite(f) && f > 0 && f <= 1 ? f : 1;
}

/** A duration times the scale, never under one second. */
export function scaledMs(ms: number, scale: number = 1): number {
  const f = Number.isFinite(scale) && scale > 0 && scale <= 1 ? scale : 1;
  return Math.max(1_000, Math.round(ms * f));
}

/** The call timeout of an ask of this kind, in milliseconds. */
export function hermesAskTimeoutMs(kind: HermesAskKind, scale: number = 1): number {
  return scaledMs(HERMES_ASK_TIMEOUT_SEC[kind] * 1000, scale);
}

/**
 * Waits after a slow answer (Hermes took the request but had not finished within the call timeout): 2, 5, then 10
 * minutes for every further one. A slow turn is not a rate limit, so it never sets the shared busy time of the gate.
 */
export const SLOW_BACKOFF_MS: readonly number[] = [2 * 60_000, 5 * 60_000, 10 * 60_000];

/** The wait after the `streak`-th slow answer in a row of one stage (1 for the first). */
export function slowBackoffMs(streak: number, scale: number = 1): number {
  const n = Number.isFinite(streak) ? Math.max(1, Math.floor(streak)) : 1;
  return scaledMs(SLOW_BACKOFF_MS[Math.min(n, SLOW_BACKOFF_MS.length) - 1], scale);
}

/** "10 min" from a minute up (rounded), "15 s" below. */
export function durationText(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}
/** How many first orders of a stage pass must fail the same systemic way before the stage pauses. */
export const SYSTEMIC_PAUSE_AFTER = 2;

export function isFailureClass(v: unknown): v is FailureClass {
  return typeof v === "string" && (FAILURE_CLASSES as readonly string[]).includes(v);
}

/**
 * Milliseconds to wait from a Retry-After header: delay-seconds ("5", "1.5") or an HTTP date. Null when the header is
 * missing or unreadable. A date in the past gives 0.
 */
export function parseRetryAfter(header: string | null | undefined, nowMs: number): number | null {
  const v = (header ?? "").trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  if (!/[a-z]/i.test(v)) return null;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/** Exponential backoff: base, 2x base, 4x base ... for the 1st, 2nd, 3rd consecutive rate limit, never above cap. */
export function backoffMs(consecutive: number, baseMs: number = BACKOFF_BASE_MS, capMs: number = BACKOFF_CAP_MS): number {
  const n = Number.isFinite(consecutive) ? Math.max(1, Math.floor(consecutive)) : 1;
  return Math.min(capMs, baseMs * 2 ** Math.min(n - 1, 30));
}

/** How long to wait after a rate limit: Retry-After when given (bounded), otherwise backoff. */
export function busyDelayMs(retryAfterMs: number | null, consecutive: number): number {
  if (retryAfterMs !== null && Number.isFinite(retryAfterMs)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_WAIT_MS, retryAfterMs));
  return Math.max(MIN_WAIT_MS, backoffMs(consecutive));
}

/** The class of an HTTP status, or null for a success or redirect. */
export function classifyStatus(status: number): FailureClass | null {
  if (status < 400) return null;
  if (status === 401 || status === 403) return "auth";
  if (status === 429 || status === 503) return "busy";
  if (status === 408) return "server";
  if (status < 500) return "client";
  return "server";
}

const RATE_LIMIT_TEXT =
  /rate[ -]?limit|too many requests|quota (?:is )?exceeded|exceeded (?:your|the) quota|(?:http|status|error|code)[ :]*429\b|\b429 too many|server is busy/i;

/** True for short text that says the provider is rate limited. Applied to error texts, never to whole answers. */
export function looksRateLimited(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 600) return false;
  return RATE_LIMIT_TEXT.test(t);
}

/**
 * True when a media reply (image, voice, CC0 search) that failed validation says the provider chain is rate limited:
 * the `error` of a `{"status":"error"}` JSON reply, or a short plain-text reply. A normal answer that only mentions
 * such words (a story about the year 429) is never read this way, and director stages do not use this check.
 */
export function replySaysRateLimited(reply: string): boolean {
  const t = reply.trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(t.slice(start, end + 1)) as unknown;
      if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
      const r = v as { status?: unknown; error?: unknown };
      return r.status === "error" && typeof r.error === "string" && looksRateLimited(r.error);
    } catch {
      return false;
    }
  }
  return t.length <= 300 && looksRateLimited(t);
}

/** Classifies a failed media reply that came back with HTTP 200 but no usable answer. */
export function classifyReplyFailure(reply: string): FailureClass {
  return replySaysRateLimited(reply) ? "busy" : "content";
}

/**
 * One cause for a work order that failed every step of its chain. Client errors are model specific (that model is set
 * aside), so they are left out when other causes exist. One systemic cause shared by all the remaining steps wins;
 * a mix of systemic causes gives the first; anything content related makes it a content failure.
 */
export function orderFailureCause(causes: readonly FailureClass[]): FailureClass {
  if (causes.length === 0) return "content";
  const rest = causes.filter((c) => c !== "client");
  if (rest.length === 0) return "client";
  if (rest.every((c) => (SYSTEMIC_CAUSES as readonly string[]).includes(c))) return rest[0];
  return "content";
}

export type PauseDecision = { pause: false } | { pause: true; cause: FailureClass };

/**
 * Whether a stage pass should pause instead of failing more shots. Outcomes are in claim order ("ok" for a finished
 * or waiting order). Pauses only when the first `after` outcomes all failed with the same systemic cause; one success
 * or one shot-specific failure among them means the problem is not systemic.
 */
export function systemicPause(outcomes: ReadonlyArray<FailureClass | "ok">, after: number = SYSTEMIC_PAUSE_AFTER): PauseDecision {
  const n = Math.max(1, Math.floor(after));
  if (outcomes.length < n) return { pause: false };
  const first = outcomes.slice(0, n);
  const cause = first[0];
  if (cause === "ok" || !(SYSTEMIC_CAUSES as readonly string[]).includes(cause)) return { pause: false };
  return first.every((o) => o === cause) ? { pause: true, cause } : { pause: false };
}

const CAUSE_TEXT: Record<FailureClass, string> = {
  busy: "the image providers are rate limited or overloaded",
  auth: "Hermes rejected the key. HERMES_API_KEY must equal Hermes's API_SERVER_KEY",
  client: "the request was refused",
  server: "Hermes answered with a server error",
  unreachable: "Hermes could not be reached",
  content: "the answers were not usable",
};

/** The stage error text when a pass pauses. At most `max` characters. */
export function pauseMessage(cause: FailureClass, count: number, sample: string, max: number = 500): string {
  const head = `Paused after the first ${count} shots failed the same way: ${CAUSE_TEXT[cause]}. No shot was counted as failed and the other shots were not tried. Fix the cause, then press Retry.`;
  const tail = sample.trim() ? ` Last error: ${sample.trim()}` : "";
  const text = `${head}${tail}`;
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** HH:MM in UTC. Pages render on the server, so the zone is stated instead of guessed. */
export function clockUtc(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

export type WaitReason = "rate-limit" | "queue";

/** The plain status shown on the run page and in Review while a stage waits for Hermes. */
export function waitingText(untilMs: number, nowMs: number, reason: WaitReason = "rate-limit"): string {
  const why = reason === "queue" ? "busy with other studio work" : "rate limited";
  const mins = Math.ceil((untilMs - nowMs) / 60_000);
  const when = untilMs <= nowMs ? "any moment now" : mins <= 1 ? "in under a minute" : `in about ${mins} min`;
  return `Waiting for Hermes (${why}), next try at ${clockUtc(untilMs)} UTC, ${when}`;
}

function untilText(untilMs: number, nowMs: number): string {
  const mins = Math.ceil((untilMs - nowMs) / 60_000);
  return untilMs <= nowMs ? "any moment now" : mins <= 1 ? "in under a minute" : `in about ${mins} min`;
}

/** The status while a stage waits after a slow answer. `afterMs` is the call timeout the answer did not finish in. */
export function slowWaitText(untilMs: number, nowMs: number, afterMs: number): string {
  return `Hermes is busy or slow (it answered nothing in ${durationText(afterMs)}); trying again at ${clockUtc(untilMs)} UTC, ${untilText(untilMs, nowMs)}`;
}

/** Why a stage waits, as deferStage stores it in `output.hermesWait`. Older rows have no reason: a rate limit. */
export interface StoredWait {
  reason: "rate-limit" | "slow";
  afterMs: number;
}

export function readStoredWait(v: unknown): StoredWait {
  const w = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const afterMs = typeof w.afterMs === "number" && Number.isFinite(w.afterMs) && w.afterMs > 0 ? w.afterMs : 0;
  return w.reason === "slow" && afterMs > 0 ? { reason: "slow", afterMs } : { reason: "rate-limit", afterMs: 0 };
}

/** The run page and Review line for a stage that waits: the slow-answer text when that is why, else the rate limit text. */
export function stageWaitText(hermesWait: unknown, untilMs: number, nowMs: number): string {
  const w = readStoredWait(hermesWait);
  return w.reason === "slow" ? slowWaitText(untilMs, nowMs, w.afterMs) : waitingText(untilMs, nowMs);
}

/** Reads a stored time (ISO text or epoch milliseconds). Null when it is missing or unreadable. */
export function readTime(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.getTime();
  return null;
}

/** True when a wait that started at `since` has gone on longer than the cap. A missing start never expires. */
export function waitExpired(since: unknown, nowMs: number, capMs: number = HERMES_WAIT_GIVE_UP_MS): boolean {
  const t = readTime(since);
  return t !== null && nowMs - t > capMs;
}

export function giveUpMessage(capMs: number = HERMES_WAIT_GIVE_UP_MS, reason: "rate-limit" | "slow" = "rate-limit"): string {
  const hours = Math.round(capMs / 3_600_000);
  const what = reason === "slow" ? "busy or slow" : "rate limited";
  return `Hermes stayed ${what} for more than ${hours} hour${hours === 1 ? "" : "s"}, so this step stopped. Press Retry when Hermes is free again.`;
}

/** Bounded concurrency for the gate: an optional override, otherwise 1. */
export function gateConcurrency(raw: string | undefined): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 8) : 1;
}
