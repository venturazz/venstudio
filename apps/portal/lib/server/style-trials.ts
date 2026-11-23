import "server-only";
import { db } from "./db.ts";
import { ownerDecisionOf, parseRunStylePack, qcPartOf, type TrialGate } from "../studio/style-registry.ts";
import type { GateId } from "../studio/qc.ts";
import { readAdvisory, readRubric } from "../studio/presentation.ts";

const GATES: readonly GateId[] = ["G-script", "G-storyboard", "G-assets", "G-voice", "G-technical", "G-presentation", "G-compliance", "G-claims"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const asUuid = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v : null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const RENDERER_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** The issues of the owner's Approve anyway stored on the qc stage output (director.ts decideReview), or null. */
function waiverOf(raw: unknown): string[] | null {
  if (!isRecord(raw)) return null;
  const issues = Array.isArray(raw.issues) ? raw.issues.filter((i): i is string => typeof i === "string").map((i) => i.slice(0, 300)).slice(0, 30) : [];
  return issues;
}

/**
 * Records (or refreshes) what a Trial-pack run showed: the pack version it rendered with, the QC gates, the
 * presentation score, the finished video and the owner's final decision. Idempotent: it re-reads the run and upserts
 * one row per run, so it can be called after the quality check, after the owner's score, after Hermes's advisory and
 * again after every decision on it. Runs started without a Trial pack are left alone. A lab trial is recorded with
 * lab_trial = true (migration 0018), which keeps it out of the pack's promotion counts. The presentation score counts
 * only when it was given for the video the run has now (a re-render needs a new score). Never throws: a failed record is logged and the pipeline goes on.
 */
export async function recordTrialOutcome(runId: string): Promise<void> {
  try {
    const sql = db();
    const [run] = await sql`SELECT config FROM pipeline_runs WHERE id = ${runId}`;
    const pack = parseRunStylePack(isRecord(run?.config) ? run.config.stylePack : null);
    if (!pack || !pack.trial) return;
    const [render] = await sql`
      SELECT output FROM pipeline_stages WHERE run_id = ${runId} AND stage = 'render' AND state = 'passed' ORDER BY attempt DESC LIMIT 1
    `;
    const renderOut = isRecord(render?.output) ? render.output : {};
    const result = isRecord(renderOut.result) ? renderOut.result : {};
    const rendered = parseRunStylePack(renderOut.stylePack ?? result.stylePack);
    const version = rendered?.id === pack.id ? rendered.version : pack.version;
    const videoAssetId = asUuid(result.assetId);
    const renderer = typeof result.renderer === "string" && RENDERER_RE.test(result.renderer) ? result.renderer : (pack.engine ?? null);
    const gateRows = await sql`
      SELECT DISTINCT ON (gate) gate, passed, score FROM qc_reports
      WHERE run_id = ${runId} AND (gate <> 'G-presentation' OR asset_id = ${videoAssetId})
      ORDER BY gate, created_at DESC
    `;
    const gates: TrialGate[] = gateRows.flatMap((r) => {
      const gate = GATES.find((g) => g === r.gate);
      return gate ? [{ gate, passed: r.passed === true, score: typeof r.score === "number" ? r.score : null }] : [];
    });
    const qc = qcPartOf(gates);
    if (qc.qcPassed === null) return;
    const [pres] = videoAssetId
      ? await sql`
          SELECT details, executor FROM qc_reports WHERE run_id = ${runId} AND gate = 'G-presentation' AND asset_id = ${videoAssetId}
          ORDER BY created_at DESC LIMIT 1
        `
      : [];
    const rubric = pres && isRecord(pres.details) ? readRubric(pres.details.rubric) : null;
    const presentationBy = pres?.executor === "owner" ? "owner" : null;
    const [review] = await sql`
      SELECT state, decided_by, decided_at FROM review_items WHERE run_id = ${runId} AND stage = 'qc' AND state <> 'superseded'
      ORDER BY created_at DESC LIMIT 1
    `;
    const [qcStage] = await sql`SELECT state, output FROM pipeline_stages WHERE run_id = ${runId} AND stage = 'qc' ORDER BY attempt DESC LIMIT 1`;
    const auto = qcStage?.state === "passed" && isRecord(qcStage.output) && qcStage.output.auto === true;
    const qcOut = isRecord(qcStage?.output) ? qcStage.output : {};
    const advisory = !qcOut.assetId || qcOut.assetId === videoAssetId ? readAdvisory(qcOut.presentationAdvisory) : null;
    const decision = ownerDecisionOf(typeof review?.state === "string" ? review.state : null, auto);
    const decidedBy = asUuid(review?.decided_by);
    const decidedAt = review?.decided_at instanceof Date ? review.decided_at : null;
    // A lab trial (a Draft or Lab pack run from Styles or a study) is recorded, never counted toward promotion.
    const labTrial = pack.lab === true;
    // Approved anyway on a failed quality check (Review, decision "override"): recorded as waived, with its issues, and
    // never counted as a technical pass (migration 0022).
    const waiver = decision === "approved" ? waiverOf(qcOut.override) : null;
    await sql`
      INSERT INTO style_trial_outcomes (run_id, pack_id, pack_version, qc_passed, qc_gates, presentation_score, owner_decision, decided_by, decided_at, video_asset_id,
                                        owner_rubric, presentation_by, hermes_advisory, renderer, lab_trial, qc_waived, waived_issues)
      VALUES (${runId}, ${pack.id}, ${version}, ${qc.qcPassed}, ${JSON.stringify(gates)}::text::jsonb, ${qc.presentationScore},
              ${decision}, ${decidedBy}, ${decidedAt}, ${videoAssetId},
              ${rubric ? JSON.stringify(rubric) : null}::text::jsonb, ${presentationBy}, ${advisory ? JSON.stringify(advisory) : null}::text::jsonb, ${renderer},
              ${labTrial}, ${waiver !== null}, ${JSON.stringify(waiver ?? [])}::text::jsonb)
      ON CONFLICT (run_id) DO UPDATE SET pack_version = EXCLUDED.pack_version, qc_passed = EXCLUDED.qc_passed, qc_gates = EXCLUDED.qc_gates,
        presentation_score = EXCLUDED.presentation_score, owner_decision = EXCLUDED.owner_decision, decided_by = EXCLUDED.decided_by,
        decided_at = EXCLUDED.decided_at, video_asset_id = EXCLUDED.video_asset_id, owner_rubric = EXCLUDED.owner_rubric,
        presentation_by = EXCLUDED.presentation_by, hermes_advisory = EXCLUDED.hermes_advisory, renderer = EXCLUDED.renderer,
        lab_trial = EXCLUDED.lab_trial, qc_waived = EXCLUDED.qc_waived, waived_issues = EXCLUDED.waived_issues, updated_at = now()
    `;
  } catch (err) {
    console.error("could not record the trial outcome", runId, err);
  }
}
