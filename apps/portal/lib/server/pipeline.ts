import "server-only";
import { db } from "./db.ts";
import { createJob, URGENT_PRIORITY } from "./jobs.ts";
import { saveQcReport } from "./qc.ts";
import { ensureSeedTemplates, getTemplate } from "./templates.ts";
import type { Format } from "../studio/catalog.ts";
import type { Template } from "../studio/templates.ts";
import { technicalReportFor } from "../studio/qc-result.ts";

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
 * Stores the G-technical report for one finished qc-video job tied to a production. A failed job, an unreadable
 * result and a missing template each store a failed report, so a production never ends without a QC record.
 * Throws on database errors; callers log them and reconcileQcReports retries later.
 */
async function evaluateQcJob(jobId: string): Promise<void> {
  const sql = db();
  const [job] = await sql`SELECT type, status, payload, result, error FROM jobs WHERE id = ${jobId}`;
  if (!job || job.type !== "qc-video" || (job.status !== "succeeded" && job.status !== "failed")) return;
  const productionId = typeof job.payload?.productionId === "string" ? (job.payload.productionId as string) : null;
  if (!productionId) return;
  const [existing] = await sql`SELECT id FROM qc_reports WHERE job_id = ${jobId} AND gate = 'G-technical'`;
  if (existing) return;
  const [p] = await sql`SELECT format, style_id, template_id FROM productions WHERE id = ${productionId}`;
  if (!p) return;
  const assetId = Array.isArray(job.payload?.inputs) && typeof job.payload.inputs[0] === "string" ? (job.payload.inputs[0] as string) : null;

  const templateId = (p.template_id as string | null) ?? `tpl-${p.style_id as string}`;
  let template: Template | null = null;
  if (job.status === "succeeded") {
    template = await getTemplate(templateId);
    if (!template) {
      await ensureSeedTemplates();
      template = await getTemplate(templateId);
    }
  }
  const { gate, measure } = technicalReportFor(job, template, p.format as Format, templateId);
  await saveQcReport({ result: gate, productionId, jobId, assetId, details: measure ? { measure } : {} });
}

/**
 * Retries QC evaluation for recent finished qc-video jobs that still have no G-technical report. This covers
 * evaluations that threw, and jobs that failed by lease expiry. Never throws.
 */
export async function reconcileQcReports(): Promise<void> {
  try {
    const rows = await db()`
      SELECT j.id FROM jobs j
      WHERE j.type = 'qc-video' AND j.status IN ('succeeded', 'failed')
        AND j.payload ? 'productionId' AND j.finished_at > now() - interval '7 days'
        AND NOT EXISTS (SELECT 1 FROM qc_reports q WHERE q.job_id = j.id AND q.gate = 'G-technical')
      ORDER BY j.finished_at LIMIT 20
    `;
    for (const r of rows) {
      try {
        await evaluateQcJob(r.id as string);
      } catch (err) {
        console.error("qc reconcile failed for job", r.id, err);
      }
    }
  } catch (err) {
    console.error("qc reconcile failed", err);
  }
}

/**
 * Called after a job completes or fails for good. Evaluates that job, then retries any earlier miss.
 * It never throws: a QC evaluation problem must not fail the worker's request.
 */
export async function evaluateQcCompletion(jobId: string): Promise<void> {
  try {
    await evaluateQcJob(jobId);
  } catch (err) {
    console.error("qc evaluation failed", jobId, err);
  }
  await reconcileQcReports();
}
