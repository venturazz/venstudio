/**
 * Quality-control gate engine. Pure checkers that take measurements (from the worker's qc-video job, Hermes
 * vision, or the plan) and return a GateResult. Thresholds follow docs/research/04-autonomous-studio-workflow.md.
 */
import { LANGUAGE_BY_CODE, VIDEO_FORMATS, type Format } from "./catalog.ts";
import { COVER_TOLERANCE_SEC, MIN_SHOT_SECONDS, NARRATION_ESTIMATE_TOLERANCE, maxCoverSec } from "./render.ts";
import type { ProductionPlan } from "./planner.ts";
import { likenessIssues, provenanceIssues, type ProvenanceRecord } from "./provenance.ts";
import type { Template } from "./templates.ts";
import { assessNarrationLength, type VoiceAssessInput, type VoiceFix, type VoiceProblem } from "./voice-fit.ts";

export type GateId = "G-script" | "G-storyboard" | "G-assets" | "G-voice" | "G-technical" | "G-presentation" | "G-compliance" | "G-claims";

export interface GateResult {
  gate: GateId;
  passed: boolean;
  score?: number;
  issues: string[];
  /** Things the owner should know that do not fail the gate (G-voice: a narration longer than its estimate). */
  notes?: string[];
  executor: string;
}

export interface Run {
  start: number;
  end: number;
}

export interface TechnicalMeasure {
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  hasAudio: boolean;
  integratedLufs: number | null;
  truePeakDb: number | null;
  blackRuns: Run[];
  silenceRuns: Run[];
  freezeRuns: Run[];
  /** Cut times in seconds. */
  cuts: number[];
}

export const LOUDNESS_TOLERANCE_LU = 2;
export const MAX_BLACK_SEC = 1;
export const BLACK_EDGE_SEC = 0.5;
export const MAX_SILENCE_SEC = 2.5;
export const MAX_FREEZE_SEC = 4;
export const SHOT_LENGTH_SLACK = 1.5;
export const SCRIPT_LENGTH_TOLERANCE = 0.15;
export const MAX_SOURCE_OVERLAP = 0.08;
export const MIN_HOOK_VARIANTS = 3;
/** Since the voice-length fix this only decides when the card shows a note; see VOICE_GROSS_MISMATCH in voice-fit.ts. */
export const VOICE_DURATION_TOLERANCE = 0.1;
export const MIN_CLAIM_WAIT_HOURS = 6;
export const PRESENTATION_PASS = 75;
/** Integrated loudness below this (LUFS) is no usable sound: a silent track, or one with nothing audible in it. */
export const SILENT_LUFS = -50;
/** Silence (qc-video's silencedetect at -50 dB) over more than this share of the video means no usable audio. */
export const SILENT_SHARE = 0.8;
export const SILENT_AUDIO_ISSUE = "The video's audio is silent";

/** Share of the video, 0..1, that qc-video measured as silence. Overlapping or out-of-range runs are clamped. */
export function silenceShare(m: Pick<TechnicalMeasure, "durationSec" | "silenceRuns">): number {
  if (!(m.durationSec > 0)) return 0;
  const runs = m.silenceRuns
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(m.durationSec, r.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let reached = 0;
  for (const r of runs) {
    const from = Math.max(r.start, reached);
    if (r.end > from) total += r.end - from;
    reached = Math.max(reached, r.end);
  }
  return Math.min(1, total / m.durationSec);
}

/**
 * True when an audio stream exists but carries no usable sound. A narrated template must be heard: loudness not
 * measured or below SILENT_LUFS, or silence over more than SILENT_SHARE of the video, fails. A template without
 * narration keeps its quiet: one whose music policy is "none" may be silent on purpose and is never failed here, and
 * one with music fails only when both measures agree (a quiet ambient bed is above -50 LUFS and not detected as silence).
 */
export function audioIsSilent(m: Pick<TechnicalMeasure, "hasAudio" | "integratedLufs" | "durationSec" | "silenceRuns">, template: Pick<Template, "audio">): boolean {
  if (!m.hasAudio) return false;
  const quiet = m.integratedLufs === null || m.integratedLufs < SILENT_LUFS;
  const mostlySilent = silenceShare(m) > SILENT_SHARE;
  if (template.audio.narrated) return quiet || mostlySilent;
  if (template.audio.musicPolicy === "none") return false;
  return quiet && mostlySilent;
}

const fmt = (n: number): string => String(Math.round(n * 100) / 100);
const result = (gate: GateId, issues: string[], executor: string, score?: number): GateResult => {
  const r: GateResult = { gate, passed: issues.length === 0, issues, executor };
  if (score !== undefined) r.score = score;
  return r;
};

export function technicalGate(m: TechnicalMeasure, template: Template, format: Format): GateResult {
  const issues: string[] = [];
  const f = VIDEO_FORMATS[format];
  if (m.width !== f.width || m.height !== f.height) issues.push(`Resolution is ${m.width}x${m.height}, expected ${f.width}x${f.height}`);
  if (Math.abs(m.fps - f.fps) > 0.5) issues.push(`Frame rate is ${fmt(m.fps)}, expected ${f.fps}`);
  if (m.durationSec < f.durationSec[0] || m.durationSec > f.durationSec[1]) {
    issues.push(`Duration ${fmt(m.durationSec)} s is outside ${f.durationSec[0]} to ${f.durationSec[1]} s`);
  }
  if (!m.hasAudio) issues.push("The video has no audio stream");
  else if (audioIsSilent(m, template)) issues.push(SILENT_AUDIO_ISSUE);
  if (m.integratedLufs === null) issues.push("Loudness was not measured");
  else if (Math.abs(m.integratedLufs - template.audio.targetLufs) > LOUDNESS_TOLERANCE_LU) {
    issues.push(`Loudness is ${fmt(m.integratedLufs)} LUFS, target is ${template.audio.targetLufs} plus or minus ${LOUDNESS_TOLERANCE_LU}`);
  }
  if (m.truePeakDb === null) issues.push("True peak was not measured");
  else if (m.truePeakDb > template.audio.maxTruePeakDb) {
    issues.push(`True peak is ${fmt(m.truePeakDb)} dBTP, the limit is ${template.audio.maxTruePeakDb}`);
  }
  for (const r of m.blackRuns) {
    const inner = Math.min(r.end, m.durationSec - BLACK_EDGE_SEC) - Math.max(r.start, BLACK_EDGE_SEC);
    if (inner > MAX_BLACK_SEC) issues.push(`Black frames for ${fmt(inner)} s starting at ${fmt(Math.max(r.start, BLACK_EDGE_SEC))} s`);
  }
  if (template.audio.narrated) {
    for (const r of m.silenceRuns) {
      if (r.end - r.start > MAX_SILENCE_SEC) issues.push(`Silence for ${fmt(r.end - r.start)} s at ${fmt(r.start)} s in a narrated video`);
    }
  }
  if (template.family !== "ambient") {
    for (const r of m.freezeRuns) {
      if (r.end - r.start > MAX_FREEZE_SEC) issues.push(`Frozen picture for ${fmt(r.end - r.start)} s at ${fmt(r.start)} s`);
    }
  }
  const bounds = [0, ...[...m.cuts].sort((a, b) => a - b), m.durationSec];
  const limit = template.pacing.maxShotSeconds * SHOT_LENGTH_SLACK;
  const longest = Math.max(...bounds.slice(1).map((t, i) => t - bounds[i]));
  if (longest > limit) issues.push(`A shot longer than allowed: ${fmt(longest)} s, limit ${fmt(limit)} s`);
  if (format === "short" && template.family !== "ambient") {
    const first = m.cuts.length ? Math.min(...m.cuts) : m.durationSec;
    if (first * 1000 > template.pacing.hookByMs) issues.push(`The first cut comes at ${fmt(first)} s, after the ${template.pacing.hookByMs / 1000} s hook window`);
  }
  return result("G-technical", issues, "worker+portal");
}

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter(Boolean);
}

/** Share of a's n-word sequences that also appear in b, 0..1. Texts shorter than n words score 0. */
export function ngramOverlap(a: string, b: string, n = 5): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.length < n || wb.length < n) return 0;
  const grams = new Set<string>();
  for (let i = 0; i + n <= wb.length; i++) grams.add(wb.slice(i, i + n).join(" "));
  let total = 0;
  let hit = 0;
  for (let i = 0; i + n <= wa.length; i++) {
    total++;
    if (grams.has(wa.slice(i, i + n).join(" "))) hit++;
  }
  return total === 0 ? 0 : hit / total;
}

export interface ScriptInput {
  script: string;
  hooks: string[];
  format: Format;
  durationSec: number;
  wordsPerMinute: number;
  /** Text of the research sources the script drew on. */
  sources: string[];
  requiresSources: boolean;
}

export function scriptGate(i: ScriptInput): GateResult {
  const issues: string[] = [];
  const count = words(i.script).length;
  if (i.hooks.filter((h) => h.trim()).length < MIN_HOOK_VARIANTS) issues.push(`Needs at least ${MIN_HOOK_VARIANTS} hook variants`);
  const expected = (i.wordsPerMinute * i.durationSec) / 60;
  if (count < expected * (1 - SCRIPT_LENGTH_TOLERANCE) || count > expected * (1 + SCRIPT_LENGTH_TOLERANCE)) {
    issues.push(`Script has ${count} words; about ${Math.round(expected)} fit the duration (plus or minus 15 percent)`);
  }
  const windowSec = i.format === "short" ? 3 : 30;
  const firstLine = i.script.split(/(?<=[.!?])\s+|\n+/)[0] ?? "";
  const hookWords = words(firstLine).length;
  if (hookWords === 0) issues.push("The script is empty");
  else if (hookWords > (i.wordsPerMinute / 60) * windowSec) issues.push(`The opening line does not land inside the first ${windowSec} s`);
  if (i.requiresSources && i.sources.every((s) => !s.trim())) issues.push("This theme needs sources and none are recorded");
  const worst = i.sources.reduce((m, s) => Math.max(m, ngramOverlap(i.script, s)), 0);
  if (worst >= MAX_SOURCE_OVERLAP) issues.push(`The script copies ${Math.round(worst * 100)} percent of a source (limit 8 percent); rewrite in new words`);
  return result("G-script", issues, "hermes");
}

export interface StoryShot {
  beatRole: string;
  seconds: number;
}

/**
 * narrationSec is the narration length estimated from the script. When given, the shots must be able to cover it:
 * the render planner stretches each shot up to the template limit and shrinks it to no less than the minimum.
 */
export function storyboardGate(template: Template, shots: StoryShot[], narrationSec?: number): GateResult {
  const issues: string[] = [];
  for (const b of template.beats) {
    if (!shots.some((s) => s.beatRole === b.role)) issues.push(`No shot covers the ${b.role} beat`);
  }
  const tooLong = shots.filter((s) => s.seconds > template.pacing.maxShotSeconds);
  if (tooLong.length > 0) issues.push(`${tooLong.length} shot(s) longer than ${template.pacing.maxShotSeconds} s`);
  if (template.family !== "ambient" && shots.length > 0 && shots[0].seconds * 1000 > template.pacing.hookByMs) {
    issues.push(`The first shot change comes after the ${template.pacing.hookByMs / 1000} s hook window`);
  }
  if (shots.length === 0) issues.push("The storyboard has no shots");
  else if (narrationSec !== undefined && narrationSec > 0) {
    const most = maxCoverSec(shots.length, template.pacing.maxShotSeconds);
    const needed = narrationSec * (1 + NARRATION_ESTIMATE_TOLERANCE) - COVER_TOLERANCE_SEC;
    const least = shots.length * MIN_SHOT_SECONDS;
    if (most < needed) {
      const more = Math.ceil((needed - most) / template.pacing.maxShotSeconds);
      issues.push(
        `The narration is about ${Math.round(narrationSec)} s but ${shots.length} shot(s) of at most ${template.pacing.maxShotSeconds} s cover only ${Math.round(most)} s. Add at least ${more} more shot(s) or lengthen the shots`,
      );
    } else if (least > narrationSec * (1 - NARRATION_ESTIMATE_TOLERANCE) + COVER_TOLERANCE_SEC) {
      issues.push(`The narration is about ${Math.round(narrationSec)} s but ${shots.length} shot(s) need at least ${least} s. Remove shots`);
    }
  }
  return result("G-storyboard", issues, "hermes");
}

export interface AssetUsage {
  use: "publish" | "analyze";
  shotCount: number;
  /** Shots that have an asset with a provenance record. */
  coveredShots: number;
  /** Findings from the vision check: real people, brand logos. */
  visionFlags: string[];
  template?: Template;
}

export function assetsGate(records: ProvenanceRecord[], usage: AssetUsage): GateResult {
  const issues = [...provenanceIssues(records, usage.use)];
  if (usage.use === "publish") {
    issues.push(...likenessIssues(records));
    if (usage.coveredShots < usage.shotCount) issues.push(`${usage.shotCount - usage.coveredShots} shot(s) have no asset with a provenance record`);
    for (const f of usage.visionFlags) issues.push(`Vision check: ${f}`);
    const t = usage.template;
    if (t) {
      for (const r of records) {
        if (t.assetPolicy.forbidKinds.includes(r.kind) && r.kind !== "reference-video") issues.push(`${r.title}: ${r.kind} assets are not allowed in this template`);
        if (!t.assetPolicy.allowedSources.includes(r.source)) issues.push(`${r.title}: source ${r.source} is not allowed in this template`);
      }
    }
  }
  return result("G-assets", issues, "portal+hermes vision");
}

export interface VoiceInput extends Omit<VoiceAssessInput, "narrationSec" | "scriptEstimateSec"> {
  languageCode: string;
  /** Voice provider named when Kokoro does not cover the language. */
  provider: string | null;
  scriptEstimateSec: number;
  narrationSec: number;
  clipped: boolean;
}

export interface VoiceGateResult extends GateResult {
  problems: VoiceProblem[];
  fix: VoiceFix;
}

/**
 * G-voice. Fails on what breaks the video: an unknown or uncovered language, clipped samples, a narration outside the
 * format's limits or one the storyboard's shots cannot cover even stretched to maxShotSeconds (given format and
 * shots), or a narration so far from its estimate (VOICE_GROSS_MISMATCH) that the audio is probably broken. A moderate
 * difference from the estimate is a note. `fix` says which fixes the card can offer.
 */
export function voiceAssessment(v: VoiceInput): VoiceGateResult {
  const problems: VoiceProblem[] = [];
  const lang = LANGUAGE_BY_CODE[v.languageCode];
  if (!lang) problems.push({ code: "language", text: `Unknown language ${v.languageCode}` });
  else if (lang.tts !== "kokoro" && !(v.provider ?? "").trim()) {
    problems.push({ code: "language", text: `${lang.label} is not covered by Kokoro: name the voice provider` });
  }
  const length = assessNarrationLength(v);
  problems.push(...length.problems);
  if (v.clipped) problems.push({ code: "clipped", text: "The narration has clipped samples" });
  const g = result("G-voice", problems.map((p) => p.text), "9router/tts");
  if (length.notes.length > 0) g.notes = length.notes;
  return { ...g, problems, fix: { ...length.fix, problems: problems.map((p) => p.code) } };
}

export function voiceGate(v: VoiceInput): GateResult {
  const a = voiceAssessment(v);
  const gate: GateResult = { gate: a.gate, passed: a.passed, issues: a.issues, executor: a.executor };
  if (a.notes) gate.notes = a.notes;
  return gate;
}

export function presentationGate(score: number, min: number = PRESENTATION_PASS, notes: string[] = []): GateResult {
  const passed = score >= min;
  return { gate: "G-presentation", passed, score, issues: passed ? [] : [`Presentation score ${score} is below ${min}`, ...notes], executor: "worker+hermes vision" };
}

export interface ComplianceFlags {
  paidPromotion: boolean;
  madeForKids: boolean;
  alteredContent: boolean;
  realisticSynthetic: boolean;
  checklistSigned: boolean;
  musicLicensed: boolean;
}

export function complianceGate(input: { plan: Pick<ProductionPlan, "purposes" | "themeId">; flags: ComplianceFlags }): GateResult {
  const { plan, flags } = input;
  const issues: string[] = [];
  if (plan.purposes.some((p) => p.id === "affiliate" || p.id === "advertising") && !flags.paidPromotion) {
    issues.push("Affiliate or advertising content needs the paid promotion flag");
  }
  if (plan.themeId === "kids" && !flags.madeForKids) issues.push("The kids theme needs Made for Kids set");
  if (flags.realisticSynthetic && !flags.alteredContent) issues.push("Realistic synthetic content needs the altered or synthetic disclosure");
  if (!flags.checklistSigned) issues.push("The template copyright checklist is not signed off");
  if (!flags.musicLicensed) issues.push("Music has no licence and is not self-generated");
  return result("G-compliance", issues, "portal");
}

export type ClaimStatus = "clear" | "claim" | "restricted" | "strike" | "unknown";

export function claimsGate(input: { status: ClaimStatus; waitedHours: number; minWaitHours?: number }): GateResult {
  const issues: string[] = [];
  const wait = input.minWaitHours ?? MIN_CLAIM_WAIT_HOURS;
  if (input.status === "claim" || input.status === "restricted" || input.status === "strike") {
    issues.push(`YouTube reports a ${input.status}; publishing is blocked`);
  } else if (input.waitedHours < wait) issues.push(`Wait ${wait} hours after upload before reading the claim status (waited ${fmt(input.waitedHours)})`);
  else if (input.status === "unknown") issues.push("The claim status could not be read");
  return result("G-claims", issues, "portal");
}

const HARD_GATES: GateId[] = ["G-assets", "G-compliance", "G-claims"];

/** Gates that must all have run, and passed, before a video can be approved for publishing. */
export const PUBLISH_GATES: GateId[] = ["G-technical", "G-presentation", "G-assets", "G-compliance", "G-claims"];

export interface CombinedQc {
  passed: boolean;
  /** Required gates that have no result yet. A missing gate is never a pass. */
  missingGates: GateId[];
  score: number;
  failedGates: GateId[];
  /** True when automatic revision must not run: assets, compliance or claims failed, or the template is retired. */
  blocking: boolean;
}

/** `required` defaults to the publish set; pass the gates of an earlier stage (or none) for a stage-only check. */
export function combineGates(results: GateResult[], template: Template, required: GateId[] = PUBLISH_GATES): CombinedQc {
  const missingGates = required.filter((g) => !results.some((r) => r.gate === g));
  const failedGates = results.filter((r) => !r.passed).map((r) => r.gate);
  const scores = results.map((r) => r.score ?? Math.max(0, 100 - 10 * r.issues.length));
  const score = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  return {
    passed: results.length > 0 && failedGates.length === 0 && missingGates.length === 0,
    missingGates,
    score,
    failedGates,
    blocking: failedGates.some((g) => HARD_GATES.includes(g)) || template.status === "retired",
  };
}

const GATE_NAMES: Record<GateId, string> = {
  "G-script": "Script",
  "G-storyboard": "Storyboard",
  "G-assets": "Assets",
  "G-voice": "Voice",
  "G-technical": "Technical",
  "G-presentation": "Presentation",
  "G-compliance": "Compliance",
  "G-claims": "Copyright claims",
};

/** Plain-English lines for the phone review screen. */
export function qcSummary(results: GateResult[]): string[] {
  if (results.length === 0) return ["No checks have run yet."];
  return results.map((r) => {
    const name = GATE_NAMES[r.gate];
    const score = r.score !== undefined ? ` (score ${r.score})` : "";
    return r.passed ? `${name}: passed${score}` : `${name}: needs attention${score}. ${r.issues.join(" ")}`;
  });
}
