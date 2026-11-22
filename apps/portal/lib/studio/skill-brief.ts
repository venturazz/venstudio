/**
 * The skill brief of a Hermes research pack (recipe hermes-skill, recipes.ts), pure: the prompt, the validator and the
 * gate. Hermes turns the approved script into the input the pack's skill expects (style.json `hermes.input`): one JSON
 * spec per shot for a quick `spec` skill, a text project brief for a full `project` skill or the generic Hermes render.
 * It stands where the storyboard stands; nothing in it asks for a picture. The render request carries the brief
 * (hermes-render.ts). Research only, like every Hermes render.
 */
import {
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
  type ResearchNote,
  type Shot,
  type Validated,
} from "./director.ts";
import { storyboardGate, type GateResult } from "./qc.ts";
import type { BeatRole, Template } from "./templates.ts";

export const SKILL_BRIEF_STAGE = "skill-brief";
export const MAX_SPEC_CHARS = 2000;
export const MAX_BRIEF_TEXT_CHARS = 6000;
const MAX_SPEC_DEPTH = 4;
const BEATS: readonly BeatRole[] = ["hook", "setup", "body", "payoff", "cta", "outro"];

/** The skill the brief is for: the pack's `hermes` block, or null for the generic Hermes render (its own tools). */
export interface BriefSkill {
  name: string;
  mode: "spec" | "project";
  /** "run": the run's voice stage records the narration; "skill": the skill records its own voice. */
  voice: "run" | "skill";
  input: string;
}

export interface BriefShot {
  beat: BeatRole;
  seconds: number;
  description: string;
  /** The words on screen in this shot, if any. */
  onScreenText?: string;
  /** spec skills: the skill's JSON spec for this shot's clip. */
  spec?: Record<string, unknown>;
}

export interface SkillBrief {
  /** The skill it is for ("/graph"), or "" for the generic Hermes render. */
  skill: string;
  /** json: a spec per shot; text: a project brief in `text`. */
  format: "json" | "text";
  shots: BriefShot[];
  text?: string;
  voice: "run" | "skill";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function briefFormat(skill: BriefSkill | null): "json" | "text" {
  return skill?.mode === "spec" ? "json" : "text";
}

export function skillBriefPrompt(
  ctx: DirectorContext,
  script: string,
  notes: readonly ResearchNote[],
  skill: BriefSkill | null,
  packName: string,
  retryHint?: string,
): ChatMessage[] {
  const maxShot = ctx.template ? ctx.template.pacing.maxShotSeconds : 6;
  const narrationSec = Math.round((script.split(/\s+/).filter(Boolean).length / paceOf(ctx)) * 60);
  const minShots = Math.ceil((narrationSec * 1.15) / maxShot);
  const format = briefFormat(skill);
  const list = notes.map((n, i) => `${i + 1}. ${n.claim} (${n.sourced && n.sourceUrl ? n.sourceUrl : "no source"}): ${n.summary}`).join("\n");
  const who = skill ? `the ${skill.name} skill` : `your own tools (the ${packName} research render)`;
  return [
    system(`Turn the approved script into the brief ${skill ? `the ${skill.name} skill` : "a Hermes render"} reads.`),
    {
      role: "user",
      content: [
        "VENSTUDIO_STAGE: skill-brief",
        `Write the brief ${who} will render this video from later. Nothing is rendered now, and no picture is made: the skill draws everything itself.`,
        `The narration runs about ${narrationSec} seconds, so the shots must cover it: use at least ${minShots} shots. No shot may be longer than ${maxShot} seconds. beat must be one of ${BEATS.join(", ")}.`,
        format === "json"
          ? `For every shot, spec is the skill's JSON spec for that shot's clip (an object, at most ${MAX_SPEC_CHARS} characters), following the mapping in the DATA block skill input. Leave text out.`
          : `text is the project brief the skill reads (at most ${MAX_BRIEF_TEXT_CHARS} characters), following the mapping in the DATA block skill input: the voiceover text, the shot list and the timing. Leave spec out.`,
        skill?.voice === "skill"
          ? "The skill records its own voice from the narration script, so the voiceover text is the approved script, word for word."
          : "The run records the narration from the approved script; the skill uses that recording.",
        "Numbers come only from the research notes; never invent data. A spec holds no links.",
        ...channelLines(ctx),
        ...templateLines(ctx),
        format === "json"
          ? 'Schema: {"shots":[{"beat":string,"seconds":number,"description":string,"onScreenText"?:string,"spec":object}]}'
          : 'Schema: {"shots":[{"beat":string,"seconds":number,"description":string,"onScreenText"?:string}],"text":string}',
        dataBlock("skill input", skill ? `${skill.name} (${skill.mode}): ${skill.input}` : "No skill: render with your own tools from the shots and the text.", 2200),
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

/** Plain JSON data only (no links), at most MAX_SPEC_DEPTH levels deep. */
function specIssue(v: unknown, depth = 0): string | null {
  if (depth > MAX_SPEC_DEPTH) return `nests deeper than ${MAX_SPEC_DEPTH} levels`;
  if (typeof v === "string") return /(?:https?|file):\/\/|^\s*data:|^\s*\/\/|www\./i.test(v) ? "holds a link; a spec is data the skill draws, never a link" : null;
  if (typeof v === "number") return Number.isFinite(v) ? null : "holds a number that is not finite";
  if (typeof v === "boolean" || v === null) return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const i = specIssue(x, depth + 1);
      if (i) return i;
    }
    return null;
  }
  if (isRecord(v)) {
    for (const x of Object.values(v)) {
      const i = specIssue(x, depth + 1);
      if (i) return i;
    }
    return null;
  }
  return "holds something that is not JSON data";
}

/** Validates Hermes's brief for this skill. Pacing and coverage are the gate's (skillBriefGate). */
export function validateSkillBrief(value: unknown, skill: BriefSkill | null): Validated<SkillBrief> {
  const issues: string[] = [];
  if (!isRecord(value) || !Array.isArray(value.shots)) return { ok: false, issues: ["Expected an object with a shots array"] };
  const format = briefFormat(skill);
  const raw: unknown[] = value.shots;
  if (raw.length < 1 || raw.length > MAX_SHOTS) issues.push(`shots must hold 1 to ${MAX_SHOTS} items, got ${raw.length}`);
  const shots: BriefShot[] = [];
  raw.slice(0, MAX_SHOTS).forEach((r, i) => {
    const n = i + 1;
    if (!isRecord(r)) {
      issues.push(`Shot ${n} must be an object`);
      return;
    }
    const beat = BEATS.find((b) => b === r.beat);
    if (!beat) issues.push(`Shot ${n} beat must be one of ${BEATS.join(", ")}`);
    let seconds = 0;
    if (typeof r.seconds !== "number" || !Number.isFinite(r.seconds) || r.seconds <= 0 || r.seconds > MAX_SHOT_SECONDS) issues.push(`Shot ${n} seconds must be a number above 0 and at most ${MAX_SHOT_SECONDS}`);
    else seconds = r.seconds;
    const description = text(r.description, `Shot ${n} description`, 500, issues);
    const shot: BriefShot = { beat: beat ?? "body", seconds, description };
    if (r.onScreenText !== undefined && r.onScreenText !== "") {
      const t = text(r.onScreenText, `Shot ${n} onScreenText`, 200, issues);
      if (t) shot.onScreenText = t;
    }
    if (format === "json") {
      if (!isRecord(r.spec)) issues.push(`Shot ${n} spec must be the skill's JSON spec (an object)`);
      else {
        const why = specIssue(r.spec);
        if (why) issues.push(`Shot ${n} spec ${why}`);
        else if (JSON.stringify(r.spec).length > MAX_SPEC_CHARS) issues.push(`Shot ${n} spec is longer than ${MAX_SPEC_CHARS} characters`);
        else shot.spec = r.spec;
      }
    }
    shots.push(shot);
  });
  const brief: SkillBrief = { skill: skill?.name ?? "", format, shots, voice: skill?.voice ?? "run" };
  if (format === "text") {
    const t = text(value.text, "text", MAX_BRIEF_TEXT_CHARS, issues);
    if (t) {
      if (/\b(?:https?|file):\/\//i.test(t)) issues.push("text holds a link; the brief is what the skill draws, never a link to fetch");
      brief.text = t;
    }
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: brief };
}

/** The gate: pacing and narration coverage, with the storyboard's shared limits. */
export function skillBriefGate(template: Template, brief: SkillBrief, narrationSec?: number): GateResult {
  const g = storyboardGate(template, brief.shots.map((s) => ({ beatRole: s.beat, seconds: s.seconds })), narrationSec);
  return { ...g, issues: g.issues.map((i) => i.replace(/\bstoryboard\b/g, "skill brief")), passed: g.issues.length === 0 };
}

/** The brief's shots as storyboard shots, for the voice check and the render request. No picture is asked for. */
export function skillBriefShots(brief: SkillBrief): Shot[] {
  return brief.shots.map((s) => ({ beatRole: s.beat, seconds: s.seconds, description: s.onScreenText ? `${s.description} On screen: ${s.onScreenText}` : s.description, imagePrompt: "" }));
}

/** Lines for the Review card. */
export function skillBriefLines(brief: SkillBrief): string[] {
  return brief.shots.map((s, i) => `${i + 1}. ${s.beat}, ${s.seconds} s: ${s.description}${s.onScreenText ? ` On screen: "${s.onScreenText}".` : ""}${s.spec ? ` Spec: ${JSON.stringify(s.spec).slice(0, 300)}` : ""}`);
}

/** A stored skill brief (a passed stage's result), read back for the render and the voice check, or null. */
export function readSkillBrief(raw: unknown): SkillBrief | null {
  if (!isRecord(raw)) return null;
  const name = typeof raw.skill === "string" ? raw.skill : "";
  const voice = raw.voice === "skill" ? "skill" : "run";
  const skill: BriefSkill | null = name ? { name, mode: raw.format === "json" ? "spec" : "project", voice, input: "" } : null;
  const r = validateSkillBrief(raw, skill);
  return r.ok ? r.value : null;
}
