/** Builds the render-video job payload from the storyboard, the picked assets and the narration. Pure. */
import { VIDEO_FORMATS, type Format } from "./catalog.ts";
import { DEFAULT_RENDER_ENGINE, engineExists, planCrossFades } from "./render-engine.ts";

export type Motion = "zoom-in" | "zoom-out" | "pan-left" | "pan-right";
const MOTIONS: readonly Motion[] = ["zoom-in", "pan-left", "zoom-out", "pan-right"];

/** Ken Burns motion for a shot, fixed by its position so a re-render looks the same. */
export function motionFor(index: number): Motion {
  return MOTIONS[((index % MOTIONS.length) + MOTIONS.length) % MOTIONS.length];
}

export const MIN_SHOT_SECONDS = 1;
/** Shots may not leave more than this much narration uncovered or run past it. */
export const COVER_TOLERANCE_SEC = 0.5;

/** The render planner stretches each shot up to the template limit, so this is the most narration n shots can cover. */
export function maxCoverSec(shotCount: number, maxShotSeconds: number): number {
  return shotCount * maxShotSeconds;
}

/** Margin the storyboard gate keeps because a narration estimate from word count is not exact. */
export const NARRATION_ESTIMATE_TOLERANCE = 0.1;

export interface RenderShotInput {
  shotRef: string;
  seconds: number;
}

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

export interface RenderPayload {
  format: Format;
  width: number;
  height: number;
  fps: number;
  /** Engine the worker must dispatch to. Until this field exists nothing dispatches. */
  engine: string;
  /** Cross-fade between adjacent shots. 0 means hard cuts. */
  transitionSec: number;
  shots: Array<{ shotRef: string; assetId: string; seconds: number; motion: Motion }>;
  narrationAssetId: string;
  narrationSec: number;
  durationSec: number;
  captions: CaptionCue[];
  targetLufs: number;
  runId?: string;
  /** Font asset for burned-in captions. Null when the library has none, and the worker then skips captions. */
  fontAssetId: string | null;
  /** Every asset id the worker may download. */
  inputs: string[];
}

export type RenderPlan = { ok: true; payload: RenderPayload } | { ok: false; issues: string[] };

export interface RenderInput {
  format: Format;
  shots: RenderShotInput[];
  /** Asset id per shotRef. */
  shotAssets: Record<string, string | null | undefined>;
  narrationAssetId: string | null;
  narrationSec: number;
  /** Caption lines in speaking order. Timed across the narration by length. */
  captions: string[];
  targetLufs: number;
  /** Engine to plan for. Defaults to the stills engine, which is the only one a worker runs today. */
  engine?: string;
  /** Cross-fade between adjacent shots. 0 or absent means hard cuts, which is what the worker did before. */
  transitionSec?: number;
  /** Template pacing limit for one shot. */
  maxShotSeconds: number;
  /** Newest font in the library, if any. */
  fontAssetId?: string | null;
  runId?: string;
}

/** Spreads cue times over the narration in proportion to each line's length. */
export function captionCues(lines: string[], narrationSec: number): CaptionCue[] {
  const clean = lines.map((l) => l.trim()).filter(Boolean);
  const total = clean.reduce((n, l) => n + l.length, 0);
  if (total === 0 || narrationSec <= 0) return [];
  let t = 0;
  return clean.map((text) => {
    const start = t;
    t += (text.length / total) * narrationSec;
    return { start: round(start), end: round(t), text };
  });
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Scales shot lengths to the narration, keeping each between the minimum and the template limit. */
function rescale(seconds: number[], target: number, max: number): number[] {
  let out = seconds.map((s) => Math.min(max, Math.max(MIN_SHOT_SECONDS, s)));
  for (let pass = 0; pass < 6; pass++) {
    const sum = out.reduce((a, b) => a + b, 0);
    const delta = target - sum;
    if (Math.abs(delta) < 0.001) break;
    const room = out.map((s) => (delta > 0 ? max - s : s - MIN_SHOT_SECONDS));
    const free = room.reduce((a, b) => a + Math.max(0, b), 0);
    if (free <= 0.0001) break;
    const take = Math.min(Math.abs(delta), free);
    out = out.map((s, i) => {
      const share = (Math.max(0, room[i]) / free) * take;
      return delta > 0 ? s + share : s - share;
    });
  }
  return out.map(round);
}

export function buildRenderPayload(i: RenderInput): RenderPlan {
  const issues: string[] = [];
  if (i.shots.length === 0) issues.push("There are no shots to render");
  const missing = i.shots.filter((s) => !i.shotAssets[s.shotRef]).map((s) => s.shotRef);
  if (missing.length > 0) issues.push(`No image for ${missing.join(", ")}`);
  if (!i.narrationAssetId) issues.push("There is no narration to render");
  if (!(i.narrationSec > 0)) issues.push("The narration length is unknown");
  const engine = i.engine ?? DEFAULT_RENDER_ENGINE;
  if (!engineExists(engine)) issues.push(`Unknown render engine "${engine}"`);
  if (issues.length > 0) return { ok: false, issues };

  // A cross-fade shortens the timeline by the overlap, so the shots must grow by it or the narration
  // would run past the video. With no transition this is exactly the old target.
  const fadeSec = i.shots.length > 1 ? i.transitionSec ?? 0 : 0;
  const target = i.narrationSec + (i.shots.length - 1) * fadeSec;
  const secs = rescale(i.shots.map((s) => s.seconds), target, i.maxShotSeconds);
  const fade = planCrossFades(secs, fadeSec);
  if (!fade.ok) return { ok: false, issues: fade.issues };
  const total = fade.totalSec;
  if (total < i.narrationSec - COVER_TOLERANCE_SEC) {
    return {
      ok: false,
      issues: [`The shots can fill at most ${round(total)} s, but the narration is ${round(i.narrationSec)} s. Add shots to the storyboard.`],
    };
  }
  if (total > i.narrationSec + COVER_TOLERANCE_SEC) {
    return {
      ok: false,
      issues: [`The shots need at least ${round(total)} s, but the narration is only ${round(i.narrationSec)} s. Remove shots from the storyboard.`],
    };
  }
  const f = VIDEO_FORMATS[i.format];
  const shots = i.shots.map((s, idx) => ({ shotRef: s.shotRef, assetId: i.shotAssets[s.shotRef] as string, seconds: secs[idx], motion: motionFor(idx) }));
  const fontAssetId = i.fontAssetId || null;
  const inputs = Array.from(new Set([...shots.map((s) => s.assetId), i.narrationAssetId as string, ...(fontAssetId ? [fontAssetId] : [])]));
  const payload: RenderPayload = {
    format: i.format,
    width: f.width,
    height: f.height,
    fps: f.fps,
    engine,
    transitionSec: fade.transitionSec,
    shots,
    narrationAssetId: i.narrationAssetId as string,
    narrationSec: round(i.narrationSec),
    durationSec: round(total),
    captions: captionCues(i.captions, i.narrationSec),
    targetLufs: i.targetLufs,
    fontAssetId,
    inputs,
  };
  if (i.runId) payload.runId = i.runId;
  return { ok: true, payload };
}
