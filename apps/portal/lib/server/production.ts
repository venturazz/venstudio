import "server-only";
import type { Sql, TransactionSql } from "postgres";
import { db } from "./db.ts";
import { env } from "./env.ts";
import { createJob, URGENT_PRIORITY } from "./jobs.ts";
import { evaluateQcJob } from "./pipeline.ts";
import { getTemplate } from "./templates.ts";
import { synthesize } from "./tts.ts";
import { generateImage } from "./executors/hermes-image.ts";
import { createAgentTaskJob, createFetchAssetJob, findCc0Candidate } from "./executors/library.ts";
import { ensureProvider, listProviderTerms, safeFileName, saveGeneratedAsset } from "./executors/persist.ts";
import {
  concludeStage,
  latestPassedOutput,
  loadRun,
  recordStageError,
  type RunInfo,
  type StageConclusion,
  type StageRow,
} from "./director.ts";
import { assetsGate, combineGates, PUBLISH_GATES, qcSummary, voiceGate, type GateId, type GateResult } from "../studio/qc.ts";
import { aiDisclosureRequired, type ProvenanceRecord } from "../studio/provenance.ts";
import { buildProvenance, fallbackChain, normalizeProvider, providerTermsIssues, type ProviderKind } from "../studio/asset-plan.ts";
import type { AssetKind, AssetSource } from "../studio/catalog.ts";
import { validateScript, validateStoryboard, wordsPerMinuteFor, workOrdersFromStoryboard } from "../studio/director.ts";
import type { Template } from "../studio/templates.ts";
import { buildRenderPayload } from "../studio/render.ts";
import { estimateNarrationSec } from "../studio/voice.ts";
import type { ReviewMedia } from "../studio/review.ts";
import {
  addGateIssues,
  asUuid,
  assetsSettled,
  captionLines,
  countOrders,
  failedOrdersMessage,
  HERMES_IMAGE_ATTEMPTS,
  IMAGE_EXT,
  onlyTermsIssues,
  orderStaleAction,
  parseOrderSpec,
  productionStageAction,
  renderLicenseText,
  type OrderSpec,
} from "../studio/production.ts";
import type { ProductionStage } from "../studio/engine.ts";

/**
 * Phase 4 stage drivers. Each work order is claimed on its own (FOR UPDATE SKIP LOCKED), so a crash loses at most
 * the order in hand and any caller can resume the stage. Stages are started by after() callbacks, and there is no
 * scheduler: the job complete/fail routes call onJobFinished, and reapProduction (called from the pages that
 * already reap stuck stages) repairs whatever a lost callback left behind. Nothing here writes a channel's
 * category, worker mapping or autonomy level, and nothing sets asset_providers.commercial_ok.
 */

type Q = Sql | TransactionSql;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toObject(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : "unknown error").slice(0, 300);
}

function json(v: unknown): string {
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------------------------------------------
// Work orders

interface OrderRow {
  id: string;
  shotRef: string;
  attempts: number;
  spec: OrderSpec;
}

async function claimOrder(runId: string): Promise<OrderRow | null> {
  const rows = await db()`
    UPDATE work_orders w SET state = 'running', attempts = w.attempts + 1, started_at = now(), updated_at = now(), error = NULL
    WHERE w.id = (
      SELECT o.id FROM work_orders o JOIN pipeline_runs r ON r.id = o.run_id
      WHERE o.run_id = ${runId} AND o.stage = 'assets' AND o.state = 'pending' AND r.state = 'running'
      ORDER BY o.shot_ref, o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED
    ) AND w.state = 'pending'
    RETURNING w.id, w.shot_ref, w.attempts, w.spec
  `;
  const r = rows[0];
  if (!r) return null;
  return { id: r.id as string, shotRef: (r.shot_ref as string | null) ?? "shot", attempts: r.attempts as number, spec: parseOrderSpec(r.spec) };
}

async function failOrder(orderId: string, error: string): Promise<void> {
  await db()`
    UPDATE work_orders SET state = 'failed', error = ${error.slice(0, 500)}, updated_at = now()
    WHERE id = ${orderId} AND state = 'running'
  `;
}

async function finishOrder(orderId: string, assetId: string, provider: string, result: Record<string, unknown>): Promise<void> {
  await db()`
    UPDATE work_orders SET state = 'done', asset_id = ${assetId}, provider = ${provider}, result = ${json(result)}::text::jsonb,
      error = NULL, updated_at = now()
    WHERE id = ${orderId} AND state = 'running'
  `;
}

async function waitOnJob(orderId: string, jobId: string, executor: string): Promise<void> {
  await db()`
    UPDATE work_orders SET job_id = ${jobId}, result = ${json({ waitingFor: executor })}::text::jsonb, updated_at = now()
    WHERE id = ${orderId} AND state = 'running'
  `;
}

type Produced = { kind: "done" } | { kind: "waiting" } | { kind: "failed"; reason: string };

/**
 * Makes one shot's image along the fallback chain: Hermes image_gen (which walks its own provider chain), then a
 * CC0 file fetched by a worker job, then a Muse agent task when the owner switched those on.
 */
async function produceOrder(run: RunInfo, order: OrderRow): Promise<Produced> {
  const chain = fallbackChain({ hermesConfigured: Boolean(env().HERMES_BASE_URL), museAgentTasks: env().MUSE_AGENT_TASKS === "1" });
  const reasons: string[] = [];
  const spec = order.spec;
  const ref = { workOrderId: order.id, runId: run.id, shotRef: order.shotRef, prompt: spec.prompt, channelId: run.channelId };
  for (const step of chain) {
    if (step === "hermes-image") {
      for (let attempt = 1; attempt <= HERMES_IMAGE_ATTEMPTS; attempt++) {
        const r = await generateImage({
          prompt: spec.prompt,
          beatRole: spec.beatRole,
          format: run.config.format,
          shotRef: order.shotRef,
          note: spec.note || undefined,
        });
        if (!r.ok) {
          reasons.push(`Hermes image attempt ${attempt}: ${r.error}`);
          continue;
        }
        const img = r.image;
        const saved = await saveGeneratedAsset({
          bytes: img.bytes,
          name: safeFileName(order.shotRef, IMAGE_EXT[img.info.mime] ?? "png"),
          contentType: img.info.mime,
          kind: "image",
          executor: "hermes-image",
          title: `${order.shotRef} image`,
          provider: img.provider,
          model: img.model,
          prompt: spec.prompt,
          originUrl: img.originUrl,
          runId: run.id,
          workOrderId: order.id,
          shotRef: order.shotRef,
          channelId: run.channelId,
          createdBy: null,
        });
        await finishOrder(order.id, saved.assetId, saved.provider, { executor: "hermes-image", model: img.model, hermesAsks: r.attempts, claim: order.attempts });
        return { kind: "done" };
      }
    } else if (step === "library") {
      const found = await findCc0Candidate(spec.prompt);
      if (!found.ok) {
        reasons.push(`Public-domain search: ${found.error}`);
        continue;
      }
      const queued = await createFetchAssetJob(ref, found.candidate, null);
      if (!queued.ok) {
        reasons.push(`Public-domain download: ${queued.error}`);
        continue;
      }
      await waitOnJob(order.id, queued.jobId, "fetch-asset");
      return { kind: "waiting" };
    } else {
      try {
        const jobId = await createAgentTaskJob(ref, null);
        await waitOnJob(order.id, jobId, "agent-task");
        return { kind: "waiting" };
      } catch (err) {
        reasons.push(`Muse agent task: ${errorText(err)}`);
      }
    }
  }
  return { kind: "failed", reason: reasons.join(" | ").slice(0, 480) || "No image source is configured" };
}

/** Counts work orders by state for one run. */
async function orderCounts(sql: Q, runId: string) {
  const rows = await sql`SELECT state FROM work_orders WHERE run_id = ${runId} AND stage = 'assets'`;
  return countOrders(rows.map((r) => r.state as string));
}

async function runAssetsStage(run: RunInfo): Promise<void> {
  // One pass over the pending orders. A pass is bounded so a bad run cannot loop forever; the reaper resumes it.
  for (let i = 0; i < 200; i++) {
    const order = await claimOrder(run.id);
    if (!order) break;
    try {
      const out = await produceOrder(run, order);
      if (out.kind === "failed") await failOrder(order.id, out.reason);
    } catch (err) {
      console.error("work order failed", run.id, order.shotRef, err);
      await failOrder(order.id, `Unexpected error: ${errorText(err)}`).catch(() => {});
    }
  }
  await finalizeAssets(run.id);
}

interface AssetRow {
  shotRef: string;
  provider: string;
  providerKind: ProviderKind;
  record: ProvenanceRecord;
  assetId: string;
}

async function loadAssetRows(sql: Q, runId: string): Promise<AssetRow[]> {
  const rows = await sql`
    SELECT w.shot_ref, w.provider, a.id, a.title, a.kind, a.source, a.license, a.origin_url, a.tags, a.metadata
    FROM work_orders w JOIN assets a ON a.id = w.asset_id
    WHERE w.run_id = ${runId} AND w.stage = 'assets' AND w.state = 'done'
    ORDER BY w.shot_ref
  `;
  return rows.map((r): AssetRow => {
    const meta = toObject(r.metadata);
    const kindText = text(meta.providerKind);
    const providerKind: ProviderKind = kindText === "tts" ? "tts" : kindText === "library" ? "library" : "image";
    const tags = Array.isArray(r.tags) ? (r.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];
    return {
      shotRef: (r.shot_ref as string | null) ?? "",
      provider: normalizeProvider(text(meta.provider) || ((r.provider as string | null) ?? "")),
      providerKind,
      assetId: r.id as string,
      record: {
        title: r.title as string,
        kind: r.kind as AssetKind,
        source: r.source as AssetSource,
        license: r.license as string,
        originUrl: r.origin_url as string,
        tags,
      },
    };
  });
}

/**
 * Concludes the assets stage once every order is settled. Safe to call from the stage loop, the job hook and the
 * reaper: the stage row is claimed with a timestamp flag, and concludeStage ignores a stage that is no longer running.
 */
export async function finalizeAssets(runId: string): Promise<void> {
  try {
    const sql = db();
    if (!assetsSettled(await orderCounts(sql, runId))) return;
    const claimed = await sql`
      UPDATE pipeline_stages SET output = output || jsonb_build_object('finalizingAt', extract(epoch from now()))
      WHERE id = (SELECT id FROM pipeline_stages WHERE run_id = ${runId} AND stage = 'assets' AND state = 'running' ORDER BY attempt DESC LIMIT 1)
        AND state = 'running'
        AND ((output->>'finalizingAt') IS NULL OR (output->>'finalizingAt')::float8 < extract(epoch from now()) - 300)
      RETURNING id, attempt, output
    `;
    const c = claimed[0];
    if (!c) return;
    const st: StageRow = { id: c.id as string, stage: "assets", attempt: c.attempt as number, output: toObject(c.output) };
    try {
      await concludeAssets(runId, st);
    } catch (err) {
      console.error("assets conclusion failed", runId, err);
      await recordStageError(runId, st.id, "assets", `Could not check the assets: ${errorText(err)}`);
    }
  } catch (err) {
    console.error("finalizeAssets failed", runId, err);
  }
}

async function concludeAssets(runId: string, st: StageRow): Promise<void> {
  const sql = db();
  const run = await loadRun(sql, runId);
  if (!run || run.state !== "running") return;
  const template = run.templateId ? await getTemplate(run.templateId) : null;
  if (!template) {
    await recordStageError(runId, st.id, "assets", "The run's template no longer exists");
    return;
  }
  const failed = await sql`SELECT shot_ref, error FROM work_orders WHERE run_id = ${runId} AND stage = 'assets' AND state = 'failed' ORDER BY shot_ref`;
  if (failed.length > 0) {
    const msg = failedOrdersMessage(failed.map((f) => ({ shotRef: (f.shot_ref as string | null) ?? "shot", error: text(f.error) })));
    await recordStageError(runId, st.id, "assets", msg);
    return;
  }
  const rows = await loadAssetRows(sql, runId);
  const total = (await sql`SELECT count(*)::int AS n FROM work_orders WHERE run_id = ${runId} AND stage = 'assets'`)[0]?.n as number | undefined;
  const shotCount = total ?? rows.length;
  const base = assetsGate(
    rows.map((r) => r.record),
    { use: "publish", shotCount, coveredShots: rows.length, visionFlags: [], template },
  );
  const terms = providerTermsIssues(
    rows.map((r) => ({ title: r.record.title, provider: r.provider, kind: r.providerKind })),
    await listProviderTerms(),
  );
  const gate = addGateIssues(base, terms);
  const providers = Array.from(new Set(rows.map((r) => r.provider)));
  // The storyboards forbid real people, but a disclosure is cheap: assume anything AI made may look realistic.
  const disclosure = aiDisclosureRequired({ sources: rows.map((r) => r.record.source), realisticSynthetic: true });
  const media: ReviewMedia = { images: rows.map((r) => ({ assetId: r.assetId, shotRef: r.shotRef, provider: r.provider })) };
  const result = { done: rows.length, total: shotCount, providers, aiDisclosureRequired: disclosure, termsOnly: onlyTermsIssues(gate.issues) };
  const conclusion: StageConclusion = { result, gate, media };
  await concludeStage(run, st, template, conclusion);
}

// ---------------------------------------------------------------------------------------------------------------
// Voice

async function runVoiceStage(run: RunInfo, st: StageRow, template: Template): Promise<void> {
  const sql = db();
  const scriptOut = await latestPassedOutput(sql, run.id, "script");
  const checked = validateScript(scriptOut?.result);
  if (!checked.ok) {
    await recordStageError(run.id, st.id, "voice", "The approved script is missing");
    return;
  }
  const script = checked.value.script;
  const tts = await synthesize(script, run.config.language);
  if (!tts.ok) {
    await recordStageError(run.id, st.id, "voice", tts.error);
    return;
  }
  const n = tts.narration;
  const saved = await saveGeneratedAsset({
    bytes: n.audio,
    name: safeFileName("narration", n.ext),
    contentType: n.mime,
    kind: "audio",
    executor: n.provider === "kokoro" ? "kokoro" : "hermes-capcut",
    title: `Narration (${n.provider})`,
    provider: n.provider,
    model: n.model,
    runId: run.id,
    channelId: run.channelId,
    createdBy: null,
  });
  const estimate = estimateNarrationSec(script, wordsPerMinuteFor(template));
  // Non-WAV audio cannot be measured here: the length check is deferred to the render and the plan estimate stands in.
  const narrationSec = n.durationSec ?? estimate;
  const base = voiceGate({
    languageCode: run.config.language,
    provider: n.provider,
    scriptEstimateSec: estimate,
    narrationSec,
    clipped: n.clipped === true,
  });
  const terms = providerTermsIssues([{ title: "Narration", provider: saved.provider, kind: "tts" }], await listProviderTerms());
  const gate = addGateIssues(base, terms);
  const result = {
    assetId: saved.assetId,
    provider: saved.provider,
    voice: n.voice,
    model: n.model,
    voiceVerified: n.voiceVerified,
    narrationSec,
    scriptEstimateSec: estimate,
    clipped: n.clipped,
    deferredCheck: n.deferredCheck,
    mime: n.mime,
    note: n.note,
  };
  await concludeStage(run, st, template, { result, gate, media: { audioAssetId: saved.assetId, voiceProvider: saved.provider } });
}

// ---------------------------------------------------------------------------------------------------------------
// Render

async function mergeStageOutput(stageId: string, patch: Record<string, unknown>): Promise<void> {
  await db()`UPDATE pipeline_stages SET output = output || ${json(patch)}::text::jsonb WHERE id = ${stageId} AND state = 'running'`;
}

async function jobStatus(jobId: string): Promise<string | null> {
  const [j] = await db()`SELECT status FROM jobs WHERE id = ${jobId}`;
  return j ? (j.status as string) : null;
}

/** Builds the render-video payload from the approved storyboard, the finished images and the narration, and queues it. */
async function runRenderStage(run: RunInfo, st: StageRow, template: Template): Promise<void> {
  const sql = db();
  const existing = asUuid(st.output.jobId);
  if (existing) {
    const status = await jobStatus(existing);
    if (status === "queued" || status === "running") return;
    if (status === "succeeded") {
      await completeRender(existing);
      return;
    }
  }
  const boardOut = await latestPassedOutput(sql, run.id, "storyboard");
  const board = validateStoryboard(boardOut?.result);
  const scriptOut = await latestPassedOutput(sql, run.id, "script");
  const script = validateScript(scriptOut?.result);
  const voiceOut = await latestPassedOutput(sql, run.id, "voice");
  const voiceResult = toObject(voiceOut?.result);
  if (!board.ok || !script.ok) {
    await recordStageError(run.id, st.id, "render", "The approved storyboard or script is missing");
    return;
  }
  const done = await sql`SELECT shot_ref, asset_id FROM work_orders WHERE run_id = ${run.id} AND stage = 'assets' AND state = 'done' AND asset_id IS NOT NULL`;
  const shotAssets: Record<string, string> = {};
  for (const d of done) shotAssets[(d.shot_ref as string | null) ?? ""] = d.asset_id as string;
  const plan = buildRenderPayload({
    format: run.config.format,
    shots: workOrdersFromStoryboard(board.value.shots).map((w) => ({ shotRef: w.shotRef, seconds: w.spec.seconds })),
    shotAssets,
    narrationAssetId: asUuid(voiceResult.assetId),
    narrationSec: typeof voiceResult.narrationSec === "number" ? voiceResult.narrationSec : 0,
    captions: captionLines(script.value.script),
    targetLufs: template.audio.targetLufs,
    maxShotSeconds: template.pacing.maxShotSeconds,
    runId: run.id,
  });
  if (!plan.ok) {
    await recordStageError(run.id, st.id, "render", plan.issues.join(". "));
    return;
  }
  // Phase 4 has no animatic, so the draft stage is recorded as skipped once.
  await sql`
    INSERT INTO pipeline_stages (run_id, stage, state, attempt, output, finished_at)
    SELECT ${run.id}::uuid, 'draft', 'skipped', 1, ${json({ reason: "No animatic in Phase 4" })}::text::jsonb, now()
    WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE run_id = ${run.id} AND stage = 'draft')
  `;
  const jobId = await createJob({
    type: "render-video",
    payload: { ...plan.payload },
    channelId: run.channelId,
    priority: URGENT_PRIORITY,
    createdBy: null,
  });
  await mergeStageOutput(st.id, { jobId, shots: plan.payload.shots.length, narrationSec: plan.payload.narrationSec });
}

interface FinishedJob {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string;
}

async function loadJob(jobId: string): Promise<FinishedJob | null> {
  const [j] = await db()`SELECT id, type, status, payload, result, error FROM jobs WHERE id = ${jobId}`;
  if (!j) return null;
  return {
    id: j.id as string,
    type: j.type as string,
    status: j.status as string,
    payload: toObject(j.payload),
    result: toObject(j.result),
    error: text(j.error),
  };
}

interface RunningStage {
  run: RunInfo;
  template: Template;
  st: StageRow;
}

/** The running stage of a run that waits on this job id, with the run and template it needs. Null when none does. */
async function stageWaitingOn(runId: string, stage: ProductionStage, jobId: string): Promise<RunningStage | null> {
  const sql = db();
  const [s] = await sql`
    SELECT id, attempt, output FROM pipeline_stages
    WHERE run_id = ${runId} AND stage = ${stage} AND state = 'running' AND output->>'jobId' = ${jobId}
    ORDER BY attempt DESC LIMIT 1
  `;
  if (!s) return null;
  const run = await loadRun(sql, runId);
  if (!run || run.state !== "running") return null;
  const template = run.templateId ? await getTemplate(run.templateId) : null;
  const st: StageRow = { id: s.id as string, stage, attempt: s.attempt as number, output: toObject(s.output) };
  if (!template) {
    await recordStageError(runId, st.id, stage, "The run's template no longer exists");
    return null;
  }
  return { run, template, st };
}

interface ArtifactRow {
  id: string;
  name: string;
  contentType: string;
  bytes: number;
  sha256: string;
  storagePath: string;
}

async function firstArtifact(jobId: string, namePrefix: string): Promise<ArtifactRow | null> {
  const rows = await db()`
    SELECT id, name, content_type, bytes, sha256, storage_path FROM artifacts
    WHERE job_id = ${jobId} AND name LIKE ${`${namePrefix}%`} ORDER BY created_at LIMIT 1
  `;
  const a = rows[0];
  if (!a) return null;
  return {
    id: a.id as string,
    name: a.name as string,
    contentType: a.content_type as string,
    bytes: Number(a.bytes),
    sha256: a.sha256 as string,
    storagePath: a.storage_path as string,
  };
}

/**
 * Makes a worker artifact visible as an asset without copying the bytes. Idempotent per artifact.
 * Provenance fields are decided by the caller (code that knows which job made the file), never by the worker.
 */
async function assetFromArtifact(input: {
  artifact: ArtifactRow;
  title: string;
  kind: AssetKind;
  source: AssetSource;
  license: string;
  originUrl: string;
  channelId: string | null;
  metadata: Record<string, unknown>;
}): Promise<string> {
  const sql = db();
  const [existing] = await sql`SELECT id FROM assets WHERE metadata->>'artifactId' = ${input.artifact.id}`;
  if (existing) return existing.id as string;
  const meta = { ...input.metadata, artifactId: input.artifact.id };
  const [row] = await sql`
    INSERT INTO assets (title, kind, source, license, origin_url, tags, channel_id, content_type, bytes, sha256, storage_path, metadata, created_by)
    VALUES (${input.title.slice(0, 200)}, ${input.kind}, ${input.source}, ${input.license}, ${input.originUrl}, '{}'::text[], ${input.channelId},
            ${input.artifact.contentType}, ${input.artifact.bytes}, ${input.artifact.sha256}, ${input.artifact.storagePath},
            ${json(meta)}::text::jsonb, ${null})
    RETURNING id
  `;
  return row.id as string;
}

/** Registers the finished render as a video asset, then concludes the render stage. Returns false when nothing was waiting. */
async function completeRender(jobId: string): Promise<boolean> {
  const job = await loadJob(jobId);
  if (!job || job.type !== "render-video") return false;
  const runId = asUuid(job.payload.runId);
  if (!runId) return false;
  const waiting = await stageWaitingOn(runId, "render", jobId);
  if (!waiting) return false;
  const { run, template, st } = waiting;
  if (job.status !== "succeeded") {
    await recordStageError(runId, st.id, "render", `The video render failed: ${job.error || "the worker gave no reason"}`);
    return true;
  }
  const artifact = await firstArtifact(jobId, "video.");
  if (!artifact) {
    await recordStageError(runId, st.id, "render", "The render finished but no video file came back");
    return true;
  }
  const inputIds = Array.isArray(job.payload.inputs) ? job.payload.inputs.map(asUuid).filter((x): x is string => x !== null) : [];
  const inputs = await db()`SELECT title, license, metadata FROM assets WHERE id = ANY(${inputIds}::uuid[]) ORDER BY created_at`;
  const license = renderLicenseText(
    inputs.map((a) => ({ title: a.title as string, provider: text(toObject(a.metadata).provider), license: a.license as string })),
  );
  const assetId = await assetFromArtifact({
    artifact,
    title: `${run.topic || "Video"} (render)`,
    kind: "video",
    source: "worker",
    license,
    originUrl: "",
    channelId: run.channelId,
    metadata: { runId, jobId, inputAssetIds: inputIds, executor: "render-video" },
  });
  const r = job.result;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const result = {
    assetId,
    jobId,
    durationSec: num(r.durationSec),
    width: num(r.width),
    height: num(r.height),
    narrationClipped: r.narrationClipped === true,
    captionsBurned: r.captionsBurned === true,
    captionNote: text(r.captionNote),
  };
  await concludeStage(run, st, template, { result, gate: null, extra: { jobId }, media: { videoAssetId: assetId } });
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Quality check

async function runQcStage(run: RunInfo, st: StageRow): Promise<void> {
  const existing = asUuid(st.output.jobId);
  if (existing) {
    const status = await jobStatus(existing);
    if (status === "queued" || status === "running") return;
    if (status === "succeeded" || status === "failed") {
      await completeQc(existing);
      return;
    }
  }
  const renderOut = await latestPassedOutput(db(), run.id, "render");
  const assetId = asUuid(toObject(renderOut?.result).assetId);
  if (!assetId) {
    await recordStageError(run.id, st.id, "qc", "There is no rendered video to check");
    return;
  }
  const jobId = await createJob({
    type: "qc-video",
    payload: { inputs: [assetId], runId: run.id },
    channelId: run.channelId,
    priority: URGENT_PRIORITY,
    createdBy: null,
  });
  await mergeStageOutput(st.id, { jobId, assetId });
}

const RUN_GATES: readonly GateId[] = ["G-assets", "G-voice", "G-technical"];

/** The newest stored result of each Phase 4 gate for a run. Rows are mapped into typed objects here. */
async function latestRunGates(sql: Q, runId: string): Promise<GateResult[]> {
  const rows = await sql`
    SELECT DISTINCT ON (gate) gate, passed, score, details, executor FROM qc_reports
    WHERE run_id = ${runId} AND gate IN ('G-assets', 'G-voice', 'G-technical')
    ORDER BY gate, created_at DESC
  `;
  const out: GateResult[] = [];
  for (const r of rows) {
    const gate = RUN_GATES.find((g) => g === r.gate);
    if (!gate) continue;
    const details = toObject(r.details);
    const issues = Array.isArray(details.issues) ? details.issues.filter((i): i is string => typeof i === "string") : [];
    const g: GateResult = { gate, passed: r.passed === true, issues, executor: text(r.executor) };
    if (typeof r.score === "number") g.score = r.score;
    out.push(g);
  }
  return out;
}

/** Stores G-technical for the run, then asks the autonomy policy for the final decision on the finished video. */
async function completeQc(jobId: string): Promise<boolean> {
  const job = await loadJob(jobId);
  if (!job || job.type !== "qc-video") return false;
  const runId = asUuid(job.payload.runId);
  if (!runId) return false;
  const waiting = await stageWaitingOn(runId, "qc", jobId);
  if (!waiting) return false;
  const { run, template, st } = waiting;
  if (job.status !== "succeeded" && job.status !== "failed") return false;
  if (job.status === "failed") {
    await recordStageError(runId, st.id, "qc", `The quality check could not run: ${job.error || "the worker gave no reason"}`);
    return true;
  }
  try {
    await evaluateQcJob(jobId);
  } catch (err) {
    console.error("qc evaluation failed", jobId, err);
    await recordStageError(runId, st.id, "qc", `The quality check result could not be saved: ${errorText(err)}`);
    return true;
  }
  const gates = await latestRunGates(db(), runId);
  const qc = combineGates(gates, template, PUBLISH_GATES);
  const issues = gates.filter((g) => !g.passed).flatMap((g) => g.issues);
  const renderOut = await latestPassedOutput(db(), runId, "render");
  const videoAssetId = asUuid(toObject(renderOut?.result).assetId);
  await concludeStage(run, st, template, {
    result: { jobId, gates: gates.map((g) => ({ gate: g.gate, passed: g.passed, score: g.score ?? null })), missingGates: qc.missingGates },
    gate: null,
    extra: { jobId },
    qc,
    issues,
    checks: qcSummary(gates),
    media: videoAssetId ? { videoAssetId } : undefined,
    final: true,
  });
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Entry points used by the engine

/** Runs one claimed production stage. Render and qc only start their job and leave the stage running. */
export async function runProductionStage(run: RunInfo, st: StageRow, template: Template): Promise<void> {
  if (st.stage === "assets") return runAssetsStage(run);
  if (st.stage === "voice") return runVoiceStage(run, st, template);
  if (st.stage === "render") return runRenderStage(run, st, template);
  if (st.stage === "qc") return runQcStage(run, st);
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs finishing

/** Settles the work order that waits on a finished fetch-asset or agent-task job. */
async function settleOrderJob(job: FinishedJob): Promise<string | null> {
  const orderId = asUuid(job.payload.workOrderId);
  const runId = asUuid(job.payload.runId);
  if (!orderId || !runId) return null;
  const sql = db();
  const [o] = await sql`SELECT id, state, shot_ref FROM work_orders WHERE id = ${orderId} AND job_id = ${job.id}`;
  if (!o || o.state !== "running") return runId;
  const isAgent = job.type === "agent-task";
  const label = isAgent ? "The Muse agent task" : "The public-domain download";
  if (job.status !== "succeeded") {
    await failOrder(orderId, `${label} ${job.status === "cancelled" ? "was cancelled" : "failed"}: ${job.error || "the worker gave no reason"}`);
    return runId;
  }
  const artifact = await firstArtifact(job.id, isAgent ? "agent-" : "asset.");
  if (!artifact) {
    await failOrder(orderId, `${label} finished but no file came back`);
    return runId;
  }
  const run = await loadRun(sql, runId);
  const shotRef = (o.shot_ref as string | null) ?? "shot";
  const kind: AssetKind = job.payload.kind === "audio" ? "audio" : "image";
  let assetId: string;
  let provider: string;
  if (isAgent) {
    const built = buildProvenance({
      executor: "worker-fetch",
      title: `${shotRef} image`,
      kind,
      provider: "muse-agent",
      licence: "Made by the agent on a Muse machine. Delivery is unverified, so the owner confirms the terms in Settings.",
      shotRef,
    });
    assetId = await assetFromArtifact({
      artifact,
      title: built.record.title,
      kind,
      source: "muse",
      license: built.record.license,
      originUrl: "",
      channelId: run?.channelId ?? null,
      metadata: { ...built.metadata, runId, workOrderId: orderId, jobId: job.id },
    });
    await ensureProvider(built.provider, built.providerKind);
    provider = built.provider;
  } else {
    const url = text(job.payload.url);
    let host = "cc0-library";
    try {
      host = new URL(url).hostname;
    } catch {
      // The portal checked the URL before queueing; keep the generic name if it cannot be read back.
    }
    const built = buildProvenance({
      executor: "worker-fetch",
      title: text(job.payload.title) || `${shotRef} image`,
      kind,
      provider: host,
      originUrl: url,
      licence: text(job.payload.licence),
      shotRef,
    });
    assetId = await assetFromArtifact({
      artifact,
      title: built.record.title,
      kind,
      source: built.record.source,
      license: built.record.license,
      originUrl: built.record.originUrl,
      channelId: run?.channelId ?? null,
      metadata: { ...built.metadata, runId, workOrderId: orderId, jobId: job.id, licenceUrl: text(job.payload.licenceUrl) },
    });
    await ensureProvider(built.provider, built.providerKind);
    provider = built.provider;
  }
  await finishOrder(orderId, assetId, provider, { executor: isAgent ? "muse-agent" : "worker-fetch", jobId: job.id });
  return runId;
}

/**
 * Called from the job complete and fail routes after the job row is final. Advances whatever waited on the job.
 * Returns the run id to continue with advanceRun (the caller schedules it), or null. Never throws.
 */
export async function onJobFinished(jobId: string): Promise<string | null> {
  try {
    const job = await loadJob(jobId);
    if (!job || (job.status !== "succeeded" && job.status !== "failed" && job.status !== "cancelled")) return null;
    const runId = asUuid(job.payload.runId);
    if (!runId) return null;
    if (job.type === "fetch-asset" || job.type === "agent-task") {
      const settled = await settleOrderJob(job);
      if (!settled) return null;
      await finalizeAssets(settled);
      return settled;
    }
    if (job.type === "render-video") return (await completeRender(jobId)) ? runId : null;
    if (job.type === "qc-video") return (await completeQc(jobId)) ? runId : null;
    return null;
  } catch (err) {
    console.error("production hook failed", jobId, err);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Owner decisions and cancellation (called inside the caller's transaction)

/** Cancels pending and running work orders of a run and the queued or running jobs it started. Idempotent. */
export async function cancelRunWork(tx: Q, runId: string): Promise<void> {
  await tx`UPDATE work_orders SET state = 'cancelled', updated_at = now() WHERE run_id = ${runId} AND state IN ('pending', 'running')`;
  await tx`
    UPDATE jobs SET
      cancel_requested = true,
      status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
      finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END
    WHERE status IN ('queued', 'running') AND payload->>'runId' = ${runId}
  `;
}

/** Retry: only the failed orders run again. Finished shots are kept. */
export async function resetFailedOrders(tx: Q, runId: string): Promise<void> {
  await tx`
    UPDATE work_orders SET state = 'pending', attempts = 0, error = NULL, job_id = NULL, result = NULL, updated_at = now()
    WHERE run_id = ${runId} AND stage = 'assets' AND state = 'failed'
  `;
}

/** Revise: every order runs again and the owner's note travels in the spec as data for the image prompt. */
export async function resetOrdersForRevision(tx: Q, runId: string, note: string): Promise<void> {
  await tx`
    UPDATE work_orders SET state = 'pending', attempts = 0, error = NULL, job_id = NULL, asset_id = NULL, provider = NULL, result = NULL,
      spec = spec || jsonb_build_object('note', ${note.slice(0, 1000)}::text), updated_at = now()
    WHERE run_id = ${runId} AND stage = 'assets' AND state IN ('pending', 'running', 'done', 'failed')
  `;
}

// ---------------------------------------------------------------------------------------------------------------
// Recovery

/**
 * Repairs production work a lost callback or a restart left behind: requeues work orders that stopped answering,
 * settles orders and stages whose job already finished, and fails stages whose job failed for good into a
 * stage-error review. Each repair is idempotent and guarded by the state it expects. Returns the run ids touched.
 * Never throws.
 */
export async function reapProduction(): Promise<string[]> {
  const touched = new Set<string>();
  try {
    await reapOrders(touched);
  } catch (err) {
    console.error("reap work orders failed", err);
  }
  try {
    await reapStages(touched);
  } catch (err) {
    console.error("reap production stages failed", err);
  }
  return Array.from(touched);
}

async function reapOrders(touched: Set<string>): Promise<void> {
  const sql = db();
  const rows = await sql`
    SELECT w.id, w.run_id, w.attempts, w.job_id, (extract(epoch from (now() - w.updated_at)) / 60)::float8 AS idle
    FROM work_orders w JOIN pipeline_runs r ON r.id = w.run_id
    WHERE w.state = 'running' AND r.state = 'running'
  `;
  for (const w of rows) {
    try {
      const runId = w.run_id as string;
      const jobId = (w.job_id as string | null) ?? null;
      if (jobId) {
        const job = await loadJob(jobId);
        if (job && (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled")) {
          await settleOrderJob(job);
          touched.add(runId);
        }
        continue;
      }
      const action = orderStaleAction({ state: "running", attempts: w.attempts as number, hasJob: false, idleMinutes: Number(w.idle) });
      if (action === "requeue") {
        await sql`
          UPDATE work_orders SET state = 'pending', error = 'Restarted after the step stopped answering', updated_at = now()
          WHERE id = ${w.id as string} AND state = 'running' AND job_id IS NULL
        `;
        touched.add(runId);
      } else if (action === "fail") {
        await failOrder(w.id as string, "This shot stopped answering several times in a row");
        touched.add(runId);
      }
    } catch (err) {
      console.error("reap work order failed", w.id, err);
    }
  }
}

async function reapStages(touched: Set<string>): Promise<void> {
  const sql = db();
  const rows = await sql`
    SELECT s.id, s.run_id, s.stage, s.output,
           (extract(epoch from (now() - COALESCE(GREATEST(s.started_at, act.last_at), s.started_at, now()))) / 60)::float8 AS idle
    FROM pipeline_stages s
    JOIN pipeline_runs r ON r.id = s.run_id
    LEFT JOIN LATERAL (SELECT max(w.updated_at) AS last_at FROM work_orders w WHERE w.run_id = s.run_id AND s.stage = 'assets') act ON true
    WHERE s.state = 'running' AND r.state = 'running' AND s.stage IN ('assets', 'voice', 'render', 'qc')
  `;
  for (const s of rows) {
    try {
      const runId = s.run_id as string;
      const stage = s.stage as ProductionStage;
      const jobId = asUuid(toObject(s.output).jobId);
      const job = jobId ? await loadJob(jobId) : null;
      const orders = stage === "assets" ? await orderCounts(sql, runId) : undefined;
      const act = productionStageAction({ stage, idleMinutes: Number(s.idle), jobStatus: job ? job.status : null, jobError: job?.error ?? null, orders });
      if (act.action === "none") continue;
      touched.add(runId);
      if (act.action === "finalize") await finalizeAssets(runId);
      else if (act.action === "resume") {
        await sql`
          UPDATE pipeline_stages SET state = 'pending', output = output - 'finalizingAt', started_at = NULL
          WHERE id = ${s.id as string} AND state = 'running'
        `;
      } else if (act.action === "complete" && jobId) {
        if (stage === "render") await completeRender(jobId);
        else if (stage === "qc") await completeQc(jobId);
      } else if (act.action === "fail") {
        await recordStageError(runId, s.id as string, stage, act.reason);
      }
    } catch (err) {
      console.error("reap production stage failed", s.id, err);
    }
  }
}
