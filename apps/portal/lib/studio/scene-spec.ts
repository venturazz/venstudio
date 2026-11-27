/**
 * The scene spec of a data-driven page (recipe scene-spec, recipes.ts), pure: the Hermes prompt, the validator of its
 * JSON, the gate, and the shots the render plans from. It stands where the storyboard stands in an image-sequence run,
 * and nothing in it asks for a picture.
 *
 * Hermes answers through the gate with JSON: per scene its seconds, beat, on-screen elements (with value, series and
 * labels), motion tokens and caption. The validator checks the shape against the pack's contract (allowed elements,
 * motion tokens, value and series types and ranges); the gate checks pacing and narration coverage with the shared
 * limits (storyboardGate) and that every number comes from a research note with a source: the source skill's own rule
 * is "never invent data", so a number no sourced note contains fails the gate, by name.
 *
 * The spec feeds buildScenePlan and the render payload as storyboard shots with an onScreen spec, so the worker
 * contract is unchanged (labels and sources stay in the spec, for Review; the worker reads kind, text, value, series).
 */
import {
  ELEMENT_KINDS,
  MAX_ELEMENT_SERIES,
  MAX_ELEMENT_TEXT,
  MAX_ELEMENT_TOKENS,
  MAX_ELEMENTS,
  MAX_NOTE_CHARS,
  MAX_RESEARCH_PROMPT_CHARS,
  MAX_SCRIPT_CHARS,
  MAX_SHOTS,
  MAX_SHOT_SECONDS,
  channelLines,
  dataBlock,
  paceOf,
  runLines,
  system,
  templateLines,
  type ChatMessage,
  type DirectorContext,
  type ElementKind,
  type ResearchNote,
  type Shot,
  type Validated,
} from "./director.ts";
import { storyboardGate, type GateResult } from "./qc.ts";
import { MOTION_TOKENS } from "./render-engine.ts";
import type { BeatRole, Template } from "./templates.ts";

export const SCENE_SPEC_STAGE = "scene-spec";
export const MAX_CAPTION_CHARS = 200;
export const MAX_LABEL_CHARS = 24;
/** Largest magnitude a value may have: beyond it a counter would not fit on screen and is most likely a unit slip. */
export const MAX_ABS_VALUE = 1e15;

const BEATS: readonly BeatRole[] = ["hook", "setup", "body", "payoff", "cta", "outro"];

export interface SpecElement {
  kind: ElementKind;
  text?: string;
  /** For a counter, gauge or tally: the number it shows. */
  value?: number;
  /** For a bar (or a line graph): the values it plots, oldest first. */
  series?: number[];
  /** One label per series value (years, places), for Review and the page. */
  labels?: string[];
  /** The research note (1-based) the element's numbers come from. */
  source?: number;
}

export interface SpecScene {
  seconds: number;
  beat: BeatRole;
  elements: SpecElement[];
  tokens: string[];
  /** The narration spoken during the scene, shown on Review. */
  caption: string;
  /**
   * How this scene builds what the script is about: the pack's own words (e.g. { structure: "church", action: "damage" }),
   * or parts composed from the world's primitives when the kit has nothing that fits ({ parts: [...] }).
   */
  intent?: Record<string, unknown>;
}

export interface SceneSpec {
  scenes: SpecScene[];
}

/** What the pack allows on screen (style.json contract.onScreen). */
export interface SpecContract {
  name: string;
  elements: readonly ElementKind[];
  motionTokens: readonly string[];
  /** style.json contract.story: the words the page understands, slot -> values. Absent: this look takes no intent. */
  story?: Record<string, readonly string[]>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function narrationSecOf(ctx: DirectorContext, script: string): number {
  return Math.round((script.split(/\s+/).filter(Boolean).length / paceOf(ctx)) * 60);
}

/** The prompt: the approved script, the research notes (numbered), and the contract the page draws. */
export function sceneSpecPrompt(ctx: DirectorContext, script: string, notes: readonly ResearchNote[], contract: SpecContract, retryHint?: string): ChatMessage[] {
  const maxShot = ctx.template ? ctx.template.pacing.maxShotSeconds : 6;
  const narrationSec = narrationSecOf(ctx, script);
  const minScenes = Math.ceil((narrationSec * 1.15) / maxShot);
  const list = notes.map((n, i) => `${i + 1}. ${n.claim} (${n.sourced && n.sourceUrl ? `source: ${n.sourceUrl}` : "no source"}): ${n.summary}`).join("\n");
  const tokens = contract.motionTokens.length > 0 ? contract.motionTokens.join(", ") : "none";
  // A pack with a story vocabulary is a look that draws a script's own world: the scene must say which words it uses.
  const storyLines = storyPrompt(contract.story);
  return [
    system(`Turn the script into a scene spec for the ${contract.name} page.`),
    {
      role: "user",
      content: [
        "VENSTUDIO_STAGE: scene-spec",
        `Write the scene spec the ${contract.name} page draws: per scene how long it runs, which beat it is, what is on screen and how it moves. The page draws exactly this. No picture is made for any scene.`,
        `The narration runs about ${narrationSec} seconds, so the scenes must cover it: use at least ${minScenes} scenes, repeating beats when needed.`,
        `No scene may be longer than ${maxShot} seconds. beat must be one of ${BEATS.join(", ")}.`,
        `On-screen elements this style allows: ${contract.elements.join(", ")}. Use no other kind. Each scene has 1 to ${MAX_ELEMENTS} elements.`,
        `Motion tokens this style allows: ${tokens}. Each scene names 1 to ${MAX_ELEMENT_TOKENS} of them.`,
        ...storyLines,
        `A counter, gauge or tally shows value; a bar plots series (1 to ${MAX_ELEMENT_SERIES} numbers, oldest first) with labels, one per value. text is a short label (at most ${MAX_ELEMENT_TEXT} characters).`,
        "Every number on screen (value, series, and any digit in text) must come from the research notes, exactly as a note gives it. Put that note's number in source. Use only notes that have a source. Never invent data: when the notes have no number for a scene, show no number in it.",
        `caption is the part of the narration spoken during the scene (at most ${MAX_CAPTION_CHARS} characters), in script order.`,
        ...channelLines(ctx),
        ...templateLines(ctx),
        `Schema: {"scenes":[{"seconds":number,"beat":string,"elements":[{"kind":string,"text"?:string,"value"?:number,"series"?:number[],"labels"?:string[],"source"?:number}],"tokens":[string]${storySchema(contract.story)},"caption":string}]}`,
        dataBlock("script", script, MAX_SCRIPT_CHARS),
        dataBlock("research notes", list, MAX_RESEARCH_PROMPT_CHARS),
        ...runLines(ctx, "storyboard"),
        retryHint ? dataBlock("owner revision note", retryHint, MAX_NOTE_CHARS) : "",
      ]
        .filter((l) => l !== "")
        .join("\n"),
    },
  ];
}

/**
 * The lines that tell the writer how this look builds a script's world. The kit is the shortcut; the primitives are the
 * way anything gets built, so a subject nobody modelled is composed rather than refused.
 */
function storyPrompt(story: Record<string, readonly string[]> | undefined): string[] {
  const slots = story ? Object.entries(story) : [];
  if (slots.length === 0) return [];
  const library = story?.structure ?? [];
  const closed = slots.filter(([slot]) => slot !== "structure");
  return [
    `This style builds what the script is about: every scene says how to build it in "intent".`,
    library.length > 0
      ? `Shortcut, when the kit already has the thing: "structure" is one of ${library.join(", ")}.`
      : "",
    `For anything else, compose it — a scene is never refused because the kit lacks the subject. "parts" is 1 to ${MAX_PARTS} pieces, each {"kind":..., "at":[x,y,z], "size":[w,h,d], "material":"block:name"} with whole-block coordinates at most ${PART_LIMIT} from the origin. Kinds: ${PRIMITIVES.join(", ")}; box (solid, or hollow for a shell), walls (perimeter, with openings like [{"at":[x,y],"w":2,"h":4}] cut out), roof (size [w,d], style gable|hip|flat, rise), cylinder (radius, height), stair (rise), path (ground strip), tree (rise), blocks (raw [x,y,z,block] nodes). material is any block the pack knows, e.g. mcl_core:stonebrick, mcl_core:wood, mcl_core:cobble.`,
    `Example — a gate with two towers, which no kit has: walls [11,7,3] with a 2×4 opening, a gable roof over it, a cylinder radius 2 height 12 at each end, a hip roof on each tower.`,
    closed.length > 0
      ? `Also fill every scene: ${closed.map(([slot, values]) => `${slot} (${values.join(", ")})`).join("; ")}. These are closed lists: use one of the listed values, nothing else.`
      : "",
    `Say structure or parts, never neither; if both, the parts are what the page draws.`,
  ].filter(Boolean);
}

/** The intent part of the schema line, so the shape Hermes is asked for and the shape checked are the same one. */
function storySchema(story: Record<string, readonly string[]> | undefined): string {
  if (!story) return "";
  const slots = Object.keys(story);
  if (slots.length === 0) return "";
  const closed = slots
    .filter((s) => s !== "structure")
    .map((s) => `"${s}":"<one of ${(story[s] ?? []).join("|")}>"`)
    .join(",");
  const structure = slots.includes("structure") ? `"structure":"<one of ${(story.structure ?? []).join("|")}, or omit it when you use parts>"` : "";
  return `,"intent":{${[structure, closed].filter(Boolean).join(",")},"parts":[{"kind":"<${PRIMITIVES.join("|")}>","at":[0,0,0],"size":[1,1,1],"material":"block:name"}]}`;
}

function text(v: unknown, label: string, max: number, issues: string[]): string {
  if (typeof v !== "string") {
    issues.push(`${label} must be text`);
    return "";
  }
  const s = v.trim();
  if (!s) issues.push(`${label} is empty`);
  else if (s.length > max) issues.push(`${label} is longer than ${max} characters`);
  return s;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export interface SceneSpecCheck {
  contract: SpecContract;
  /** How many research notes the run has: a source must name one of them. */
  noteCount: number;
  /** Reading a stored spec back: the contract it was checked against is not at hand, so no token is required. */
  readBack?: boolean;
}

/** Validates Hermes's JSON against the pack's contract. Pacing, coverage and sourcing are the gate's (sceneSpecGate). */
export function validateSceneSpec(value: unknown, check: SceneSpecCheck): Validated<SceneSpec> {
  const issues: string[] = [];
  if (!isRecord(value) || !Array.isArray(value.scenes)) return { ok: false, issues: ["Expected an object with a scenes array"] };
  const raw: unknown[] = value.scenes;
  if (raw.length < 1 || raw.length > MAX_SHOTS) issues.push(`scenes must hold 1 to ${MAX_SHOTS} items, got ${raw.length}`);
  const allowed = new Set<string>(check.contract.elements);
  const tokensAllowed = new Set<string>(check.contract.motionTokens);
  const scenes: SpecScene[] = [];
  raw.slice(0, MAX_SHOTS).forEach((r, i) => {
    const n = i + 1;
    if (!isRecord(r)) {
      issues.push(`Scene ${n} must be an object`);
      return;
    }
    let seconds = 0;
    if (!finite(r.seconds) || r.seconds <= 0 || r.seconds > MAX_SHOT_SECONDS) issues.push(`Scene ${n} seconds must be a number above 0 and at most ${MAX_SHOT_SECONDS}`);
    else seconds = r.seconds;
    const beat = BEATS.find((b) => b === r.beat);
    if (!beat) issues.push(`Scene ${n} beat must be one of ${BEATS.join(", ")}`);
    const caption = text(r.caption, `Scene ${n} caption`, MAX_CAPTION_CHARS, issues);
    const elements: SpecElement[] = [];
    const rawEls = Array.isArray(r.elements) ? r.elements : [];
    if (rawEls.length < 1 || rawEls.length > MAX_ELEMENTS) issues.push(`Scene ${n} elements must hold 1 to ${MAX_ELEMENTS} items`);
    rawEls.slice(0, MAX_ELEMENTS).forEach((e, k) => {
      const at = `Scene ${n} element ${k + 1}`;
      if (!isRecord(e)) {
        issues.push(`${at} must be an object`);
        return;
      }
      const kind = ELEMENT_KINDS.find((x) => x === e.kind);
      if (!kind) {
        issues.push(`${at} kind must be one of ${ELEMENT_KINDS.join(", ")}`);
        return;
      }
      if (!allowed.has(kind)) {
        issues.push(`${at} is a ${kind}, which ${check.contract.name} does not draw. Use ${check.contract.elements.join(", ")}.`);
        return;
      }
      const out: SpecElement = { kind };
      if (e.text !== undefined) {
        const t = text(e.text, `${at} text`, MAX_ELEMENT_TEXT, issues);
        if (t) out.text = t;
      }
      if (e.value !== undefined) {
        if (!finite(e.value) || Math.abs(e.value) > MAX_ABS_VALUE) issues.push(`${at} value must be a number up to ${MAX_ABS_VALUE} in size`);
        else out.value = e.value;
      }
      if (e.series !== undefined) {
        const s = Array.isArray(e.series) ? e.series : [];
        const nums = s.filter((x): x is number => finite(x) && Math.abs(x) <= MAX_ABS_VALUE);
        if (nums.length !== s.length || nums.length === 0 || nums.length > MAX_ELEMENT_SERIES) issues.push(`${at} series must be 1 to ${MAX_ELEMENT_SERIES} numbers`);
        else out.series = nums;
      }
      if (e.labels !== undefined) {
        const l = Array.isArray(e.labels) ? e.labels : [];
        const labels = l.filter((x): x is string => typeof x === "string" && x.trim().length > 0 && x.length <= MAX_LABEL_CHARS).map((x) => x.trim());
        if (labels.length !== l.length) issues.push(`${at} labels must be short texts (at most ${MAX_LABEL_CHARS} characters)`);
        else if (!out.series || labels.length !== out.series.length) issues.push(`${at} labels must give one label per series value`);
        else out.labels = labels;
      }
      if (e.source !== undefined) {
        if (!Number.isInteger(e.source) || (e.source as number) < 1 || (e.source as number) > check.noteCount) issues.push(`${at} source must be the number of a research note, 1 to ${check.noteCount}`);
        else out.source = e.source as number;
      }
      elements.push(out);
    });
    const rawTokens = Array.isArray(r.tokens) ? r.tokens : [];
    const tokens = rawTokens.filter((t): t is string => typeof t === "string" && tokensAllowed.has(t));
    if (!Array.isArray(r.tokens)) issues.push(`Scene ${n} tokens must be a list of motion tokens`);
    else if (tokens.length !== rawTokens.length) issues.push(`Scene ${n} tokens may only be ${check.contract.motionTokens.join(", ") || "(none)"}`);
    else if (rawTokens.length > MAX_ELEMENT_TOKENS) issues.push(`Scene ${n} names ${rawTokens.length} tokens, more than ${MAX_ELEMENT_TOKENS}`);
    else if (tokens.length === 0 && check.contract.motionTokens.length > 0 && !check.readBack) issues.push(`Scene ${n} needs a motion token (${check.contract.motionTokens.join(", ")}), or it renders as a still`);
    const intent = storyIntent(r.intent, check, n, issues);
    scenes.push({ seconds, beat: beat ?? "body", elements, tokens: [...new Set(tokens)], caption, ...(intent ? { intent } : {}) });
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { scenes } };
}

/** One geometric piece, when the story composes instead of naming a structure the kit already has. */
export interface SpecPart {
  kind: string;
  at?: number[];
  size?: number[];
  material?: string;
  radius?: number;
  height?: number;
  rise?: number;
  style?: string;
  hollow?: boolean;
  openings?: Array<{ at: number[]; w: number; h: number }>;
  nodes?: number[][];
}

/**
 * The primitives every html-capture world understands, mirroring render/world.js inside each pack. This list is a check on
 * shape, not on ideas: a scene may compose anything out of these, which is why a subject the kit never modelled is
 * buildable rather than refused.
 */
export const PRIMITIVES = ["box", "walls", "roof", "cylinder", "stair", "path", "tree", "blocks"] as const;
const MAX_PARTS = 64;
const MAX_PART_OPENINGS = 8;
const MAX_PART_NODES = 4000;
const PART_LIMIT = 96;
const MATERIAL_TOKEN = /^[a-z0-9_]+:[a-z0-9_]+$/;

/**
 * The story words of one scene, checked against what the pack can draw. Two ways to say what to build: a structure the
 * kit has (cheap), or parts composed from the primitives (anything the blocks can make). A look with a vocabulary
 * demands one of the two plus every other slot, because a missing word would leave the page guessing; a look without a
 * vocabulary takes no intent at all, and a scene that offers one is refused rather than silently dropped.
 */
function storyIntent(raw: unknown, check: SceneSpecCheck, n: number, issues: string[]): Record<string, unknown> | undefined {
  const story = check.contract.story;
  if (!story || Object.keys(story).length === 0) {
    // A stored spec read back with no vocabulary at hand: keep the words the owner approved, sanitized, so the page
    // still draws the story that was reviewed. A live spec against a look with no vocabulary is refused by name.
    if (check.readBack) return storyIntentReadBack(raw);
    if (raw !== undefined) issues.push(`Scene ${n} names an intent, but ${check.contract.name} takes no story vocabulary`);
    return undefined;
  }
  if (!isRecord(raw)) {
    // Reading a stored spec back: an older spec has no intent, and the page falls back to its own rotation.
    if (!check.readBack) issues.push(`Scene ${n} needs intent with ${Object.keys(story).join(", ")}`);
    return undefined;
  }
  const before = issues.length;
  const out: Record<string, unknown> = {};
  const parts = raw.parts === undefined ? undefined : storyParts(raw.parts, n, issues);
  if (parts) out.parts = parts;
  for (const [slot, values] of Object.entries(story)) {
    const given = raw[slot];
    const has = typeof given === "string" && given.trim() !== "";
    if (slot === "structure") {
      // Composed parts already say what to build; the kit name is the shortcut, not the rule.
      if (parts && !has) continue;
      if (!has) {
        issues.push(`Scene ${n} intent needs either structure (${values.join(", ")}) or parts to compose it`);
        continue;
      }
      const v = (given as string).trim();
      if (!values.includes(v)) {
        issues.push(
          `Scene ${n} intent.structure is "${v}", which ${check.contract.name} does not have in its kit. Compose it from parts instead (${PRIMITIVES.join(", ")}), or name one of: ${values.join(", ")}.`,
        );
        continue;
      }
      out.structure = v;
      continue;
    }
    if (!has) {
      issues.push(`Scene ${n} intent is missing ${slot}`);
      continue;
    }
    const v = (given as string).trim();
    if (!values.includes(v)) {
      issues.push(`Scene ${n} intent.${slot} is "${v}", which ${check.contract.name} cannot draw. It can draw: ${values.join(", ")}.`);
      continue;
    }
    out[slot] = v;
  }
  for (const slot of Object.keys(raw)) {
    if (slot !== "parts" && !(slot in story)) issues.push(`Scene ${n} intent names "${slot}", which ${check.contract.name} does not know`);
  }
  if (issues.length > before) return undefined;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The parts of one scene, checked for shape and bounds (never for subject). Pure. */
function storyParts(raw: unknown, n: number, issues: string[]): SpecPart[] | undefined {
  const before = issues.length;
  if (!Array.isArray(raw)) {
    issues.push(`Scene ${n} intent.parts must be a list`);
    return undefined;
  }
  if (raw.length === 0) {
    issues.push(`Scene ${n} intent.parts is empty: give at least one piece`);
    return undefined;
  }
  if (raw.length > MAX_PARTS) {
    issues.push(`Scene ${n} intent.parts has ${raw.length} pieces, more than ${MAX_PARTS}`);
    return undefined;
  }
  const nums = (v: unknown, label: string, min: number, max: number, want: number[]): number[] | undefined => {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length < want[0] || v.length > want[1] || !v.every(finite)) {
      issues.push(`${label} must be ${want[0]}-${want[1]} numbers`);
      return undefined;
    }
    const list = v as number[];
    if (list.some((x) => x < min || x > max)) {
      issues.push(`${label} is outside ${min}..${max}`);
      return undefined;
    }
    return list.map((x) => Math.round(x));
  };
  const out: SpecPart[] = [];
  raw.forEach((p, i) => {
    const at = `Scene ${n} intent.parts[${i}]`;
    if (!isRecord(p)) {
      issues.push(`${at} must be an object`);
      return;
    }
    const kind = typeof p.kind === "string" ? p.kind.trim() : "";
    if (!(PRIMITIVES as readonly string[]).includes(kind)) {
      issues.push(`${at}.kind is "${kind || "(missing)"}", not one of ${PRIMITIVES.join(", ")}`);
      return;
    }
    const part: SpecPart = { kind };
    const pos = nums(p.at, `${at}.at`, -PART_LIMIT, PART_LIMIT, [2, 3]);
    if (pos) part.at = pos;
    const size = nums(p.size, `${at}.size`, 1, 48, [2, 3]);
    if (size) part.size = size;
    if (typeof p.material === "string" && p.material.trim() !== "") {
      const m = p.material.trim();
      if (!MATERIAL_TOKEN.test(m)) issues.push(`${at}.material is "${m}", not a block name like mcl_core:stonebrick`);
      else part.material = m;
    }
    for (const key of ["radius", "height", "rise"] as const) {
      if (p[key] === undefined) continue;
      if (!finite(p[key]) || (p[key] as number) < 1 || (p[key] as number) > 48) {
        issues.push(`${at}.${key} must be a number 1..48`);
        continue;
      }
      part[key] = Math.round(p[key] as number);
    }
    if (p.style !== undefined) {
      const style = String(p.style);
      if (!["gable", "hip", "flat"].includes(style)) issues.push(`${at}.style must be gable, hip or flat`);
      else part.style = style;
    }
    if (p.hollow !== undefined) part.hollow = p.hollow === true;
    if (p.openings !== undefined) {
      if (!Array.isArray(p.openings) || p.openings.length > MAX_PART_OPENINGS) {
        issues.push(`${at}.openings must be a list of at most ${MAX_PART_OPENINGS}`);
      } else {
        const openings: Array<{ at: number[]; w: number; h: number }> = [];
        p.openings.forEach((o, k) => {
          if (!isRecord(o)) {
            issues.push(`${at}.openings[${k}] must be an object`);
            return;
          }
          const corner = nums(o.at, `${at}.openings[${k}].at`, -PART_LIMIT, PART_LIMIT, [2, 2]);
          if (!corner) return;
          if (!finite(o.w) || !finite(o.h) || o.w < 1 || o.h < 1 || o.w > 12 || o.h > 12) {
            issues.push(`${at}.openings[${k}] needs w and h as numbers 1..12`);
            return;
          }
          openings.push({ at: corner, w: Math.round(o.w), h: Math.round(o.h) });
        });
        if (openings.length > 0) part.openings = openings;
      }
    }
    if (p.nodes !== undefined) {
      const rawNodes = Array.isArray(p.nodes) ? p.nodes : [];
      if (!Array.isArray(p.nodes) || rawNodes.length > MAX_PART_NODES) {
        issues.push(`${at}.nodes must be a list of at most ${MAX_PART_NODES} nodes`);
      } else {
        const nodes = rawNodes.filter(
          (node): node is number[] => Array.isArray(node) && node.length >= 4 && node.slice(0, 3).every(finite) && typeof node[3] === "string",
        );
        if (nodes.length !== rawNodes.length) issues.push(`${at}.nodes needs [x, y, z, blockName] per node`);
        if (nodes.length > 0) part.nodes = nodes;
      }
    }
    out.push(part);
  });
  if (issues.length > before) return undefined;
  return out;
}

/** A stored intent read back with no vocabulary at hand: slot -> short lowercase value, at most twelve slots. Pure. */
const INTENT_SLOT = /^[a-z][a-z0-9-]{0,23}$/;
function storyIntentReadBack(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, unknown> = {};
  if (raw.parts !== undefined) {
    // A stored spec is what the owner approved: keep its parts if they still have the shape the page reads.
    const salvage: string[] = [];
    const kept = storyParts(raw.parts, 0, salvage);
    if (kept) out.parts = kept;
  }
  for (const [slot, value] of Object.entries(raw)) {
    if (!INTENT_SLOT.test(slot) || typeof value !== "string") continue;
    const v = value.trim();
    if (v && v.length <= 32) out[slot] = v;
    if (Object.keys(out).length >= 13) break;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A number as written: 1,234,567.5 (thousands separated by commas) or 1234.5; a dash after a word or digit is a range, not a sign. */
const NUMBER_SRC = "(?<![\\d.])(?:(?<![\\w])-)?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?";

const MULTIPLIERS: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 };

/** The numbers a text states, each as written and, after a multiplier word or a percent sign, as it scales. */
export function numbersInText(s: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`(${NUMBER_SRC})\\s*(%|k\\b|thousand\\b|mn?\\b|million\\b|bn?\\b|billion\\b|t\\b|trillion\\b)?`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const n = Number(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    out.push(n);
    const unit = (m[2] ?? "").toLowerCase();
    if (unit === "%") out.push(n / 100);
    else if (unit && MULTIPLIERS[unit]) out.push(n * MULTIPLIERS[unit]);
  }
  return out;
}

function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);
}

function digitsIn(s: string): number[] {
  return (s.match(new RegExp(NUMBER_SRC, "g")) ?? []).map((t) => Number(t.replace(/,/g, ""))).filter(Number.isFinite);
}

const shortNum = (n: number) => String(Math.round(n * 1e6) / 1e6);

/**
 * Every number on screen must come from a research note that has a source: value and series from the note the element
 * cites, a digit in an element's text from that note (or, uncited, from any sourced note). Plain issues, one per number.
 */
export function sourcingIssues(spec: SceneSpec, notes: readonly ResearchNote[]): string[] {
  const issues: string[] = [];
  const known = (i: number) => {
    const n = notes[i - 1];
    return n ? numbersInText(`${n.claim} ${n.summary}`) : [];
  };
  const sourced = (i: number) => {
    const n = notes[i - 1];
    return Boolean(n && n.sourced && n.sourceUrl);
  };
  const rule = "Numbers must come from the research notes; never invent data.";
  spec.scenes.forEach((s, si) => {
    s.elements.forEach((e) => {
      const at = `Scene ${si + 1} ${e.kind}`;
      const nums = [...(e.value !== undefined ? [e.value] : []), ...(e.series ?? [])];
      if (nums.length > 0) {
        if (e.source === undefined) {
          issues.push(`${at} shows ${nums.map(shortNum).join(", ")} but cites no research note. ${rule}`);
          return;
        }
        if (!sourced(e.source)) {
          issues.push(`${at} cites note ${e.source}, which has no source link. ${rule}`);
          return;
        }
        const have = known(e.source);
        const missing = nums.filter((v) => !have.some((h) => sameNumber(h, v)));
        if (missing.length > 0) issues.push(`${at} shows ${missing.map(shortNum).join(", ")}, which note ${e.source} does not contain. ${rule}`);
      }
      if (e.text) {
        const inText = digitsIn(e.text);
        if (inText.length === 0) return;
        const pool = e.source !== undefined && sourced(e.source) ? known(e.source) : notes.flatMap((n, i) => (sourced(i + 1) ? known(i + 1) : []));
        const missing = inText.filter((v) => !pool.some((h) => sameNumber(h, v)));
        if (missing.length > 0) issues.push(`${at} text "${e.text.slice(0, 60)}" has ${missing.map(shortNum).join(", ")}, which no sourced research note contains. ${rule}`);
      }
    });
  });
  return issues;
}

/** The gate: pacing and narration coverage (the storyboard's shared limits) and sourced numbers. */
export function sceneSpecGate(template: Template, spec: SceneSpec, notes: readonly ResearchNote[], narrationSec?: number): GateResult {
  const pacing = storyboardGate(template, spec.scenes.map((s) => ({ beatRole: s.beat, seconds: s.seconds })), narrationSec);
  const issues = [...pacing.issues.map((i) => i.replace(/\bshot\(s\)/g, "scene(s)").replace(/\bshot\b/g, "scene").replace(/\bstoryboard\b/g, "scene spec")), ...sourcingIssues(spec, notes)];
  return { gate: "G-storyboard", passed: issues.length === 0, issues, executor: "hermes" };
}

/**
 * The spec as storyboard shots with an onScreen spec, for buildScenePlan, the render payload and the voice check. The
 * worker reads kind, text, value and series; labels and sources stay in the spec. imagePrompt is empty: no picture is
 * made for a scene.
 */
export function sceneSpecShots(spec: SceneSpec): Shot[] {
  return spec.scenes.map((s) => ({
    beatRole: s.beat,
    seconds: s.seconds,
    description: s.caption,
    imagePrompt: "",
    onScreen: {
      elements: s.elements.map((e) => ({
        kind: e.kind,
        ...(e.text !== undefined ? { text: e.text } : {}),
        ...(e.value !== undefined ? { value: e.value } : {}),
        ...(e.series !== undefined ? { series: [...e.series] } : {}),
      })),
      ...(s.tokens.length > 0 ? { tokens: [...s.tokens] } : {}),
    },
    // The story words travel with the shot: the pack's page draws them (voxel-build: structure, action, focus).
    ...(s.intent ? { intent: { ...s.intent } } : {}),
  }));
}

/** One line per scene for the Review card: what is on screen, with the numbers and the note each cites. */
export function sceneSpecLines(spec: SceneSpec): string[] {
  return spec.scenes.map((s, i) => {
    const els = s.elements
      .map((e) => {
        const nums = e.series ? e.series.map((v, k) => (e.labels?.[k] ? `${e.labels[k]}: ${shortNum(v)}` : shortNum(v))).join(", ") : e.value !== undefined ? shortNum(e.value) : "";
        const src = e.source !== undefined ? ` (note ${e.source})` : "";
        return `${e.kind}${e.text ? ` "${e.text}"` : ""}${nums ? ` ${nums}` : ""}${nums ? src : ""}`;
      })
      .join("; ");
    const story = s.intent
      ? Object.entries(s.intent)
          .map(([k, v]) =>
            Array.isArray(v)
              ? `${k}: ${v.length} pieces (${[...new Set(v.map((p) => (p && typeof p === "object" && "kind" in p ? String((p as { kind: unknown }).kind) : "?")))].join(", ")})`
              : `${k}: ${String(v)}`,
          )
          .join(", ")
      : "";
    return `${i + 1}. ${s.beat}, ${s.seconds} s: ${els}. Motion: ${s.tokens.join(", ") || "none"}.${story ? ` Story: ${story}.` : ""} Caption: ${s.caption}`;
  });
}

/** A stored scene spec (a passed stage's result), read back for the render and the voice check, or null. */
export function readSceneSpec(raw: unknown): SceneSpec | null {
  const r = validateSceneSpec(raw, { contract: { name: "the page", elements: ELEMENT_KINDS, motionTokens: MOTION_TOKENS }, noteCount: 1000, readBack: true });
  return r.ok ? r.value : null;
}

/**
 * A scene-spec run burns its script in as captions, so a number written in digits in the script is on screen too: it
 * must be in a research note that has a source. Numbers spelled out in words are not read. Plain issues, or [].
 */
export function scriptNumberIssues(script: string, notes: readonly ResearchNote[]): string[] {
  const pool = notes.filter((n) => n.sourced && n.sourceUrl).flatMap((n) => numbersInText(`${n.claim} ${n.summary}`));
  const missing = [...new Set(digitsIn(script))].filter((v) => !pool.some((h) => sameNumber(h, v)));
  return missing.length > 0
    ? [`The script says ${missing.slice(0, 8).map(shortNum).join(", ")}, which no sourced research note contains. Its captions are on screen, so numbers must come from the research notes; never invent data.`]
    : [];
}