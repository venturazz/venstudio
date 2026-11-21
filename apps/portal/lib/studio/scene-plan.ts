/**
 * The scene contract an animating template renders from. Pure.
 *
 * The stills engine wanted one image per shot, so a storyboard was enough. A template that animates
 * needs to know what is on screen *inside* the shot and what moves. This derives that from the
 * storyboard, the style and the format, so the renderer receives elements and clocks instead of
 * inventing them.
 *
 * This is the data half of `docs/plans/2026-11-20-render-templates-from-skills.md`. The code half —
 * the template components — lives with the renderer.
 */
import { ENGINES, STYLE_BY_ID, VIDEO_FORMATS, type Family, type Format, type Style } from "./catalog.ts";
import type { Shot } from "./director.ts";
import type { BeatRole } from "./templates.ts";
import {
  DEFAULT_TRANSITION_SEC,
  coverageIssues,
  engineIssues,
  engineMotionIssues,
  fitTransitionSec,
  parseMotionTokens,
  type MotionToken,
} from "./render-engine.ts";

export const MAX_SCENES = 80;
export const MAX_ELEMENTS_PER_SCENE = 6;
export const MAX_ELEMENT_CHARS = 140;
export const MAX_ISSUES_REPORTED = 8;

/** Clock for a character layer. The skill's range is 40-60 frames at 30 fps. */
export const PERSON_FPS = 30;
/** Props move on their own clocks, unrelated to the character's. Fixed, so a re-render matches. */
export const PROP_CLOCKS: readonly { id: string; frames: number; fps: number }[] = [
  { id: "prop-a", frames: 9, fps: 6 },
  { id: "prop-b", frames: 7, fps: 10 },
];

/**
 * Elements a template can draw. `plate` is the still the scene sits on; the rest are drawn or
 * animated over it.
 */
export type ElementKind = "plate" | "heading" | "callout" | "counter" | "bar" | "gauge" | "arrow" | "tally" | "particles" | "diagram";

export interface SceneElement {
  kind: ElementKind;
  /** Text the element shows, when it shows text. */
  text?: string;
}

/** One layer of a scene, with its own clock. A layer of 1 frame never changes. */
export interface SceneLayer {
  id: string;
  frames: number;
  fps: number;
}

export interface Scene {
  shotRef: string;
  seconds: number;
  beatRole: BeatRole;
  elements: SceneElement[];
  /** Motion tokens this scene declares for the template to interpret. */
  tokens: MotionToken[];
  /** True when the camera moves. On a stills engine this is the only motion there is. */
  camera: boolean;
  layers: SceneLayer[];
}

export interface ScenePlan {
  version: 1;
  /** Key into ENGINES. The worker dispatches on this. */
  engine: string;
  /** Template id, which is the style id. */
  template: string;
  family: Family;
  width: number;
  height: number;
  fps: number;
  transitionSec: number;
  scenes: Scene[];
}

export interface ScenePlanInput {
  styleId: string;
  format: Format;
  shots: readonly Shot[];
  /** Cross-fade between scenes. Defaults to DEFAULT_TRANSITION_SEC, fitted down to the shot lengths. */
  transitionSec?: number;
  /** Every Nth scene moves the camera. Default 2. */
  cameraEvery?: number;
}

export type ScenePlanResult = { ok: true; plan: ScenePlan; warnings: string[] } | { ok: false; issues: string[] };

/** Default tokens per beat role, so every beat carries movement unless the storyboard says more. */
const ROLE_TOKENS: Record<BeatRole, MotionToken[]> = {
  hook: ["pop"],
  setup: ["drift"],
  body: ["draw"],
  payoff: ["morph"],
  cta: ["pop"],
  outro: ["dim"],
};

/** A token that only means "the camera moves", so a stills engine may legitimately carry it. */
export const CAMERA_ONLY_TOKENS: readonly MotionToken[] = ["drift"];

const TOKEN_ELEMENT: Partial<Record<MotionToken, ElementKind>> = {
  draw: "diagram",
  pop: "callout",
  morph: "diagram",
  counter: "counter",
  bar: "bar",
  gauge: "gauge",
  arrow: "arrow",
  tally: "tally",
  particles: "particles",
};

const unique = <T,>(xs: readonly T[]): T[] => [...new Set(xs)];

/** True when the engine animates what is inside the frame, not only the camera. */
export function elementAnimationFor(engineId: string): boolean {
  const e = ENGINES[engineId];
  if (!e) return false;
  return !["ffmpeg", "provider", "blender"].includes(e.capability);
}

function firstLine(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  const m = t.match(/^.*?[.!?](\s|$)/);
  const s = (m ? m[0] : t).trim();
  return s.length > MAX_ELEMENT_CHARS ? `${s.slice(0, MAX_ELEMENT_CHARS - 1).trimEnd()}…` : s;
}

function numbersIn(text: string): string[] {
  return text.match(/\d[\d.,]*%?/g) ?? [];
}

function layersFor(fps: number, seconds: number, layeredArt: boolean): SceneLayer[] {
  const layers: SceneLayer[] = [{ id: "plate", frames: 1, fps: 1 }];
  if (layeredArt) {
    layers.push({ id: "person", frames: Math.max(1, Math.round(seconds * PERSON_FPS)), fps: PERSON_FPS });
    for (const p of PROP_CLOCKS) layers.push({ ...p });
  } else {
    layers.push({ id: "scene", frames: Math.max(1, Math.round(seconds * fps)), fps });
  }
  return layers;
}

function sceneFor(shot: Shot, index: number, style: Style, size: { width: number; height: number; fps: number }, cameraEvery: number, animates: boolean): Scene {
  const shotRef = `shot-${String(index + 1).padStart(2, "0")}`;
  const text = `${shot.description} ${shot.imagePrompt}`;
  const declared = parseMotionTokens(text);
  // A stills engine cannot interpret element tokens, so it gets the one token that means a camera
  // move, and the old four linear Ken Burns moves keep doing the rest.
  const tokens: MotionToken[] = animates ? unique<MotionToken>([...(ROLE_TOKENS[shot.beatRole] ?? []), ...declared]) : unique<MotionToken>(["drift", ...declared.filter((t) => CAMERA_ONLY_TOKENS.includes(t))]);
  const camera = !animates || shot.beatRole === "hook" || index % Math.max(1, cameraEvery) === 0;

  const elements: SceneElement[] = [];
  const heading = firstLine(shot.description);
  if (heading) elements.push({ kind: "heading", text: heading });
  if (style.assetKinds.includes("image")) elements.push({ kind: "plate" });
  const nums = numbersIn(text);
  if (nums.length > 0) elements.push({ kind: "counter", text: nums.slice(0, 4).join(", ") });
  for (const t of tokens) {
    const kind = TOKEN_ELEMENT[t];
    if (kind && !elements.some((e) => e.kind === kind)) elements.push({ kind });
  }

  return {
    shotRef,
    seconds: shot.seconds,
    beatRole: shot.beatRole,
    elements: elements.slice(0, MAX_ELEMENTS_PER_SCENE),
    tokens,
    camera,
    layers: layersFor(size.fps, shot.seconds, style.assetKinds.includes("sprite-sheet")),
  };
}

export interface ScenePlanCheck {
  /** Capabilities the target worker reported. Omit to skip the engine gate. */
  reported?: readonly string[];
}

/** Reasons a scene plan may not go to a renderer. Empty means it may. */
export function scenePlanIssues(plan: ScenePlan, check: ScenePlanCheck = {}): string[] {
  const issues: string[] = [];
  if (plan.scenes.length === 0) issues.push("The plan has no scenes");
  if (plan.scenes.length > MAX_SCENES) issues.push(`The plan has ${plan.scenes.length} scenes, more than the ${MAX_SCENES} a plan holds`);
  if (!(plan.width > 0) || !(plan.height > 0)) issues.push("The plan has no frame size");
  if (!(plan.fps > 0)) issues.push("The plan has no frame rate");
  if (check.reported) issues.push(...engineIssues({ engine: plan.engine, reported: check.reported }));
  issues.push(...coverageIssues(plan.scenes.map((s) => ({ label: s.shotRef, tokens: s.tokens, camera: s.camera }))));
  issues.push(...engineMotionIssues(plan.engine, plan.scenes));

  plan.scenes.forEach((s, idx) => {
    const at = `Scene ${idx + 1} (${s.shotRef})`;
    if (!(s.seconds > 0)) issues.push(`${at} has no usable length`);
    else if (!Number.isFinite(s.seconds)) issues.push(`${at} has a length that is not a number`);
    if (s.elements.length === 0) issues.push(`${at} has nothing on screen`);
    if (s.elements.length > MAX_ELEMENTS_PER_SCENE) issues.push(`${at} asks for ${s.elements.length} elements, more than the ${MAX_ELEMENTS_PER_SCENE} a template lays out`);
    for (const e of s.elements) {
      if (e.text && e.text.length > MAX_ELEMENT_CHARS) issues.push(`${at} has a ${e.text.length}-character ${e.kind}, over the ${MAX_ELEMENT_CHARS}-character limit`);
    }
    if (s.layers.length === 0) issues.push(`${at} has no layers`);
    for (const l of s.layers) {
      if (!(l.frames >= 1)) issues.push(`${at} layer "${l.id}" contributes no frames`);
      if (!(l.fps > 0)) issues.push(`${at} layer "${l.id}" has no clock`);
    }
    // The layer-stack look is the non-uniform clock, so a layered scene needs two of them.
    const clocks = new Set(s.layers.filter((l) => l.frames > 1).map((l) => l.fps));
    if (s.layers.length > 2 && clocks.size < 2) issues.push(`${at} has layered art but fewer than two clocks: every layer but the plate has to move on its own.`);
  });

  if (issues.length > MAX_ISSUES_REPORTED) {
    const extra = issues.length - MAX_ISSUES_REPORTED;
    return [...issues.slice(0, MAX_ISSUES_REPORTED), `and ${extra} more problem(s)`];
  }
  return issues;
}

/** Builds the scene plan for one production from its storyboard and its style. */
export function buildScenePlan(i: ScenePlanInput): ScenePlanResult {
  const style = STYLE_BY_ID[i.styleId];
  const f = VIDEO_FORMATS[i.format];
  const issues: string[] = [];
  if (!style) issues.push(`Unknown style "${i.styleId}"`);
  if (!f) issues.push(`Unknown format "${i.format}"`);
  if (i.shots.length === 0) issues.push("There are no shots to lay out");
  if (i.shots.length > MAX_SCENES) issues.push(`${i.shots.length} shots is more than the ${MAX_SCENES} scenes a plan holds`);
  if (issues.length > 0 || !style || !f) return { ok: false, issues };

  const warnings: string[] = [];
  const requested = i.transitionSec ?? DEFAULT_TRANSITION_SEC;
  const transitionSec = fitTransitionSec(i.shots.map((s) => s.seconds), requested);
  if (requested > 0 && transitionSec === 0) warnings.push("The shots are too short for a cross-fade, so the plan uses hard cuts.");

  const animates = elementAnimationFor(style.engine);
  if (!animates) warnings.push(`${style.label} renders on ${style.engine}, which moves the camera rather than the elements, so its scenes carry a camera move instead of motion tokens.`);

  const size = { width: f.width, height: f.height, fps: f.fps };
  const scenes = i.shots.map((s, idx) => sceneFor(s, idx, style, size, i.cameraEvery ?? 2, animates));
  const plan: ScenePlan = { version: 1, engine: style.engine, template: style.id, family: style.family, ...size, transitionSec, scenes };

  const problems = scenePlanIssues(plan);
  if (problems.length > 0) return { ok: false, issues: problems };
  return { ok: true, plan, warnings };
}

export interface StyleRenderParams {
  engine: string;
  template: string;
  transitionSec: number;
  /** True when the engine animates elements, not only the camera. */
  elementAnimation: boolean;
}

/**
 * What the renderer needs to know about a style. Returns null for an unknown style, so a caller can
 * fall back to the stills engine rather than guessing.
 */
export function renderParamsForStyle(styleId: string): StyleRenderParams | null {
  const style = STYLE_BY_ID[styleId];
  if (!style) return null;
  return { engine: style.engine, template: style.id, transitionSec: DEFAULT_TRANSITION_SEC, elementAnimation: elementAnimationFor(style.engine) };
}
