import "server-only";
import { db } from "./db.ts";
import { createJob, URGENT_PRIORITY } from "./jobs.ts";
import { saveQcReport } from "./qc.ts";
import { ensureSeedTemplates, getTemplate } from "./templates.ts";
import type { Format } from "../studio/catalog.ts";
import { technicalGate, type GateResult } from "../studio/qc.ts";
import { measureFromQcResult } from "../studio/qc-result.ts";

/**
 * Queues a quality check of one video asset for a production. Urgent, like a test render: the first free
 * worker with ffmpeg takes it instead of waiting for the channel's home worker.
 */
export async function createQcJob(assetId: string, productionId: string, createdBy: string): Promise<string> {
  const [p] = await db()`SELECT channel_id FROM productions WHERE id = ${productionId}`;
  return createJob({
    type: "qc-video",
    payload: { inputs: [assetId], productionId },
    channelId: (p?.channel_id as string | null | undefined) ?? null,
    priority: URGENT_PRIORITY,
    createdBy,
  });
}

/**
 * Called after any job completes. For a qc-video job on a production it runs the technical gate against the
 * production's template and stores the report. It never throws: a QC evaluation problem must not fail the job.
 */
export async function evaluateQcCompletion(jobId: string): Promise<void> {
  try {
    const sql = db();
    const [job] = await sql`SELECT type, status, payload, result FROM jobs WHERE id = ${jobId}`;
    if (!job || job.type !== "qc-video" || job.status !== "succeeded") return;
    const productionId = typeof job.payload?.productionId === "string" ? (job.payload.productionId as string) : null;
    if (!productionId) return;
    const [existing] = await sql`SELECT id FROM qc_reports WHERE job_id = ${jobId} AND gate = 'G-technical'`;
    if (existing) return;
    const [p] = await sql`SELECT format, style_id, template_id FROM productions WHERE id = ${productionId}`;
    if (!p) return;
    const assetId = Array.isArray(job.payload?.inputs) && typeof job.payload.inputs[0] === "string" ? (job.payload.inputs[0] as string) : null;

    const measure = measureFromQcResult(job.result);
    let gate: GateResult;
    if (!measure) {
      gate = { gate: "G-technical", passed: false, issues: ["The quality check result could not be read"], executor: "worker qc-video" };
    } else {
      const templateId = (p.template_id as string | null) ?? `tpl-${p.style_id as string}`;
      let template = await getTemplate(templateId);
      if (!template) {
        await ensureSeedTemplates();
        template = await getTemplate(templateId);
      }
      if (!template) return;
      gate = technicalGate(measure, template, p.format as Format);
      gate = { ...gate, executor: "worker qc-video" };
    }
    await saveQcReport({ result: gate, productionId, jobId, assetId, details: measure ? { measure } : {} });
  } catch (err) {
    console.error("qc evaluation failed", err);
  }
}
