/**
 * Render engine dispatch, cross-fade timing and the variation gate. Pure.
 *
 * `catalog.ts` declares six engines and the protocol declares their capabilities, but the worker has
 * only ever had one render path, so every job rendered as stills whatever the plan asked for. This
 * is the portal half of the fix: name the engine on the payload, refuse to plan an engine no worker
 * reports, and compute the cross-fade timing the stills path was documented to use
 * (`narrated-video-from-images`) but never had.
 *
 * The worker still builds the filtergraph. What lives here is the arithmetic it would otherwise get
 * wrong in the middle of a shell string.
 */
import { ENGINES } from "./catalog.ts";

export const DEFAULT_RENDER_ENGINE = "ffmpeg-stills";

export function renderEngines(): string[] {
  return Object.keys(ENGINES);
}

export function engineExists(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(ENGINES, id);
}

/** Worker capability that runs an engine, or null when the engine is unknown. */
export function capabilityForEngine(id: string): string | null {
  const e = ENGINES[id];
  return e ? e.capability : null;
}

/** Capability strings that mean "no worker runs this yet", not a worker capability. */
export const NON_WORKER_CAPABILITIES: readonly string[] = ["provider", "blender"];

export interface EngineGateInput {
  engine: string;
  /** Capabilities the target worker actually reported. */
  reported: readonly string[];
}

/**
 * Reasons a plan may not use this engine. Empty means it may.
 *
 * This is the gate that was missing: an engine whose capability is unreported can never be selected,
 * and an engine that is selected without the capability used to fall through silently to stills.
 */
export function engineIssues(i: EngineGateInput): string[] {
  const issues: string[] = [];
  if (!engineExists(i.engine)) {
    issues.push(`Unknown render engine "${i.engine}". Known engines: ${renderEngines().join(", ")}.`);
    return issues;
  }
  const need = capabilityForEngine(i.engine) as string;
  if (NON_WORKER_CAPABILITIES.includes(need)) {
    issues.push(`Engine "${i.engine}" is not run by a worker yet (capability "${need}"), so it cannot be planned.`);
    return issues;
  }
  if (!i.reported.includes(need)) {
    issues.push(
      `Engine "${i.engine}" needs capability "${need}", which the worker does not report` +
        (i.reported.length > 0 ? ` (it reports: ${i.reported.join(", ")})` : " (it reports nothing)") +
        `. Enable it on the worker before planning this engine.`,
    );
  }
  return issues;
}

/** Cross-fade names, cycled by position so a re-render of the same storyboard looks the same. */
export type TransitionName = "none" | "fade" | "slideup" | "wipeleft" | "circleopen";

const TRANSITION_CYCLE: readonly TransitionName[] = ["fade", "slideup", "fade", "wipeleft", "fade", "circleopen"];

/** Transition joining shot `index` to the one before it. Shot 0 has nothing before it. */
export function transitionFor(index: number): TransitionName {
  if (index <= 0) return "none";
  return TRANSITION_CYCLE[(index - 1) % TRANSITION_CYCLE.length];
}

export const MIN_TRANSITION_SEC = 0.15;
export const DEFAULT_TRANSITION_SEC = 0.5;
/** No shot may be reduced to less than this much exclusive screen time by the fades around it. */
export const MIN_EXCLUSIVE_SHOT_SEC = 0.4;

export interface CrossFadeOk {
  ok: true;
  /** When each shot begins, after overlaps. */
  starts: number[];
  /** `offset=` argument for each successive xfade: length is shots - 1. */
  offsets: number[];
  totalSec: number;
  transitionSec: number;
}
export interface CrossFadeBad {
  ok: false;
  issues: string[];
}
export type CrossFadePlan = CrossFadeOk | CrossFadeBad;

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Places shots on one timeline, overlapping each adjacent pair by `transitionSec`.
 *
 * With no transition this is a plain concatenation, so callers that pass 0 keep the old behaviour
 * exactly. Returns issues instead of a plan when the fade would eat a shot.
 */
export function planCrossFades(seconds: readonly number[], transitionSec: number): CrossFadePlan {
  const issues: string[] = [];
  if (seconds.length === 0) return { ok: false, issues: ["There are no shots to place on the timeline"] };
  seconds.forEach((s, i) => {
    if (!Number.isFinite(s) || s <= 0) issues.push(`Shot ${i + 1} has no usable length (${s})`);
  });
  if (!Number.isFinite(transitionSec) || transitionSec < 0) {
    issues.push(`Transition length is not usable (${transitionSec})`);
  }
  if (issues.length > 0) return { ok: false, issues };

  const n = seconds.length;
  const d = n < 2 ? 0 : transitionSec;
  if (d > 0 && d < MIN_TRANSITION_SEC) {
    return { ok: false, issues: [`Transition length ${d} s is below the ${MIN_TRANSITION_SEC} s minimum`] };
  }
  if (d > 0) {
    seconds.forEach((s, i) => {
      const count = (i > 0 ? 1 : 0) + (i < n - 1 ? 1 : 0);
      const exclusive = s - count * d;
      if (exclusive < MIN_EXCLUSIVE_SHOT_SEC) {
        issues.push(
          `A ${d} s transition leaves shot ${i + 1} only ${round(Math.max(0, exclusive))} s of its own ` +
            `(it is ${round(s)} s). Shorten the transition or lengthen the shot.`,
        );
      }
    });
    if (issues.length > 0) return { ok: false, issues };
  }

  const starts: number[] = [0];
  for (let i = 1; i < n; i++) starts.push(round(starts[i - 1] + seconds[i - 1] - d));
  const offsets = starts.slice(1);
  const totalSec = round(starts[n - 1] + seconds[n - 1]);
  return { ok: true, starts, offsets, totalSec, transitionSec: d };
}

/**
 * Largest transition at or below `requested` that still leaves every shot
 * `MIN_EXCLUSIVE_SHOT_SEC` of its own screen time.
 *
 * Call this before `planCrossFades` when the shot lengths come from a storyboard: a storyboard can
 * always produce a shot short enough to break a fixed fade, and degrading to hard cuts keeps a
 * render that used to work working. Returns 0 when even the smallest fade will not fit.
 */
export function fitTransitionSec(seconds: readonly number[], requested: number): number {
  if (seconds.length < 2) return 0;
  if (!(requested > 0)) return 0;
  const n = seconds.length;
  let cap = Infinity;
  for (let i = 0; i < n; i++) {
    const s = seconds[i];
    if (!Number.isFinite(s) || s <= 0) return 0;
    const counted = (i > 0 ? 1 : 0) + (i < n - 1 ? 1 : 0);
    cap = Math.min(cap, (s - MIN_EXCLUSIVE_SHOT_SEC) / counted);
  }
  const d = Math.min(requested, cap);
  return d >= MIN_TRANSITION_SEC ? round(d) : 0;
}

/**
 * Motion tokens a beat may declare, from `flat-vector-explainer-video`. Machine-readable here so the
 * coverage gate below has something to count.
 */
export const MOTION_TOKENS = [
  "draw",
  "pop",
  "gauge",
  "counter",
  "bar",
  "arrow",
  "tally",
  "particles",
  "pull",
  "push",
  "whip",
  "shake",
  "drift",
  "parallax",
  "scribble",
  "blot",
  "flicker",
  "morph",
  "dim",
] as const;
export type MotionToken = (typeof MOTION_TOKENS)[number];

export function isMotionToken(v: string): v is MotionToken {
  return (MOTION_TOKENS as readonly string[]).includes(v);
}

/** Pulls recognised tokens out of a beat's text or a declared token list, ignoring unknown words. */
export function parseMotionTokens(text: string): MotionToken[] {
  const found = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const out: MotionToken[] = [];
  for (const w of found) if (isMotionToken(w) && !out.includes(w)) out.push(w);
  return out;
}

export interface MotionBeat {
  label?: string;
  /** Tokens declared for this beat, if any. */
  tokens?: readonly string[];
  /** Text the tokens may also be read out of. */
  text?: string;
  /** True when the camera itself moves during this beat. */
  camera?: boolean;
}

export interface CoverageReport {
  total: number;
  covered: number;
  /** 0-based indexes of beats with neither an animated element nor a camera move. */
  uncovered: number[];
}

export function motionCoverage(beats: readonly MotionBeat[]): CoverageReport {
  const uncovered: number[] = [];
  beats.forEach((b, i) => {
    const declared = (b.tokens ?? []).filter(isMotionToken);
    const fromText = b.text ? parseMotionTokens(b.text) : [];
    const moving = declared.length > 0 || fromText.length > 0 || b.camera === true;
    if (!moving) uncovered.push(i);
  });
  return { total: beats.length, covered: beats.length - uncovered.length, uncovered };
}

export const MAX_UNCOVERED_REPORTED = 6;

/**
 * The rule `flat-vector-explainer-video` states in words: count coverage and fail loudly when a beat
 * has neither an animated element nor a camera move.
 */
export function coverageIssues(beats: readonly MotionBeat[], limit: number = MAX_UNCOVERED_REPORTED): string[] {
  if (beats.length === 0) return [];
  const r = motionCoverage(beats);
  if (r.uncovered.length === 0) return [];
  const named = r.uncovered
    .slice(0, limit)
    .map((i) => `beat ${i + 1}${beats[i].label ? ` ("${beats[i].label}")` : ""}`);
  const more = r.uncovered.length > named.length ? ` and ${r.uncovered.length - named.length} more` : "";
  return [
    `Only ${r.covered} of ${r.total} beats carry an animated element or a camera move. ` +
      `Without one: ${named.join(", ")}${more}. A beat with neither renders as a still.`,
  ];
}

/**
 * Refuses a plan that promises animated beats to an engine whose motion is stills-only, which is the
 * silent fallthrough that produced a slideshow in the first place.
 */
export function engineMotionIssues(engine: string, beats: readonly MotionBeat[]): string[] {
  if (!engineExists(engine)) return [];
  if (engine !== "ffmpeg-stills") return [];
  const animated = beats.filter((b) => (b.tokens ?? []).some((t) => isMotionToken(t) && t !== "drift")).length;
  if (animated === 0) return [];
  return [
    `The plan gives ${animated} beat(s) motion tokens, but engine "${engine}" only moves stills ` +
      `(zoom and pan). Those tokens will be ignored. Use an engine that animates, or drop the tokens.`,
  ];
}
