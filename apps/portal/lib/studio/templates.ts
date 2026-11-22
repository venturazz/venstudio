/**
 * Final templates: every style becomes a template with a lifecycle (draft, candidate, proven, retired).
 * Seed styles ship as "candidate" and only become "proven" through trial evidence plus the owner's
 * copyright sign-off. Pure data and functions; transitions never mutate their input.
 * Spec: docs/architecture-autonomous-studio.md and docs/research/04-autonomous-studio-workflow.md
 */
import { STYLES, type AssetKind, type AssetSource, type Family, type Format, type Style } from "./catalog.ts";

export type TemplateStatus = "draft" | "candidate" | "proven" | "retired";
export type BeatRole = "hook" | "setup" | "body" | "payoff" | "cta" | "outro";
export type MusicPolicy = "none" | "self-generated" | "licensed" | "self-or-licensed";

export interface Beat {
  id: string;
  role: BeatRole;
  /** Share of the total duration this beat may take, as [min, max] fractions. */
  shareOfDuration: [number, number];
  maxShotSeconds: number;
}

export interface ChecklistItem {
  id: string;
  label: string;
  signedOff: { userId: string; date: string } | null;
}

export interface TemplateEvidence {
  trials: number;
  /** Share of trials that passed G-technical, 0..1. */
  passRate: number;
  meanPresentationScore: number;
  assetFailures: number;
  complianceFailures: number;
  /** Open copyright claims or restrictions. */
  claims: number;
}

export interface Template {
  id: string;
  version: number;
  styleId: string;
  family: Family;
  label: string;
  status: TemplateStatus;
  formats: Format[];
  beats: Beat[];
  pacing: { maxShotSeconds: number; hookByMs: number; cutsPerMinute: [number, number] };
  audio: { targetLufs: number; maxTruePeakDb: number; narrated: boolean; musicPolicy: MusicPolicy };
  captions: { required: boolean; safeAreaPct: number };
  qc: { minPresentationScore: number };
  assetPolicy: { allowedSources: AssetSource[]; forbidKinds: AssetKind[] };
  copyrightChecklist: ChecklistItem[];
  evidence: TemplateEvidence;
  /** Set only for templates learned from a sample. Numbers and a hash only, never sample content. */
  derivedFrom: { sampleSha256: string; analyzedAt: string; sampleCount: number } | null;
  /** Template Lab revisions used so far (hard cap in template-lab.ts). */
  labRevisions: number;
  /** For a template seeded from a style pack the catalogue does not know: the pack version it was made from. */
  packVersion?: string;
  promoted: { userId: string; date: string } | null;
  demotionReason: string | null;
}

export const PROMOTION_MIN_TRIALS = 5;
export const PROMOTION_MIN_PRESENTATION = 80;

const BEATS_BY_SHAPE: Record<"ending-cta" | "ending-outro" | "single", Array<[BeatRole, [number, number]]>> = {
  "ending-cta": [
    ["hook", [0.05, 0.15]],
    ["setup", [0.1, 0.2]],
    ["body", [0.4, 0.6]],
    ["payoff", [0.1, 0.2]],
    ["cta", [0.03, 0.08]],
  ],
  "ending-outro": [
    ["hook", [0.05, 0.15]],
    ["setup", [0.1, 0.25]],
    ["body", [0.35, 0.55]],
    ["payoff", [0.1, 0.2]],
    ["outro", [0.03, 0.1]],
  ],
  single: [["body", [1, 1]]],
};

function shapeFor(family: Family): keyof typeof BEATS_BY_SHAPE {
  if (family === "ambient") return "single";
  if (family === "narrative" || family === "animation-2d" || family === "animation-2.5d" || family === "animation-3d") return "ending-outro";
  return "ending-cta";
}

export function beatsFor(family: Family, maxShotSeconds: number): Beat[] {
  return beatsForShape(shapeFor(family), maxShotSeconds);
}

/** The beats of a beat shape (a style pack's portal.beatShape). */
export function beatsForShape(shape: keyof typeof BEATS_BY_SHAPE, maxShotSeconds: number): Beat[] {
  return BEATS_BY_SHAPE[shape].map(([role, share]) => ({ id: role, role, shareOfDuration: [share[0], share[1]], maxShotSeconds }));
}

export const STANDARD_CHECKLIST: Array<{ id: string; label: string }> = [
  { id: "original-script", label: "The script is original, not copied or closely paraphrased from a source" },
  { id: "music-licence", label: "Music is licensed or self-made, with the licence on record" },
  { id: "no-reference-footage", label: "No reference or third-party footage appears in the video" },
  { id: "no-third-party-likeness", label: "No third-party logos or real people's likeness without written permission" },
  { id: "ai-disclosure", label: "The AI disclosure decision is made and recorded" },
];

export function checklistFor(cautions: string[]): ChecklistItem[] {
  const items = STANDARD_CHECKLIST.map((i) => ({ id: i.id, label: i.label, signedOff: null }));
  cautions.forEach((c, n) => items.push({ id: `caution-${n + 1}`, label: c, signedOff: null }));
  return items;
}

export function emptyEvidence(): TemplateEvidence {
  return { trials: 0, passRate: 0, meanPresentationScore: 0, assetFailures: 0, complianceFailures: 0, claims: 0 };
}

export function defaultAssetPolicy(): Template["assetPolicy"] {
  return { allowedSources: ["upload", "hermes", "muse", "worker", "licensed", "generated"], forbidKinds: ["reference-video"] };
}

/** Cuts per minute that match a shot length range, rounded outward to whole cuts. */
export function cutsPerMinuteFor(shotSeconds: [number, number]): [number, number] {
  return [Math.max(1, Math.floor(60 / shotSeconds[1])), Math.max(1, Math.ceil(60 / shotSeconds[0]))];
}

function seedOne(style: Style): Template {
  const maxShot = style.shotSeconds[1];
  const ambient = style.family === "ambient";
  return {
    id: `tpl-${style.id}`,
    version: 1,
    styleId: style.id,
    family: style.family,
    label: style.label,
    status: "candidate",
    formats: [...style.formats],
    beats: beatsFor(style.family, maxShot),
    pacing: {
      maxShotSeconds: maxShot,
      hookByMs: ambient || !style.formats.includes("short") ? 5000 : 3000,
      cutsPerMinute: cutsPerMinuteFor(style.shotSeconds),
    },
    audio: { targetLufs: -14, maxTruePeakDb: -1, narrated: style.narration, musicPolicy: "self-or-licensed" },
    captions: { required: !ambient, safeAreaPct: 8 },
    qc: { minPresentationScore: 75 },
    assetPolicy: defaultAssetPolicy(),
    copyrightChecklist: checklistFor(style.cautions),
    evidence: emptyEvidence(),
    derivedFrom: null,
    labRevisions: 0,
    promoted: null,
    demotionReason: null,
  };
}

/** One candidate template per catalog style. Never "proven": that needs trials and the owner's sign-off. */
export function seedTemplates(): Template[] {
  return STYLES.map(seedOne);
}

export function checklistSigned(t: Template): boolean {
  return t.copyrightChecklist.length > 0 && t.copyrightChecklist.every((i) => i.signedOff !== null);
}

/** Autonomous publishing is only allowed for a proven template with a fully signed checklist. */
export function isAutonomyEligible(t: Template): boolean {
  return t.status === "proven" && checklistSigned(t);
}

/** What is still missing before a candidate may become proven. Empty means ready. */
export function promotionIssues(t: Template): string[] {
  const issues: string[] = [];
  if (t.status !== "candidate") issues.push(`Only a candidate can be promoted (this template is ${t.status})`);
  const e = t.evidence;
  if (e.trials < PROMOTION_MIN_TRIALS) issues.push(`Needs at least ${PROMOTION_MIN_TRIALS} trial runs (has ${e.trials})`);
  if (e.passRate < 1) issues.push(`Every trial must pass the technical gate (pass rate is ${Math.round(e.passRate * 100)} percent)`);
  if (e.meanPresentationScore < PROMOTION_MIN_PRESENTATION) {
    issues.push(`Mean presentation score must be at least ${PROMOTION_MIN_PRESENTATION} (is ${Math.round(e.meanPresentationScore)})`);
  }
  if (e.assetFailures > 0) issues.push(`${e.assetFailures} trial(s) failed the assets gate`);
  if (e.complianceFailures > 0) issues.push(`${e.complianceFailures} trial(s) failed the compliance gate`);
  const unsigned = t.copyrightChecklist.filter((i) => i.signedOff === null);
  if (t.copyrightChecklist.length === 0) issues.push("The copyright checklist is empty");
  if (unsigned.length > 0) issues.push(`Copyright checklist not signed off: ${unsigned.map((i) => i.id).join(", ")}`);
  if (e.claims > 0) issues.push(`${e.claims} open copyright claim(s)`);
  return issues;
}

export type PromoteResult = { ok: true; template: Template } | { ok: false; issues: string[] };

export function promote(t: Template, now: Date, userId: string): PromoteResult {
  const issues = promotionIssues(t);
  if (!userId.trim()) issues.push("Promotion needs the owner's user id");
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, template: { ...clone(t), status: "proven", promoted: { userId, date: now.toISOString() }, demotionReason: null } };
}

/** Back to candidate. Sign-offs are cleared so the owner must review the checklist again. */
export function demote(t: Template, reason: string): Template {
  const c = clone(t);
  c.status = "candidate";
  c.promoted = null;
  c.demotionReason = reason;
  c.copyrightChecklist = c.copyrightChecklist.map((i) => ({ ...i, signedOff: null }));
  return c;
}

/** Owner sign-off of one checklist item. Returns a copy; unknown ids change nothing. */
export function signOff(t: Template, itemId: string, userId: string, now: Date): Template {
  const c = clone(t);
  c.copyrightChecklist = c.copyrightChecklist.map((i) => (i.id === itemId ? { ...i, signedOff: { userId, date: now.toISOString() } } : i));
  return c;
}

export function clone(t: Template): Template {
  return JSON.parse(JSON.stringify(t)) as Template;
}
