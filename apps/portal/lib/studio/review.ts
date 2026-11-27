/**
 * Review inbox domain, pure. What kinds of items the owner sees, how they are ordered, which decisions each
 * kind offers and plain-language labels. Spec: docs/architecture-autonomous-studio.md (Phase 3).
 */
import { NO_AUDIO_ISSUE, qcSummary, SILENT_AUDIO_ISSUE, type GateId, type GateResult } from "./qc.ts";
import { isTermsIssue, onlyTermsIssues } from "./production.ts";
import { canRecheck, hasTermsIssues, type ProviderRowUse } from "./terms-review.ts";
import { LENGTH_PROBLEMS, SOFT_PROBLEMS, type VoiceFix } from "./voice-fit.ts";

export type ReviewKind = "idea" | "approval" | "gate-failure" | "stage-error";
export type ReviewState = "open" | "approved" | "revision" | "rejected" | "superseded";
/**
 * "recheck" runs only the gate again on work that is already made (assets cards held up by provider terms, any voice
 * gate failure). The voice fixes: "fit" plays the narration at a small tempo change so it fits the shots (nothing is
 * made again), "tighten" has Hermes rewrite the script to a length that fits and records only the voice again,
 * "override" is the owner's Approve anyway: for a soft voice problem, and for a final quality check that failed only
 * checks that may be waived (qcWaiver).
 */
export type ReviewDecision = "approve" | "revise" | "reject" | "retry" | "recheck" | "fit" | "tighten" | "override" | "muse";
export const REVIEW_DECISIONS: readonly ReviewDecision[] = ["approve", "revise", "reject", "retry", "recheck", "fit", "tighten", "override", "muse"];

export const STAGE_LABELS: Record<string, string> = {
  idea: "Idea",
  research: "Research",
  script: "Script",
  storyboard: "Storyboard",
  "scene-spec": "Scene spec",
  "skill-brief": "Skill brief",
  "html-design": "HTML design",
  preview: "Preview",
  assets: "Assets",
  voice: "Voice",
  render: "Video",
  qc: "Quality check",
  upload: "Upload",
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

export function reviewTitle(kind: ReviewKind, stage: string): string {
  const s = stageLabel(stage);
  switch (kind) {
    case "idea":
      return "Pick an idea";
    case "approval":
      return `Approve the ${s.toLowerCase()}`;
    case "gate-failure":
      return `${s} did not pass the checks`;
    case "stage-error":
      return `${s} stopped with an error`;
  }
}

/** What the card is about, for the choices that depend on the stage and its issues. */
export interface DecisionContext {
  stage?: string;
  issues?: readonly string[];
  /** Voice gate failures: what the gate found and which fixes would work (payload.voice). */
  voice?: VoiceFix | null;
  /** True when every render worker can play narration at a changed tempo (worker 0.6.0+). Needed for "fit". */
  tempoReady?: boolean;
  /** False for a run whose workflow makes no pictures (scene spec, skill brief, HTML design): labels say "the plan". */
  pictures?: boolean;
  /** Hermes renders the run's video (research only): notes on the video go back to Hermes. */
  hermesRender?: boolean;
  /** False when the run has no voice stage (a Hermes skill that voices itself). */
  voiced?: boolean;
  /** Final quality check cards: which gates failed and whether the style is narrated (payload.qc). */
  qc?: QcFacts | null;
  /** A trial, research or lab run: the owner's score is needed before the final decision, and it goes to curation. */
  trial?: boolean;
  /**
   * The run's video is a Hermes-skill render that could be rendered on Muse instead (engine hermes, the run has its own
   * voice stage, and its render is not already on Muse): a failed render offers "Retry on Muse".
   */
  museRender?: boolean;
}

/** What the final quality check card records about its gates (payload.qc), so its choices can be worked out. */
export interface QcFacts {
  failedGates: GateId[];
  /** The style's template is narrated: a silent or missing audio track is then never waived. */
  narrated: boolean;
}

const QC_GATE_IDS: readonly GateId[] = ["G-script", "G-storyboard", "G-assets", "G-voice", "G-technical", "G-presentation", "G-compliance", "G-claims"];

/** payload.qc as stored, or null. */
export function parseQcFacts(raw: unknown): QcFacts | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.failedGates) || typeof o.narrated !== "boolean") return null;
  const failedGates = QC_GATE_IDS.filter((g) => (o.failedGates as unknown[]).includes(g));
  return { failedGates, narrated: o.narrated };
}

/** Why a failed final check cannot be approved anyway. */
export type WaiverBlock = "terms" | "provenance" | "audio";

export interface QcWaiver {
  /** Approve anyway may be offered: there are issues and none of them blocks. */
  waivable: boolean;
  blocks: WaiverBlock[];
  /** Short names of the failed checks, for the hint and the card. */
  checks: string[];
}

/** Gates whose failure is about rights, provenance or copyright: never waived. */
const NEVER_WAIVED_GATES: readonly GateId[] = ["G-assets", "G-compliance", "G-claims"];
/** Provenance, licence and copyright lines (provenance.ts, assetsGate, complianceGate, claimsGate) on a card made before payload.qc. */
const PROVENANCE_RE =
  /no licence or permission note|reference video can be studied|add an origin link|shows a real person|shows a brand logo|asset with a provenance record|assets are not allowed in this template|is not allowed in this template|^Vision check:|copyright checklist|Music has no licence|YouTube reports a/i;

const CHECK_NAMES: ReadonlyArray<[RegExp, string]> = [
  [/^A shot longer than allowed/, "shot length"],
  [/hook window/, "hook window"],
  [/^Loudness/, "loudness"],
  [/^True peak/, "true peak"],
  [/^Black frames/, "black frames"],
  [/^Frozen picture/, "frozen picture"],
  [/^Silence for/, "silence"],
  [/^Resolution/, "resolution"],
  [/^Frame rate/, "frame rate"],
  [/^Duration/, "duration"],
];

/** A short name for one quality-check issue ("shot length", "loudness"), or the issue itself. */
export function checkName(issue: string): string {
  if (issue === SILENT_AUDIO_ISSUE) return "silent audio";
  if (issue === NO_AUDIO_ISSUE) return "no audio track";
  if (isTermsIssue(issue)) return "provider terms";
  for (const [re, name] of CHECK_NAMES) if (re.test(issue)) return name;
  return issue.length > 80 ? `${issue.slice(0, 77)}...` : issue;
}

/**
 * Whether a failed final quality check may be approved anyway by the owner. Never for provider terms (not confirmed or
 * refused), provenance or copyright problems (an assets, compliance or claims gate), or a silent or missing audio track
 * on a narrated style. Everything else the technical check measures (shot length, the hook window, loudness, black or
 * frozen frames, resolution, duration) and a voice problem the owner already let through may be waived. A card made
 * before payload.qc counts as narrated.
 */
export function qcWaiver(issues: readonly string[], facts: QcFacts | null | undefined): QcWaiver {
  const blocks: WaiverBlock[] = [];
  const add = (b: WaiverBlock) => {
    if (!blocks.includes(b)) blocks.push(b);
  };
  if (issues.some(isTermsIssue)) add("terms");
  if ((facts?.failedGates ?? []).some((g) => NEVER_WAIVED_GATES.includes(g)) || issues.some((i) => PROVENANCE_RE.test(i))) add("provenance");
  if (facts?.narrated !== false && issues.some((i) => i === SILENT_AUDIO_ISSUE || i === NO_AUDIO_ISSUE)) add("audio");
  const checks = [...new Set(issues.map(checkName))];
  return { waivable: issues.length > 0 && blocks.length === 0, blocks, checks };
}

/**
 * The line on a failed final quality check that says why there is no plain Approve, and what the owner can do.
 * Null for every other card.
 */
export function qcFailureText(kind: ReviewKind, stage: string, ctx: DecisionContext & { isOwner?: boolean } = {}): string | null {
  if (kind !== "gate-failure" || stage !== "qc") return null;
  const issues = ctx.issues ?? [];
  const w = qcWaiver(issues, ctx.qc);
  const what = w.checks.length > 0 ? w.checks.join(", ") : "see the issues above";
  if (w.waivable) {
    const who = ctx.isOwner ? "You can approve anyway" : "The owner can approve anyway";
    const score = !ctx.trial ? "" : ctx.isOwner ? " Save your score first; the curation record marks the check as waived." : " The owner's score is needed first, and the curation record marks the check as waived.";
    return `The quality check failed: ${what}. ${who}; it is recorded.${score}`;
  }
  const why: string[] = [];
  if (w.blocks.includes("terms")) {
    why.push("Provider terms are not confirmed or were refused for some of this work, which is never waived: confirm them in Settings, then send a revision about the images or the voice so that step is checked again.");
  }
  if (w.blocks.includes("provenance")) {
    why.push("A provenance or copyright problem (a licence, permission or source) is never waived: send a revision so the affected work is replaced.");
  }
  if (w.blocks.includes("audio")) {
    const redo = ctx.hermesRender ? "Hermes redoes the video with your note" : "the video is rendered again (the mix) with the same narration";
    why.push(`A narrated video with silent or missing sound is never approved: send a revision about the sound, and ${redo}.`);
  }
  return `The quality check failed: ${what}. ${why.join(" ")}`;
}

const VOICE_ONLY = "The narration will be recorded again only for a note about the voice itself (its accent, pronunciation, or a robotic or wrong voice).";

/** Where a revision note on the finished video (render or quality-check card) goes, said before the owner writes it. */
export function videoRevisionHint(ctx: Pick<DecisionContext, "hermesRender" | "voiced">): string {
  if (ctx.hermesRender) return ctx.voiced === false ? "Hermes will redo the video with your note, its voice included." : `Hermes will redo the video with your note. ${VOICE_ONLY}`;
  return `A note about missing or wrong sound renders the video again (the mix) with the same narration. ${VOICE_ONLY}`;
}

/** What the owner is told once a revision note on the finished video is sent, by where it went. Null: the usual line. */
export function videoRevisionMessage(target: string, ctx: Pick<DecisionContext, "hermesRender">): string | null {
  if (target === "render") return ctx.hermesRender ? "Revision sent. Hermes will redo the video with your note." : "Revision sent. The video is rendered again with the same narration.";
  if (target === "voice") return "Revision sent. The narration will be recorded again with your note, then the video is made again.";
  return null;
}

/** What a script fit keeps, in the run's own words: its pictures, or the plan of a workflow that makes none. */
export function keptWord(pictures: boolean | undefined): string {
  return pictures === false ? "the plan" : "the pictures";
}

/** The Tighten (or Lengthen) button text for a run. */
export function tightenLabel(pictures: boolean | undefined, lengthen = false): string {
  return `${lengthen ? "Lengthen" : "Tighten"} the script, keep ${keptWord(pictures)}`;
}

/**
 * A voice gate failure. Terms-only cards keep their old choices. Otherwise: fit and tighten for a narration that
 * does not fit the video, Approve anyway when every problem is soft and no terms issue is open, Check again always,
 * and Make the voice again unless the only problems are its length (the same voice would come back the same).
 */
function voiceOptions(issues: readonly string[], fix: VoiceFix | null | undefined, tempoReady: boolean): ReviewDecision[] {
  if (onlyTermsIssues(issues)) return ["recheck", "retry", "revise", "reject"];
  const codes = fix?.problems ?? [];
  const out: ReviewDecision[] = [];
  const lengthOnly = codes.length > 0 && codes.every((c) => LENGTH_PROBLEMS.includes(c));
  if (codes.some((c) => LENGTH_PROBLEMS.includes(c))) {
    if (fix?.fitTempo && tempoReady) out.push("fit");
    if (fix?.tightenSec) out.push("tighten");
  }
  // Clipping or a language problem needs a new recording, so that leads. A card made before the voice-length rules has
  // no fix details: Check again leads, so it is judged by the current rules on the narration it has (mixed with terms
  // issues it keeps its old order).
  const rerecord = codes.some((c) => c === "clipped" || c === "language") || (!fix && hasTermsIssues(issues));
  if (lengthOnly) out.push("recheck");
  else if (rerecord) out.push("retry", "recheck");
  else out.push("recheck", "retry");
  if (codes.length > 0 && codes.every((c) => SOFT_PROBLEMS.includes(c)) && !hasTermsIssues(issues)) out.push("override");
  out.push("revise", "reject");
  return out;
}

/**
 * The choices a card offers, the first one being the main button. An assets or voice gate failure held up by provider
 * terms offers "recheck" (nothing is made again); when terms are the only issue it comes first. On such an assets card
 * Retry is left out: no shot failed, so it would only re-check too.
 */
export function decisionOptions(kind: ReviewKind, ctx: DecisionContext = {}): ReviewDecision[] {
  switch (kind) {
    case "idea":
    case "approval":
      return ["approve", "revise", "reject"];
    case "gate-failure": {
      const stage = ctx.stage ?? "";
      if (stage === "voice") return voiceOptions(ctx.issues ?? [], ctx.voice, ctx.tempoReady === true);
      // The final video: Approve anyway (the owner's, audited) when every failed check may be waived. Never for
      // provider terms, provenance or a silent narrated video (qcWaiver); those keep Try again and a revision.
      if (stage === "qc") return qcWaiver(ctx.issues ?? [], ctx.qc).waivable ? ["retry", "override", "revise", "reject"] : ["retry", "revise", "reject"];
      if (!canRecheck(kind, stage, ctx.issues)) return ["retry", "revise", "reject"];
      // A reel whose own voice is held up only by provider terms: the terms are checked again, nothing is rendered again.
      if (stage === "render") return ["recheck", "retry", "revise", "reject"];
      if (!onlyTermsIssues(ctx.issues ?? [])) return ["retry", "recheck", "revise", "reject"];
      return stage === "assets" ? ["recheck", "revise", "reject"] : ["recheck", "retry", "revise", "reject"];
    }
    case "stage-error":
      return ctx.stage === "render" && ctx.museRender ? ["retry", "muse", "revise", "reject"] : ["retry", "revise", "reject"];
  }
}

/**
 * Why the server refuses this decision on this card, or null: a choice the card does not offer, or Approve anyway by
 * someone who is not the owner. decideReview checks this before anything is written; a trial run's final decision
 * also needs the owner's score (presentation.ts presentationRefusal).
 */
export function decisionRefusal(kind: ReviewKind, decision: ReviewDecision, ctx: DecisionContext & { isOwner?: boolean } = {}): string | null {
  if (!decisionOptions(kind, ctx).includes(decision)) return `${reviewTitle(kind, ctx.stage ?? "")}: that choice is not available here`;
  if (decision === "override" && ctx.isOwner !== true) return "Only the owner can approve anyway";
  return null;
}

export const DECISION_LABELS: Record<ReviewDecision, string> = {
  approve: "Approve",
  revise: "Send revision",
  reject: "Reject",
  retry: "Try again",
  recheck: "Check the terms again",
  fit: "Fit the narration to the video",
  tighten: "Tighten the script, keep the pictures",
  override: "Approve anyway",
  muse: "Retry on Muse",
};

/** The button text, named after what the choice really does on this card. */
export function decisionLabel(decision: ReviewDecision, kind: ReviewKind, stage: string, ctx: DecisionContext = {}): string {
  if (decision === "recheck" && stage === "voice" && !hasTermsIssues(ctx.issues)) return "Check again";
  if (decision === "tighten") return tightenLabel(ctx.pictures, Boolean(ctx.voice?.tightenSec && ctx.voice.tightenSec > ctx.voice.narrationSec));
  if (decision === "retry") {
    if (kind === "gate-failure" && stage === "assets") return "Retry failed shots";
    if (kind === "gate-failure" && stage === "voice") return "Make the voice again";
    return "Retry";
  }
  return DECISION_LABELS[decision];
}

const PRODUCTION = ["preview", "assets", "voice", "render", "qc"];
const sec = (n: number) => String(Math.round(n * 10) / 10);

/** One plain line under a button when its effect is not obvious from the label. */
export function decisionHint(decision: ReviewDecision, kind: ReviewKind, stage: string, ctx: DecisionContext = {}): string | null {
  const fix = ctx.voice;
  if (decision === "muse") return "Renders this video on a Muse worker with the same skill from venstudio-styles, instead of Hermes. The script, brief and narration are kept; this run's later renders stay on Muse.";
  if (decision === "recheck") {
    if (stage === "voice" && !hasTermsIssues(ctx.issues)) return "Checks this narration again with the current rules. Nothing is recorded again.";
    if (stage === "render") return "Checks the reel's own voice against the provider terms as they are now. Nothing is rendered again.";
    return stage === "voice"
      ? "Checks the narration you have against the provider terms. Nothing is recorded again."
      : "Checks the images you have against the provider terms. Nothing is made again.";
  }
  if (decision === "fit" && fix?.fitTempo) {
    const way = fix.fitTempo > 1 ? "a little faster" : "a little slower";
    return `Plays the narration ${way} (${fix.fitTempo}x, ${sec(fix.narrationSec / fix.fitTempo)} s instead of ${sec(fix.narrationSec)} s) so it fits the shots. The images and the narration are kept; nothing is made again.`;
  }
  if (decision === "tighten") {
    const to = fix?.tightenSec ? ` to about ${sec(fix.tightenSec)} s` : " to fit the shots";
    return `Hermes rewrites the script${to} with the same beats, and only the voice is recorded again. ${ctx.pictures === false ? "The plan is kept." : "The storyboard and every image are kept."}`;
  }
  if (decision === "override" && stage === "qc") {
    const checks = qcWaiver(ctx.issues ?? [], ctx.qc).checks.join(", ");
    const trial = ctx.trial ? " Save your score first; the curation record marks the quality check as waived and it never counts as a technical pass." : "";
    return `Owner only. Approves this video although these checks failed: ${checks}. Your decision is recorded in the audit log.${trial}`;
  }
  if (decision === "override") return "Owner only. Uses this narration as it is, after you have listened to it. Your decision is recorded in the audit log.";
  if (decision === "reject") {
    if (!PRODUCTION.includes(stage)) return "Cancels the run.";
    return ctx.pictures === false ? "Cancels the run. The narration and video already made stay in Assets." : "Cancels the run. The images and narration already made stay in Assets.";
  }
  if (decision === "revise" && stage === "voice") {
    return `A note about length or speed rewrites the script to fit and keeps ${keptWord(ctx.pictures)}. A note about the voice or accent records the voice again.`;
  }
  if (decision === "retry" && kind === "gate-failure" && stage === "assets") return "Makes only the shots that failed again. Finished images are kept.";
  if (decision === "retry" && kind === "gate-failure" && stage === "voice") return "Records the whole narration again.";
  if (decision === "revise" && stage === "assets" && (kind === "gate-failure" || kind === "approval")) return "Makes every image again with your note.";
  if (decision === "revise" && (stage === "render" || stage === "qc")) return videoRevisionHint(ctx);
  if (decision === "revise" && stage === "preview") return "Your note goes back to the step these stills show (the scene spec or the page), which is made again.";
  return null;
}

export interface SortableReview {
  kind: ReviewKind;
  state: ReviewState;
  /** ISO string or Date. */
  createdAt: string | Date;
}

function time(v: string | Date): number {
  return typeof v === "string" ? new Date(v).getTime() : v.getTime();
}

function rank(kind: ReviewKind): number {
  if (kind === "gate-failure" || kind === "stage-error") return 0;
  if (kind === "approval") return 1;
  return 2;
}

/** Open items first: problems, then approvals, then ideas, oldest first within each. Decided items follow, newest first. */
export function sortReviews<T extends SortableReview>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ao = a.state === "open";
    const bo = b.state === "open";
    if (ao !== bo) return ao ? -1 : 1;
    if (ao) {
      const r = rank(a.kind) - rank(b.kind);
      if (r !== 0) return r;
      return time(a.createdAt) - time(b.createdAt);
    }
    return time(b.createdAt) - time(a.createdAt);
  });
}

/** Plain-language lines for the phone, one per gate. */
export function describeGateIssues(results: GateResult[]): string[] {
  return qcSummary(results);
}

/** What a review item carries for the phone: a summary, and the choices or problems that need the owner. */
export interface ReviewPayload {
  summary: string;
  /** Idea reviews: the proposed ideas, in the order the owner picks by index. */
  ideas?: Array<{ title: string; hook: string; angle: string; score: number }>;
  /** Gate failures: the plain issues. */
  issues?: string[];
  /** Stage errors: why the stage stopped. */
  error?: string;
  /** Why the owner is asked (from the autonomy policy). */
  reason?: string;
  /** One plain line per check that ran (Phase 4 stages). */
  checks?: string[];
  /** Media the owner should look at (Phase 4): asset ids the review card can show. */
  media?: ReviewMedia;
  /** Assets and voice: the asset_providers rows the work is saved under, so the card can name the ones that block. */
  providers?: ProviderRowUse[];
  /** Set when the card replaced another after the gate was checked again (ISO time). */
  recheckedAt?: string;
  /** Things to know that do not fail the check (for example a narration longer than its estimate). */
  notes?: string[];
  /** Voice cards: what the voice gate found and which fixes would work. Read with parseVoiceFix. */
  voice?: VoiceFix;
  /**
   * Scene spec and skill brief cards (workflows without pictures, plan-review.ts): the plan as one line per scene or
   * shot, the brief's project text, and a note on what the card shows.
   */
  plan?: { kind: PlanKind; lines: string[]; text?: string; note?: string };
  /**
   * Scene spec cards: scenes that composed their own geometry instead of naming a kit structure, with the exact parts.
   * Shown so promoting one into `contract.library` is a copy, not a guess — the pack's own validator decides the rest.
   */
  composed?: Array<{ name: string; parts: unknown[] }>;
  /** Final quality check cards: the gates that failed and whether the style is narrated. Read with parseQcFacts. */
  qc?: QcFacts;
}

/**
 * A composed scene is a kit candidate: name the parts by the structure it asked for, or by its place in the run. Pure,
 * because the card only reformats what the stage already stored — the pack's validator still decides the rest.
 */
export function composedScenes(raw: Record<string, unknown>): Array<{ name: string; parts: unknown[] }> {
  const shots = Array.isArray(raw.shots) ? (raw.shots as Array<{ intent?: { structure?: unknown; parts?: unknown } }>) : [];
  return shots
    .filter((s) => s && s.intent && Array.isArray(s.intent.parts) && s.intent.parts.length > 0)
    .map((s, i) => ({
      name: typeof s.intent!.structure === "string" && s.intent!.structure ? (s.intent!.structure as string) : `composed-${i + 1}`,
      parts: s.intent!.parts as unknown[],
    }));
}

/** The kinds of plan a card can show (plan-review.ts). */
export type PlanKind = "scene-spec" | "skill-brief" | "html-design";

export interface ReviewMedia {
  /** provider is the name terms are tracked under (the backend for Hermes images); plugin is the Hermes plugin in front of it. */
  images?: Array<{ assetId: string; shotRef: string; provider: string; plugin?: string }>;
  audioAssetId?: string;
  videoAssetId?: string;
  /** Voice provider, for the audio card. */
  voiceProvider?: string;
  /** Preview cards: still frames of the page (worker artifacts, served by /api/artifacts/<id>), with their time. */
  stills?: Array<{ artifactId: string; atSec: number }>;
}
