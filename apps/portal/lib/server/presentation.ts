import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { db } from "./db.ts";
import { env } from "./env.ts";
import { audit } from "./audit.ts";
import { saveQcReport } from "./qc.ts";
import { hermesJson } from "./hermes-json.ts";
import { packContract } from "./style-packs.ts";
import { recordTrialOutcome } from "./style-trials.ts";
import {
  ADVISORY_FRAMES,
  advisoryMessages,
  ownerPresentationGate,
  parseAdvisory,
  presentationRefusal,
  readAdvisory,
  readRubric,
  type PresentationAdvisory,
  type Rubric,
} from "../studio/presentation.ts";
import { parseRunStylePack } from "../studio/style-registry.ts";

/**
 * The presentation score of a final video (G-presentation): the owner's rating from the Review card, and Hermes's
 * advisory. The rule and the mapping are in lib/studio/presentation.ts; this file stores and reads them.
 *
 * The owner's score is a qc_reports row (gate G-presentation, executor "owner", the video's asset id, the rubric in
 * details), so the run's gates, the Review card and the curation log (style-trials.ts) read it like any gate. It
 * counts only for the video it was given for. Hermes's advisory is stored on the qc stage output and copied to the
 * curation log; it never writes a gate and never decides anything.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asUuid = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v : null);

export interface OwnerPresentation {
  score: number;
  passed: boolean;
  rubric: Rubric | null;
  by: "owner" | null;
}

/** The newest G-presentation for this run's video, or null. */
export async function presentationFor(runId: string, videoAssetId: string | null): Promise<OwnerPresentation | null> {
  if (!asUuid(videoAssetId)) return null;
  const [r] = await db()`
    SELECT score, passed, details, executor FROM qc_reports
    WHERE run_id = ${runId} AND gate = 'G-presentation' AND asset_id = ${videoAssetId}
    ORDER BY created_at DESC LIMIT 1
  `;
  if (!r || typeof r.score !== "number") return null;
  return { score: r.score, passed: r.passed === true, rubric: isRecord(r.details) ? readRubric(r.details.rubric) : null, by: r.executor === "owner" ? "owner" : null };
}

/** Hermes's advisory on the run's newest quality check, when it is about this video. */
export async function advisoryFor(runId: string, videoAssetId: string | null): Promise<PresentationAdvisory | null> {
  const [st] = await db()`SELECT output FROM pipeline_stages WHERE run_id = ${runId} AND stage = 'qc' ORDER BY attempt DESC LIMIT 1`;
  const out = isRecord(st?.output) ? st.output : {};
  if (out.assetId && out.assetId !== videoAssetId) return null;
  return readAdvisory(out.presentationAdvisory);
}

interface ReviewTarget {
  runId: string;
  videoAssetId: string | null;
  trial: boolean;
}

async function qcReviewTarget(reviewId: string): Promise<ReviewTarget | { error: string }> {
  const [rv] = await db()`
    SELECT ri.run_id, ri.stage, ri.state, ri.payload, r.config FROM review_items ri JOIN pipeline_runs r ON r.id = ri.run_id WHERE ri.id = ${reviewId}
  `;
  if (!rv) return { error: "Unknown review item" };
  if (rv.stage !== "qc") return { error: "Only the final video is scored" };
  if (rv.state !== "open") return { error: "This item was already decided" };
  const payload = isRecord(rv.payload) ? rv.payload : {};
  const media = isRecord(payload.media) ? payload.media : {};
  const pack = parseRunStylePack(isRecord(rv.config) ? rv.config.stylePack : null);
  return { runId: String(rv.run_id), videoAssetId: asUuid(media.videoAssetId), trial: pack?.trial === true };
}

/**
 * Saves the owner's rating of the video on an open qc card as the run's G-presentation. Owner only (the action checks
 * the role, and this checks it again). Can be changed until the card is decided.
 */
export async function scorePresentation(input: { reviewId: string; rubric: Rubric; userId: string; isOwner: boolean }): Promise<
  { ok: true; runId: string; score: number; passed: boolean } | { ok: false; error: string }
> {
  if (!input.isOwner) return { ok: false, error: "Only the owner scores a video" };
  try {
    const t = await qcReviewTarget(input.reviewId);
    if ("error" in t) return { ok: false, error: t.error };
    if (!t.videoAssetId) return { ok: false, error: "This card has no video to score" };
    const gate = ownerPresentationGate(input.rubric);
    await saveQcReport({ result: gate, runId: t.runId, assetId: t.videoAssetId, details: { stage: "qc", rubric: input.rubric, by: input.userId } });
    await recordTrialOutcome(t.runId);
    try {
      await audit({ userId: input.userId, action: "review.presentation", target: t.runId, detail: { reviewId: input.reviewId, score: gate.score, rubric: input.rubric } });
    } catch (err) {
      console.error("audit failed", "review.presentation", err);
    }
    return { ok: true, runId: t.runId, score: gate.score ?? 0, passed: gate.passed };
  } catch (err) {
    console.error("scorePresentation failed", err);
    return { ok: false, error: "The score could not be saved" };
  }
}

/** Why a decision on this qc card must wait for the owner's score (trial runs), or null. */
export async function scoreRefusal(reviewId: string, decision: string): Promise<string | null> {
  const t = await qcReviewTarget(reviewId);
  if ("error" in t) return null;
  // A card with no video has nothing to score: a trial cannot be approved from it, but can still be rejected or retried.
  if (!t.videoAssetId) return presentationRefusal({ stage: "qc", trial: t.trial, decision, scored: false, hasVideo: false });
  const scored = (await presentationFor(t.runId, t.videoAssetId)) !== null;
  return presentationRefusal({ stage: "qc", trial: t.trial, decision, scored, hasVideo: true });
}

/** How many stills the quality check samples for the advisory: only when Hermes is set up. */
export function advisoryFrameCount(): number {
  return env().HERMES_BASE_URL ? ADVISORY_FRAMES : 0;
}

/**
 * Asks Hermes for its advisory rating of a finished quality check's sampled stills (worker 0.10.0+ uploads them as
 * frame-NN.jpg), against the run's pack contract. Stored on the qc stage output and in the curation log. Advisory
 * only: nothing waits for it, and a failure is logged and leaves no trace on the run. Never throws.
 */
export async function runPresentationAdvisory(runId: string, jobId: string): Promise<void> {
  try {
    if (!env().HERMES_BASE_URL) return;
    const sql = db();
    const [job] = await sql`SELECT result FROM jobs WHERE id = ${jobId}`;
    const result = isRecord(job?.result) ? job.result : {};
    const sampled = Array.isArray(result.sampledFrames) ? result.sampledFrames.filter(isRecord) : [];
    if (sampled.length === 0) return;
    const rows = await sql`SELECT name, storage_path, bytes FROM artifacts WHERE job_id = ${jobId} AND name LIKE 'frame-%' ORDER BY name LIMIT 12`;
    const images: string[] = [];
    const frames: Array<{ atSec: number }> = [];
    for (const r of rows) {
      const name = String(r.name);
      const at = sampled.find((s) => s.name === name);
      if (!at || typeof at.atSec !== "number" || Number(r.bytes) > 2 * 1024 * 1024) continue;
      // Only files under the artifact root, as openStored allows.
      const file = path.resolve(/*turbopackIgnore: true*/ String(r.storage_path));
      if (!file.startsWith(path.resolve(/*turbopackIgnore: true*/ env().ARTIFACT_DIR) + path.sep)) continue;
      const bytes = await readFile(file);
      images.push(`data:image/jpeg;base64,${bytes.toString("base64")}`);
      frames.push({ atSec: at.atSec });
    }
    if (images.length === 0) return;
    const [run] = await sql`SELECT topic, config FROM pipeline_runs WHERE id = ${runId}`;
    const config = isRecord(run?.config) ? run.config : {};
    const pack = parseRunStylePack(config.stylePack);
    const contract = pack ? await packContract(pack.id) : null;
    const answer = await hermesJson(
      advisoryMessages({
        topic: typeof run?.topic === "string" ? run.topic : "",
        format: typeof config.format === "string" ? config.format : "short",
        durationSec: typeof result.durationSec === "number" ? result.durationSec : null,
        packId: pack?.id ?? null,
        contract,
        frames,
      }),
      parseAdvisory,
      { retries: 1, timeoutMs: 120_000, queueTimeoutMs: 60_000, images },
    );
    if (!answer.ok) {
      console.warn(`presentation advisory for run ${runId} skipped: ${answer.error}`);
      return;
    }
    const advisory: PresentationAdvisory = { ...answer.value, frames: images.length, at: new Date().toISOString() };
    await sql`
      UPDATE pipeline_stages SET output = output || ${JSON.stringify({ presentationAdvisory: advisory })}::text::jsonb
      WHERE run_id = ${runId} AND stage = 'qc' AND output->>'jobId' = ${jobId}
    `;
    await recordTrialOutcome(runId);
  } catch (err) {
    console.error("presentation advisory failed", runId, err);
  }
}
