/**
 * Review inbox domain, pure. What kinds of items the owner sees, how they are ordered, which decisions each
 * kind offers and plain-language labels. Spec: docs/architecture-autonomous-studio.md (Phase 3).
 */
import { qcSummary, type GateResult } from "./qc.ts";
import { onlyTermsIssues } from "./production.ts";
import { canRecheck, type ProviderRowUse } from "./terms-review.ts";

export type ReviewKind = "idea" | "approval" | "gate-failure" | "stage-error";
export type ReviewState = "open" | "approved" | "revision" | "rejected" | "superseded";
/** "recheck" runs only the gate again on work that is already made (assets and voice cards held up by provider terms). */
export type ReviewDecision = "approve" | "revise" | "reject" | "retry" | "recheck";

export const STAGE_LABELS: Record<string, string> = {
  idea: "Idea",
  research: "Research",
  script: "Script",
  storyboard: "Storyboard",
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
};

/** The button text, named after what the choice really does on this card. */
export function decisionLabel(decision: ReviewDecision, kind: ReviewKind, stage: string): string {
  if (decision === "retry") {
    if (kind === "gate-failure" && stage === "assets") return "Retry failed shots";
    if (kind === "gate-failure" && stage === "voice") return "Make the voice again";
    return "Retry";
  }
  return DECISION_LABELS[decision];
}

/** One plain line under a button when its effect is not obvious from the label. */
export function decisionHint(decision: ReviewDecision, kind: ReviewKind, stage: string): string | null {
  if (decision === "recheck") {
    return stage === "voice"
      ? "Checks the narration you have against the provider terms. Nothing is recorded again."
      : "Checks the images you have against the provider terms. Nothing is made again.";
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
}

export interface ReviewMedia {
  /** provider is the name terms are tracked under (the backend for Hermes images); plugin is the Hermes plugin in front of it. */
  images?: Array<{ assetId: string; shotRef: string; provider: string; plugin?: string }>;
  audioAssetId?: string;
  videoAssetId?: string;
  /** Voice provider, for the audio card. */
  voiceProvider?: string;
}
