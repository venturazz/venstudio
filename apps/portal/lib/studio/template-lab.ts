/**
 * Template Lab: learns the structure of sample videos as numbers and turns it into a draft template.
 * It never keeps text, frames, palette, titles or audio from a sample. The fingerprint and the Template type
 * have no field that could hold them. Trials then test the draft before it can become a candidate.
 */
import { STYLE_BY_ID } from "./catalog.ts";
import type { GateId, GateResult } from "./qc.ts";
import { beatsFor, checklistFor, clone, cutsPerMinuteFor, defaultAssetPolicy, emptyEvidence, type Template, type TemplateEvidence } from "./templates.ts";

/** The parts of the worker's analysis.json (analyze-video job, schemaVersion 1) that the lab reads. */
export interface AnalysisInput {
  video: { durationSec: number; width: number; height: number; fps?: number };
  cuts: number[];
  shots: { count: number; avgSeconds: number; medianSeconds: number; shortestSeconds: number; longestSeconds: number };
  hook: { firstCutSeconds: number | null };
  pacing: { cutsPerMinute: number };
  loudnessLufs: number | null;
}

/** Numbers only. */
export interface StructureFingerprint {
  samples: number;
  shotSeconds: { p10: number; p50: number; p90: number };
  firstCutSeconds: number;
  cutsPerMinute: number;
  loudnessLufs: number | null;
  aspect: number;
  durationSec: number;
  /** Share of all cuts that fall in each of five equal parts of the video. Sums to 1, or all 0 without cuts. */
  segmentCutShare: [number, number, number, number, number];
}

export const MAX_LAB_REVISIONS = 5;
export const MIN_SAMPLES_FOR_CANDIDATE = 3;
export const MAX_COPIED_FIELDS = 5;
export const MAX_SHOT_RANGE: [number, number] = [1, 20];
export const HOOK_MS_RANGE: [number, number] = [500, 5000];
export const SAFE_AREA_RANGE: [number, number] = [5, 20];

const round = (n: number, places = 2): number => Math.round(n * 10 ** places) / 10 ** places;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(values: number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

export function fingerprint(a: AnalysisInput): StructureFingerprint {
  const d = a.video.durationSec;
  const cuts = [...a.cuts].filter((c) => c > 0 && c < d).sort((x, y) => x - y);
  const bounds = [0, ...cuts, d];
  const shots = bounds.slice(1).map((t, i) => t - bounds[i]).filter((s) => s > 0).sort((x, y) => x - y);
  const seg: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  for (const c of cuts) seg[Math.min(4, Math.floor((c / d) * 5))]++;
  const share = seg.map((n) => (cuts.length ? round(n / cuts.length, 3) : 0)) as [number, number, number, number, number];
  return {
    samples: 1,
    shotSeconds: { p10: round(quantile(shots, 0.1)), p50: round(quantile(shots, 0.5)), p90: round(quantile(shots, 0.9)) },
    firstCutSeconds: round(a.hook.firstCutSeconds ?? cuts[0] ?? d),
    cutsPerMinute: round(d > 0 ? cuts.length / (d / 60) : 0),
    loudnessLufs: a.loudnessLufs,
    aspect: a.video.height > 0 ? round(a.video.width / a.video.height, 3) : 0,
    durationSec: round(d),
    segmentCutShare: share,
  };
}

/** Median of each field. At least one sample is required; fewer than three keeps the result a draft. */
export function blendFingerprints(fps: StructureFingerprint[]): StructureFingerprint {
  if (fps.length === 0) throw new RangeError("blendFingerprints needs at least one fingerprint");
  const med = (pick: (f: StructureFingerprint) => number): number => round(median(fps.map(pick)));
  const loud = fps.map((f) => f.loudnessLufs).filter((v): v is number => v !== null);
  const seg = [0, 1, 2, 3, 4].map((i) => median(fps.map((f) => f.segmentCutShare[i])));
  const total = seg.reduce((a, b) => a + b, 0);
  const norm = seg.map((v) => (total > 0 ? round(v / total, 3) : 0)) as [number, number, number, number, number];
  return {
    samples: fps.length,
    shotSeconds: { p10: med((f) => f.shotSeconds.p10), p50: med((f) => f.shotSeconds.p50), p90: med((f) => f.shotSeconds.p90) },
    firstCutSeconds: med((f) => f.firstCutSeconds),
    cutsPerMinute: med((f) => f.cutsPerMinute),
    loudnessLufs: loud.length ? round(median(loud)) : null,
    aspect: med((f) => f.aspect),
    durationSec: med((f) => f.durationSec),
    segmentCutShare: norm,
  };
}

export interface DraftOptions {
  /** Hash of the sample file (or of the blended sample set). The only trace of the sample kept. */
  sampleSha256: string;
  analyzedAt: string;
  /** Our own name for the template, never the sample's title. */
  label: string;
  /** Unique id suffix, e.g. a short random string. */
  idSuffix: string;
}

/**
 * A draft template with pacing taken from the fingerprint. The base style supplies family, engine rules,
 * checklist and beats; the sample supplies only numbers. Pacing is rounded so it is never a copy of one sample.
 */
export function draftFromFingerprint(fp: StructureFingerprint, baseStyleId: string, opts: DraftOptions): Template {
  const style = STYLE_BY_ID[baseStyleId];
  if (!style) throw new RangeError(`Unknown base style ${baseStyleId}`);
  const maxShot = clamp(Math.round((fp.shotSeconds.p90 * 1.1) * 2) / 2, MAX_SHOT_RANGE[0], MAX_SHOT_RANGE[1]);
  const hookByMs = clamp(Math.ceil((fp.firstCutSeconds * 1000) / 100) * 100, HOOK_MS_RANGE[0], HOOK_MS_RANGE[1]);
  const mid = Math.max(1, Math.round(fp.cutsPerMinute));
  const cpm: [number, number] = fp.cutsPerMinute > 0 ? [Math.max(1, Math.floor(mid * 0.8)), Math.ceil(mid * 1.2)] : cutsPerMinuteFor([maxShot, maxShot]);
  return {
    id: `tpl-lab-${opts.idSuffix}`,
    version: 1,
    styleId: style.id,
    family: style.family,
    label: opts.label,
    status: "draft",
    formats: [...style.formats],
    beats: beatsFor(style.family, maxShot),
    pacing: { maxShotSeconds: maxShot, hookByMs, cutsPerMinute: cpm },
    audio: { targetLufs: -14, maxTruePeakDb: -1, narrated: style.narration, musicPolicy: "self-or-licensed" },
    captions: { required: style.family !== "ambient", safeAreaPct: 8 },
    qc: { minPresentationScore: 75 },
    assetPolicy: defaultAssetPolicy(),
    copyrightChecklist: checklistFor(style.cautions),
    evidence: emptyEvidence(),
    derivedFrom: { sampleSha256: opts.sampleSha256, analyzedAt: opts.analyzedAt, sampleCount: fp.samples },
    labRevisions: 0,
    promoted: null,
    demotionReason: null,
  };
}

export interface SampleMeta {
  title: string;
  channel: string;
  fileName?: string;
  /** The single-sample fingerprint, to detect an unblended copy. */
  fingerprint?: StructureFingerprint;
}

function numbersOf(t: Template): number[] {
  return [t.pacing.maxShotSeconds, t.pacing.hookByMs, t.pacing.cutsPerMinute[0], t.pacing.cutsPerMinute[1], ...t.beats.map((b) => b.maxShotSeconds)];
}

function fingerprintNumbers(fp: StructureFingerprint): number[] {
  return [fp.shotSeconds.p10, fp.shotSeconds.p50, fp.shotSeconds.p90, fp.firstCutSeconds, fp.firstCutSeconds * 1000, fp.cutsPerMinute, fp.durationSec, fp.aspect];
}

/** Issues that reject a draft: it names the sample, or copies one sample's numbers exactly. Empty means acceptable. */
export function originalityGuard(t: Template, sample: SampleMeta): string[] {
  const issues: string[] = [];
  const text = [t.label, ...t.beats.flatMap((b) => [b.id, b.role]), ...t.copyrightChecklist.map((c) => c.label)].join("\n").toLowerCase();
  const names: Array<[string, string | undefined]> = [["title", sample.title], ["channel name", sample.channel], ["file name", sample.fileName]];
  for (const [what, value] of names) {
    const v = (value ?? "").trim().toLowerCase();
    if (v.length >= 3 && text.includes(v)) issues.push(`The template contains the sample's ${what}`);
  }
  if (sample.fingerprint) {
    const theirs = fingerprintNumbers(sample.fingerprint);
    const copied = numbersOf(t).filter((n) => theirs.includes(n)).length;
    if (copied > MAX_COPIED_FIELDS) issues.push("Too close to one sample; blend at least 3 samples or round");
  }
  return issues;
}

export interface CandidateResult {
  template: Template;
  issues: string[];
}

/** A draft leaves draft only when it came from at least three blended samples and passes the originality guard. */
export function candidateFromDraft(draft: Template, sample: SampleMeta): CandidateResult {
  const issues = originalityGuard(draft, sample);
  const count = draft.derivedFrom?.sampleCount ?? 0;
  if (count < MIN_SAMPLES_FOR_CANDIDATE) issues.push(`Needs at least ${MIN_SAMPLES_FOR_CANDIDATE} samples to leave draft (has ${count})`);
  const next = clone(draft);
  if (issues.length === 0) next.status = "candidate";
  return { template: next, issues };
}

export interface TrialScore {
  passedTechnical: boolean;
  presentationScore: number | null;
  assetFailed: boolean;
  complianceFailed: boolean;
}

function gate(results: GateResult[], id: GateId): GateResult | undefined {
  return results.find((r) => r.gate === id);
}

/** Reduces one trial's gate results to the numbers that promotion looks at. */
export function scoreTrial(results: GateResult[]): TrialScore {
  const tech = gate(results, "G-technical");
  const pres = gate(results, "G-presentation");
  return {
    passedTechnical: tech?.passed === true,
    presentationScore: pres?.score ?? null,
    assetFailed: gate(results, "G-assets")?.passed === false,
    complianceFailed: gate(results, "G-compliance")?.passed === false,
  };
}

export function evidenceFrom(scores: TrialScore[], claims: number): TemplateEvidence {
  const n = scores.length;
  const presented = scores.filter((s) => s.presentationScore !== null).map((s) => s.presentationScore as number);
  return {
    trials: n,
    passRate: n ? scores.filter((s) => s.passedTechnical).length / n : 0,
    meanPresentationScore: presented.length ? presented.reduce((a, b) => a + b, 0) / presented.length : 0,
    assetFailures: scores.filter((s) => s.assetFailed).length,
    complianceFailures: scores.filter((s) => s.complianceFailed).length,
    claims,
  };
}

export function withEvidence(t: Template, scores: TrialScore[], claims: number): Template {
  return { ...clone(t), evidence: evidenceFrom(scores, claims) };
}

export type RevisionResult = { template: Template; changed: string[] } | { stop: string };

function mentions(r: GateResult | undefined, word: string): boolean {
  return !!r && !r.passed && r.issues.some((i) => i.toLowerCase().includes(word));
}

/**
 * One bounded revision from the latest trial. Changes are small (10 percent, 2 points) and stay inside the
 * clamps. After MAX_LAB_REVISIONS the lab stops and hands the template to the owner.
 */
export function nextRevision(t: Template, trials: GateResult[][]): RevisionResult {
  if (t.labRevisions >= MAX_LAB_REVISIONS) return { stop: `Reached the limit of ${MAX_LAB_REVISIONS} revisions; the owner decides next` };
  const last = trials[trials.length - 1];
  if (!last) return { stop: "No trial has run yet" };
  if (last.length > 0 && last.every((r) => r.passed)) return { stop: "The last trial passed every gate" };
  const next = clone(t);
  const changed: string[] = [];
  const tech = gate(last, "G-technical");
  const pres = gate(last, "G-presentation");
  if (mentions(tech, "shot longer")) {
    const v = round(clamp(next.pacing.maxShotSeconds * 0.9, MAX_SHOT_RANGE[0], MAX_SHOT_RANGE[1]), 1);
    if (v < next.pacing.maxShotSeconds) {
      next.pacing.maxShotSeconds = v;
      next.beats = next.beats.map((b) => ({ ...b, maxShotSeconds: Math.min(b.maxShotSeconds, v) }));
      changed.push(`maxShotSeconds to ${v}`);
    }
  }
  if (mentions(tech, "first cut")) {
    const v = Math.round(clamp(next.pacing.hookByMs * 0.9, HOOK_MS_RANGE[0], HOOK_MS_RANGE[1]));
    if (v < next.pacing.hookByMs) {
      next.pacing.hookByMs = v;
      changed.push(`hookByMs to ${v}`);
    }
  }
  if (mentions(pres, "caption") || mentions(pres, "text")) {
    const v = clamp(next.captions.safeAreaPct + 2, SAFE_AREA_RANGE[0], SAFE_AREA_RANGE[1]);
    if (v > next.captions.safeAreaPct) {
      next.captions.safeAreaPct = v;
      changed.push(`captions safeAreaPct to ${v}`);
    }
  }
  if (changed.length === 0) return { stop: "No safe automatic change fits the failures; the owner decides next" };
  next.labRevisions = t.labRevisions + 1;
  return { template: next, changed };
}
