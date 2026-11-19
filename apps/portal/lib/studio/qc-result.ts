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

const QC_EXECUTOR = "worker qc-video";
const failedTechnical = (issue: string): GateResult => ({ gate: "G-technical", passed: false, issues: [issue], executor: QC_EXECUTOR });

/**
 * The G-technical report for one finished qc-video job. A failed job, an unreadable result and a missing
 * template each give a failed report, never "no report", so a production always ends with a QC record.
 */
export function technicalReportFor(job: { status: string; error?: unknown; result?: unknown }, template: Template | null, format: Format, templateId: string): {
  gate: GateResult;
  measure: TechnicalMeasure | null;
} {
  if (job.status === "failed") {
    return { gate: failedTechnical(`The quality check job failed: ${String(job.error ?? "no reason recorded").slice(0, 300)}`), measure: null };
  }
  const measure = measureFromQcResult(job.result);
  if (!measure) return { gate: failedTechnical("The quality check result could not be read"), measure: null };
  if (!template) return { gate: failedTechnical(`Template ${templateId} was not found, so the video could not be checked`), measure };
  return { gate: { ...technicalGate(measure, template, format), executor: QC_EXECUTOR }, measure };
}
