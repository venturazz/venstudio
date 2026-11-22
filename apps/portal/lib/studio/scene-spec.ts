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
}

export interface SceneSpec {
  scenes: SpecScene[];
}

/** What the pack allows on screen (style.json contract.onScreen). */
export interface SpecContract {
  name: string;
  elements: readonly ElementKind[];
  motionTokens: readonly string[];
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
        `A counter, gauge or tally shows value; a bar plots series (1 to ${MAX_ELEMENT_SERIES} numbers, oldest first) with labels, one per value. text is a short label (at most ${MAX_ELEMENT_TEXT} characters).`,
        "Every number on screen (value, series, and any digit in text) must come from the research notes, exactly as a note gives it. Put that note's number in source. Use only notes that have a source. Never invent data: when the notes have no number for a scene, show no number in it.",
        `caption is the part of the narration spoken during the scene (at most ${MAX_CAPTION_CHARS} characters), in script order.`,
        ...channelLines(ctx),
        ...templateLines(ctx),
        'Schema: {"scenes":[{"seconds":number,"beat":string,"elements":[{"kind":string,"text"?:string,"value"?:number,"series"?:number[],"labels"?:string[],"source"?:number}],"tokens":[string],"caption":string}]}',
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
    scenes.push({ seconds, beat: beat ?? "body", elements, tokens: [...new Set(tokens)], caption });
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { scenes } };
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
    return `${i + 1}. ${s.beat}, ${s.seconds} s: ${els}. Motion: ${s.tokens.join(", ") || "none"}. Caption: ${s.caption}`;
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
