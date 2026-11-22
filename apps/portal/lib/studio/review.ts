/**
 * Review inbox domain, pure. What kinds of items the owner sees, how they are ordered, which decisions each
 * kind offers and plain-language labels. Spec: docs/architecture-autonomous-studio.md (Phase 3).
 */
import { qcSummary, type GateResult } from "./qc.ts";
import { onlyTermsIssues } from "./production.ts";
import { canRecheck, hasTermsIssues, type ProviderRowUse } from "./terms-review.ts";
import { LENGTH_PROBLEMS, SOFT_PROBLEMS, type VoiceFix } from "./voice-fit.ts";

export type ReviewKind = "idea" | "approval" | "gate-failure" | "stage-error";
export type ReviewState = "open" | "approved" | "revision" | "rejected" | "superseded";
/**
 * "recheck" runs only the gate again on work that is already made (assets cards held up by provider terms, any voice
 * gate failure). The voice fixes: "fit" plays the narration at a small tempo change so it fits the shots (nothing is
 * made again), "tighten" has Hermes rewrite the script to a length that fits and records only the voice again,
 * "override" is the owner's Approve anyway for a soft voice problem.
 */
export type ReviewDecision = "approve" | "revise" | "reject" | "retry" | "recheck" | "fit" | "tighten" | "override";
export const REVIEW_DECISIONS: readonly ReviewDecision[] = ["approve", "revise", "reject", "retry", "recheck", "fit", "tighten", "override"];

export const STAGE_LABELS: Record<string, string> = {
  idea: "Idea",
  research: "Research",
  script: "Script",
  storyboard: "Storyboard",
  "scene-spec": "Scene spec",
  "skill-brief": "Skill brief",
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
      if (!canRecheck(kind, stage, ctx.issues)) return ["retry", "revise", "reject"];
      if (!onlyTermsIssues(ctx.issues ?? [])) return ["retry", "recheck", "revise", "reject"];
      return stage === "assets" ? ["recheck", "revise", "reject"] : ["recheck", "retry", "revise", "reject"];
    }
    case "stage-error":
      return ["retry", "revise", "reject"];
  }
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
};

/** The button text, named after what the choice really does on this card. */
export function decisionLabel(decision: ReviewDecision, kind: ReviewKind, stage: string, ctx: DecisionContext = {}): string {
  if (decision === "recheck" && stage === "voice" && !hasTermsIssues(ctx.issues)) return "Check again";
  if (decision === "tighten" && ctx.voice?.tightenSec && ctx.voice.tightenSec > ctx.voice.narrationSec) return "Lengthen the script, keep the pictures";
  if (decision === "retry") {
    if (kind === "gate-failure" && stage === "assets") return "Retry failed shots";
    if (kind === "gate-failure" && stage === "voice") return "Make the voice again";
    return "Retry";
  }
  return DECISION_LABELS[decision];
}

const PRODUCTION = ["assets", "voice", "render", "qc"];
const sec = (n: number) => String(Math.round(n * 10) / 10);

/** One plain line under a button when its effect is not obvious from the label. */
export function decisionHint(decision: ReviewDecision, kind: ReviewKind, stage: string, ctx: DecisionContext = {}): string | null {
  const fix = ctx.voice;
  if (decision === "recheck") {
    if (stage === "voice" && !hasTermsIssues(ctx.issues)) return "Checks this narration again with the current rules. Nothing is recorded again.";
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
    return `Hermes rewrites the script${to} with the same beats, and only the voice is recorded again. The storyboard and every image are kept.`;
  }
  if (decision === "override") return "Owner only. Uses this narration as it is, after you have listened to it. Your decision is recorded in the audit log.";
  if (decision === "reject") {
    return PRODUCTION.includes(stage) ? "Cancels the run. The images and narration already made stay in Assets." : "Cancels the run.";
  }
  if (decision === "revise" && stage === "voice") {
    return "A note about length or speed rewrites the script to fit and keeps the pictures. A note about the voice or accent records the voice again.";
  }
  if (decision === "retry" && kind === "gate-failure" && stage === "assets") return "Makes only the shots that failed again. Finished images are kept.";
  if (decision === "retry" && kind === "gate-failure" && stage === "voice") return "Records the whole narration again.";
  if (decision === "revise" && stage === "assets" && (kind === "gate-failure" || kind === "approval")) return "Makes every image again with your note.";
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
  plan?: { kind: "scene-spec" | "skill-brief"; lines: string[]; text?: string; note?: string };
}

export interface ReviewMedia {
  /** provider is the name terms are tracked under (the backend for Hermes images); plugin is the Hermes plugin in front of it. */
  images?: Array<{ assetId: string; shotRef: string; provider: string; plugin?: string }>;
  audioAssetId?: string;
  videoAssetId?: string;
  /** Voice provider, for the audio card. */
  voiceProvider?: string;
}
