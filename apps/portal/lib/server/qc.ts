import "server-only";
import { db } from "./db.ts";
import type { GateResult } from "../studio/qc.ts";

/** Idempotent per (job, gate): a second write for the same job, such as a retried job, replaces the first. */
export async function saveQcReport(input: {
  result: GateResult;
  productionId?: string | null;
  jobId?: string | null;
  assetId?: string | null;
  runId?: string | null;
  details?: Record<string, unknown>;
}): Promise<string> {
  const r = input.result;
  const [row] = await db()`
    INSERT INTO qc_reports (run_id, production_id, job_id, asset_id, gate, passed, score, details, executor)
    VALUES (${input.runId ?? null}, ${input.productionId ?? null}, ${input.jobId ?? null}, ${input.assetId ?? null},
            ${r.gate}, ${r.passed}, ${r.score === undefined ? null : Math.round(r.score)},
            ${JSON.stringify({ issues: r.issues, ...(r.notes && r.notes.length > 0 ? { notes: r.notes } : {}), ...(input.details ?? {}) })}::text::jsonb, ${r.executor})
    ON CONFLICT (job_id, gate) WHERE job_id IS NOT NULL DO UPDATE SET
      run_id = EXCLUDED.run_id, production_id = EXCLUDED.production_id, asset_id = EXCLUDED.asset_id,
      passed = EXCLUDED.passed, score = EXCLUDED.score, details = EXCLUDED.details, executor = EXCLUDED.executor,
      created_at = now()
    RETURNING id
  `;
  return row.id as string;
}

/** The newest report per gate for a production. */
export async function latestQc(productionId: string) {
  const rows = await db()`
    SELECT DISTINCT ON (gate) id, gate, passed, score, details, executor, created_at
    FROM qc_reports WHERE production_id = ${productionId}
    ORDER BY gate, created_at DESC
  `;
  return rows as unknown as Array<{
    id: string;
    gate: string;
    passed: boolean;
    score: number | null;
    details: { issues?: string[] };
    executor: string;
    created_at: Date;
  }>;
}
