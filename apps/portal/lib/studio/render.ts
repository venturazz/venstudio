/** Builds the render-video job payload from the storyboard, the picked assets and the narration. Pure. */
import { VIDEO_FORMATS, type Format } from "./catalog.ts";
import type { AudioPlan } from "./audio-plan.ts";
import { captionSpecIssues, type CaptionSpec } from "./caption-spec.ts";
import { DEFAULT_RENDER_ENGINE, engineExists, engineIssues, planCrossFades } from "./render-engine.ts";
import { RENDER_LIMITS } from "./render-limits.ts";
import { scenePlanIssues, type ScenePlan } from "./scene-plan.ts";

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
  /** The pack's own story words for this shot (contract.story), carried to the page untouched. */
  /** Story words or composed parts: whatever the pack's page reads (intent.parts when the kit has no such thing). */
  intent?: Record<string, unknown>;
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
  /** Scene plan, for engines that animate elements. Absent when the stills engine has enough. */
  scenePlan?: ScenePlan;
  shots: Array<{ shotRef: string; assetId: string; seconds: number; motion: Motion; intent?: Record<string, unknown> }>;
  narrationAssetId: string;
  /** Length of the narration as it plays (after narrationTempo). */
  narrationSec: number;
  /**
   * Tempo the worker applies to the narration file (ffmpeg atempo, worker 0.6.0+). Absent means 1, so a payload
   * without a fit is byte-identical to before.
   */
  narrationTempo?: number;
  durationSec: number;
  captions: CaptionCue[];
  targetLufs: number;
  /** Caption geometry the burn-in has to use. Absent means the worker keeps its own numbers. */
  captionStyle?: CaptionSpec;
  /** The audio layers and the numbers to mix them at. Absent means narration alone. */
  audio?: AudioPlan;
  runId?: string;
  /** Font asset for burned-in captions. Null when the library has none, and the worker then skips captions. */
  fontAssetId: string | null;
  /** Every asset id the worker may download. */
  inputs: string[];
  /**
   * html-design (worker 0.11.0+): the page Hermes wrote, an html-page asset listed in inputs. Absent for every other
   * payload, which is then byte-identical to before.
   */
  page?: { assetId: string };
}

export type RenderPlan = { ok: true; payload: RenderPayload } | { ok: false; issues: string[] };

export interface RenderInput {
  format: Format;
  shots: RenderShotInput[];
  /** Asset id per shotRef. */
  shotAssets: Record<string, string | null | undefined>;
  narrationAssetId: string | null;
  /** Length of the narration as it plays: the measured length divided by narrationTempo. */
  narrationSec: number;
  /** Tempo chosen to fit the narration to the shots. 1 or absent: none, and the payload has no narrationTempo. */
  narrationTempo?: number;
  /** Caption lines in speaking order. Timed across the narration by length. */
  captions: string[];
  targetLufs: number;
  /** Engine to plan for. Defaults to the stills engine, which is the only one a worker runs today. */
  engine?: string;
  /** Cross-fade between adjacent shots. 0 or absent means hard cuts, which is what the worker did before. */
  transitionSec?: number;
  /** Scene plan from `buildScenePlan`, for an animating engine. */
  scenePlan?: ScenePlan;
  /** Caption geometry for this frame. Without one the worker keeps its own numbers. */
  captionSpec?: CaptionSpec;
  /** True when the template requires captions, which makes a missing font a plan failure. */
  captionRequired?: boolean;
  /** The audio plan from `buildAudioPlan`. Its master loudness has to agree with `targetLufs`. */
  audioPlan?: AudioPlan;
  /** Capabilities the target worker reported. When given, an engine it cannot run fails here instead of silently rendering stills. */
  workerCapabilities?: readonly string[];
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
  // The worker's own limits (render-limits.ts): refused here, before a job is queued, never by the worker mid-render.
  if (i.shots.length > RENDER_LIMITS.maxShots) issues.push(`${i.shots.length} shots is more than the ${RENDER_LIMITS.maxShots} one render takes`);
  if (i.captions.length > RENDER_LIMITS.maxCaptions) issues.push(`${i.captions.length} caption lines is more than the ${RENDER_LIMITS.maxCaptions} one render takes`);
  const missing = i.shots.filter((s) => !i.shotAssets[s.shotRef]).map((s) => s.shotRef);
  if (missing.length > 0) issues.push(`No image for ${missing.join(", ")}`);
  if (!i.narrationAssetId) issues.push("There is no narration to render");
  if (!(i.narrationSec > 0)) issues.push("The narration length is unknown");
  const engine = i.engine ?? DEFAULT_RENDER_ENGINE;
  if (!engineExists(engine)) issues.push(`Unknown render engine "${engine}"`);
  if (i.workerCapabilities) issues.push(...engineIssues({ engine, reported: i.workerCapabilities }));
  if (i.scenePlan) {
    if (i.scenePlan.engine !== engine) issues.push(`The scene plan is for engine "${i.scenePlan.engine}", but this render is for "${engine}"`);
    issues.push(...scenePlanIssues(i.scenePlan, i.workerCapabilities ? { reported: i.workerCapabilities } : {}));
  }
  if (i.captionSpec) {
    const f = VIDEO_FORMATS[i.format];
    issues.push(...captionSpecIssues(i.captionSpec, { width: f.width, height: f.height }, { required: i.captionRequired === true }));
    // The font is named twice — on the payload and inside the spec — and the worker downloads by the
    // payload list. Two names that disagree would silently drop the caption.
    if (i.captionSpec.fontAssetId && i.fontAssetId && i.captionSpec.fontAssetId !== i.fontAssetId) {
      issues.push(`The caption spec names font ${i.captionSpec.fontAssetId}, but the payload names ${i.fontAssetId}`);
    }
  }
  // One loudness target, not two that happen to agree today.
  if (i.audioPlan && Math.abs(i.audioPlan.master.targetLufs - i.targetLufs) > 0.01) {
    issues.push(`The audio plan masters at ${i.audioPlan.master.targetLufs} LUFS, but the payload targets ${i.targetLufs} LUFS`);
  }
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
  const shots = i.shots.map((s, idx) => ({
    shotRef: s.shotRef,
    assetId: i.shotAssets[s.shotRef] as string,
    seconds: secs[idx],
    motion: motionFor(idx),
    // The story words the pack's page draws. Absent for every look without a vocabulary, so old payloads are unchanged.
    ...(s.intent ? { intent: { ...s.intent } } : {}),
  }));
  const fontAssetId = i.fontAssetId || i.captionSpec?.fontAssetId || null;
  const audioInputs = [...(i.audioPlan?.bed ? [i.audioPlan.bed.assetId] : []), ...(i.audioPlan?.sfx.map((s) => s.assetId) ?? [])];
  const inputs = Array.from(new Set([...shots.map((s) => s.assetId), i.narrationAssetId as string, ...(fontAssetId ? [fontAssetId] : []), ...audioInputs]));
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
  if (i.scenePlan) payload.scenePlan = i.scenePlan;
  if (i.captionSpec) payload.captionStyle = i.captionSpec;
  if (i.audioPlan) payload.audio = i.audioPlan;
  if (i.runId) payload.runId = i.runId;
  if (typeof i.narrationTempo === "number" && Number.isFinite(i.narrationTempo) && i.narrationTempo > 0 && i.narrationTempo !== 1) {
    payload.narrationTempo = Math.round(i.narrationTempo * 1000) / 1000;
  }
  return { ok: true, payload };
}
