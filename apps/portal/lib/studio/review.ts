/**
 * Review inbox domain, pure. What kinds of items the owner sees, how they are ordered, which decisions each
 * kind offers and plain-language labels. Spec: docs/architecture-autonomous-studio.md (Phase 3).
 */
import { qcSummary, type GateResult } from "./qc.ts";

export type ReviewKind = "idea" | "approval" | "gate-failure" | "stage-error";
export type ReviewState = "open" | "approved" | "revision" | "rejected" | "superseded";
export type ReviewDecision = "approve" | "revise" | "reject" | "retry";

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

export function decisionOptions(kind: ReviewKind): ReviewDecision[] {
  switch (kind) {
    case "idea":
    case "approval":
      return ["approve", "revise", "reject"];
    case "gate-failure":
      return ["retry", "revise", "reject"];
    case "stage-error":
      return ["retry", "revise", "reject"];
  }
}

export const DECISION_LABELS: Record<ReviewDecision, string> = {
  approve: "Approve",
  revise: "Send revision",
  reject: "Reject",
  retry: "Try again",
};

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
}

export interface ReviewMedia {
  images?: Array<{ assetId: string; shotRef: string; provider: string }>;
  audioAssetId?: string;
  videoAssetId?: string;
  /** Voice provider, for the audio card. */
  voiceProvider?: string;
}
