/**
 * Reads the result of the worker's qc-video job (schemaVersion 1) into the measure that technicalGate expects.
 * Anything malformed returns null, so a bad result never turns into a pass.
 */
import type { Format } from "./catalog.ts";
import { technicalGate, type GateResult, type Run, type TechnicalMeasure } from "./qc.ts";
import type { Template } from "./templates.ts";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function runs(v: unknown): Run[] | null {
  if (!Array.isArray(v)) return null;
  const out: Run[] = [];
  for (const r of v) {
    const o = r as { start?: unknown; end?: unknown } | null;
    const start = num(o?.start);
    const end = num(o?.end);
    if (start === null || end === null) return null;
    out.push({ start, end });
  }
  return out;
}

export function measureFromQcResult(result: unknown): TechnicalMeasure | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;
  if (r.schemaVersion !== 1) return null;
  const width = num(r.width);
  const height = num(r.height);
  const fps = num(r.fps);
  const durationSec = num(r.durationSec);
  const blackRuns = runs(r.blackRuns);
  const silenceRuns = runs(r.silenceRuns);
  const freezeRuns = runs(r.freezeRuns);
  if (width === null || height === null || fps === null || durationSec === null) return null;
  if (!blackRuns || !silenceRuns || !freezeRuns || typeof r.hasAudio !== "boolean") return null;
  if (!Array.isArray(r.cuts) || !r.cuts.every((c) => num(c) !== null)) return null;
  return {
    width,
    height,
    fps,
    durationSec,
    hasAudio: r.hasAudio,
    integratedLufs: num(r.integratedLufs),
    truePeakDb: num(r.truePeakDb),
    blackRuns,
    silenceRuns,
    freezeRuns,
    cuts: r.cuts as number[],
  };
}

/**
 * Adds the scene boundaries the renderer placed to the cuts qc-video detected. The detector looks for an abrupt
 * picture change, so a cross-fade or an animated scene change is never seen as a cut, and every faded render would
 * fail the shot-length and hook checks. The planned boundaries are real scene changes by construction (the renderer
 * started a new scene there). Only finite times strictly inside the video are used, and times within 0.1 s of a
 * detected cut are not added twice.
 */
export function withPlannedCuts(m: TechnicalMeasure, planned: unknown): TechnicalMeasure {
  if (!Array.isArray(planned)) return m;
  const cuts = [...m.cuts];
  for (const p of planned.slice(0, 500)) {
    const t = num(p);
    if (t === null || t <= 0 || t >= m.durationSec) continue;
    if (cuts.some((c) => Math.abs(c - t) < 0.1)) continue;
    cuts.push(t);
  }
  cuts.sort((a, b) => a - b);
  return { ...m, cuts };
}

const QC_EXECUTOR = "worker qc-video";
const failedTechnical = (issue: string): GateResult => ({ gate: "G-technical", passed: false, issues: [issue], executor: QC_EXECUTOR });

/**
 * The G-technical report for one finished qc-video job. A failed job, an unreadable result and a missing
 * template each give a failed report, never "no report", so a production always ends with a QC record.
 */
/**
 * The lowest similarity a render may have with the still the owner approved: the preview is a promise about the look,
 * so a video that does not keep it fails the technical gate instead of passing quietly. Measured on the voxel page:
 * the same moment scores 0.978 (a JPEG still against an H.264 frame), a different scene of the same video 0.44-0.51.
 * 0.85 sits in the gap, so a real drift fails and encoding noise does not.
 */
export const PREVIEW_MATCH_MIN_SSIM = 0.85;

/** The stills whose frame in the finished video does not look like the approved preview, as gate issues. */
export function previewDrift(result: unknown): string[] {
  const r = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
  if (!Array.isArray(r.previewMatch)) return [];
  const out: string[] = [];
  for (const raw of r.previewMatch.slice(0, 6)) {
    const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const at = typeof o.atSec === "number" && Number.isFinite(o.atSec) ? Math.round(o.atSec * 10) / 10 : null;
    if (at === null) continue;
    const ssim = typeof o.ssim === "number" && Number.isFinite(o.ssim) ? o.ssim : null;
    if (ssim === null) out.push(`The frame at ${at} s could not be compared with the approved still`);
    else if (ssim < PREVIEW_MATCH_MIN_SSIM) out.push(`The video at ${at} s does not look like the approved still (similarity ${ssim.toFixed(2)})`);
  }
  return out;
}

export function technicalReportFor(
  job: { status: string; error?: unknown; result?: unknown },
  template: Template | null,
  format: Format,
  templateId: string,
  /** Scene boundaries the renderer placed, in seconds (see withPlannedCuts). Optional. */
  plannedCuts?: unknown,
): {
  gate: GateResult;
  measure: TechnicalMeasure | null;
} {
  if (job.status === "failed") {
    return { gate: failedTechnical(`The quality check job failed: ${String(job.error ?? "no reason recorded").slice(0, 300)}`), measure: null };
  }
  const read = measureFromQcResult(job.result);
  const measure = read ? withPlannedCuts(read, plannedCuts) : null;
  if (!measure) return { gate: failedTechnical("The quality check result could not be read"), measure: null };
  if (!template) return { gate: failedTechnical(`Template ${templateId} was not found, so the video could not be checked`), measure };
  const gate = { ...technicalGate(measure, template, format), executor: QC_EXECUTOR };
  const drift = previewDrift(job.result);
  if (drift.length === 0) return { gate, measure };
  return { gate: { ...gate, passed: false, issues: [...gate.issues, ...drift] }, measure };
}
