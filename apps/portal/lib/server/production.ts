import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { db } from "./db.ts";
import { env } from "./env.ts";
import { MUSE_POLL_SEC, isMuseThinkStage, renderExecutor, renderRoute } from "../studio/muse-stage.ts";
import { frozenRender } from "../studio/freeze.ts";
import { museRenderReadiness, pollMuseRender, startMuseRender } from "./muse-stages.ts";
import { createJob, URGENT_PRIORITY } from "./jobs.ts";
import { evaluateQcJob } from "./pipeline.ts";
import { getTemplate } from "./templates.ts";
import { synthesize, workerNarration, type SynthesisResult } from "./tts.ts";
import { pollTtsJob, startTtsJob, ttsWorkerAvailable } from "./tts-worker.ts";
import { TTS_POLL_SEC } from "../studio/tts-worker.ts";
import { hermesJson } from "./hermes-json.ts";
import { paceForRun, recordSpeechSample } from "./speech-rate.ts";
import { generateImage } from "./executors/hermes-image.ts";
import { generateRouterImage, routerImageModel } from "./executors/router-image.ts";
import { getCapabilities } from "./capabilities.ts";
import { missingCapabilityMessage, scanStateOf } from "../studio/capabilities.ts";
import { createAgentTaskJob, createFetchAssetJob, findCc0Candidate, type AgentTaskExtras } from "./executors/library.ts";
import { contractMarkdown, pictureFallbackContext, planMarkdown } from "../studio/muse-task.ts";
import { ensureProvider, listProviderTerms, safeFileName, saveGeneratedAsset } from "./executors/persist.ts";
import {
  concludeStage,
  deferRenderPoll,
  deferStage,
  latestPassedOutput,
  loadRun,
  recordStageError,
  slowStreakOf,
  type RunInfo,
  type StageConclusion,
  type StageRow,
} from "./director.ts";
import { durationText, giveUpMessage, hermesTimeoutScale, looksRateLimited, orderFailureCause, pauseMessage, slowBackoffMs, systemicPause, waitExpired, type FailureClass } from "../studio/pacing.ts";
import { assetsGate, combineGates, qcSummary, voiceAssessment, type GateId, type GateResult } from "../studio/qc.ts";
import { aiDisclosureRequired, type ProvenanceRecord } from "../studio/provenance.ts";
import { buildProvenance, claimedLicence, fallbackChain, normalizeProvider, providerTermsIssues, type ProviderKind, type ProviderTerms } from "../studio/asset-plan.ts";
import { providerRowsUsed } from "../studio/terms-review.ts";
import type { AssetKind, AssetSource } from "../studio/catalog.ts";
import {
  fitTargetWords,
  scriptFitPrompt,
  validateFittedScript,
  validateScript,
  validateStoryboard,
  workOrdersFromStoryboard,
  type ScriptOutput,
  type Shot,
} from "../studio/director.ts";
import { countWords, type Pace } from "../studio/speech-rate.ts";
import { fitWindow, parseTightenRequest, tempoOf, tightenRequest, type LengthDirection, type TightenRequest } from "../studio/voice-fit.ts";
import type { Template } from "../studio/templates.ts";
import { buildRenderPayload, type RenderPlan } from "../studio/render.ts";
import { buildAudioPlan } from "../studio/audio-plan.ts";
import { DEFAULT_SOUND, pairCues, sfxCues, type BedChoice, type SfxAsset } from "../studio/sound.ts";
import { recordNeeds } from "./asset-needs.ts";
import { captionSpecFor } from "../studio/caption-spec.ts";
import { STYLE_BY_ID, VIDEO_FORMATS, type Style } from "../studio/catalog.ts";
import { DEFAULT_RENDER_ENGINE, isPortalEngine, transitionForWorker } from "../studio/render-engine.ts";
import { gateCapabilities, mixFeaturesFor, packWaitNote, renderJobCapability, renderStageError, tempoReadyFor, tempoWorkerMessage, withFadeFallback } from "../studio/render-gate.ts";
import { runStylePack, type RunStylePack } from "../studio/style-registry.ts";
import { packContract, registryEntry } from "./style-packs.ts";
import { askRenderCheck, askRenderStart, checkRenderBytes, downloadRender, probeRender, renderFileBase, renderMaker, type HermesRender } from "./executors/hermes-render.ts";
import {
  RENDER_VOICE_ASKS,
  applyCheckReply,
  applyStartReply,
  newRenderJob,
  readRenderJob,
  renderBudgetMinutes,
  renderClock,
  renderFetchFailed,
  renderFileName,
  renderingWait,
  renderPollEveryMs,
  renderPollStep,
  type RenderJob,
  type RenderReply,
} from "../studio/hermes-render-job.ts";
import { hermesTrustedOrigins } from "./executors/hermes-image.ts";
import { mediaHostUrl } from "../studio/hermes-render.ts";
import { HERMES_MUX_CAPABILITY, HERMES_MUX_ENGINE, hermesMuxPayload, muxNote, muxWorkerIssue, readMuxPlan } from "../studio/hermes-mux.ts";
import { advisoryFrameCount, runPresentationAdvisory } from "./presentation.ts";
import { recordTrialOutcome } from "./style-trials.ts";
import { bedNote, MUSIC_TAG, pickMusicBed, type BedCandidate, type BedPick } from "../studio/music-bed.ts";
import { buildScenePlan, renderParamsForStyle } from "../studio/scene-plan.ts";
import { estimateNarrationSec } from "../studio/voice.ts";
import { tightenLabel, type ReviewMedia, type ReviewPayload } from "../studio/review.ts";
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
  type RenderLicenseInput,
  type OrderSpec,
} from "../studio/production.ts";
import type { ProductionStage } from "../studio/engine.ts";
import { finalGatesFor, runRecipeOf, runStagesOf } from "../studio/recipes.ts";
import { readSceneSpec, sceneSpecShots } from "../studio/scene-spec.ts";
import { readSkillBrief, skillBriefShots, type SkillBrief } from "../studio/skill-brief.ts";
import { ensureRunPlate } from "./plate.ts";
import { ensureRunPage } from "./html-page.ts";
import { htmlDesignLines, htmlDesignShots, readHtmlDesign, type HtmlDesign } from "../studio/html-design.ts";
import { sceneSpecLines } from "../studio/scene-spec.ts";
import {
  HTML_DESIGN_NEEDS_PREVIEW,
  NO_PREVIEW_CONTINUE,
  NO_PREVIEW_WORKER,
  PREVIEW_NARRATION_PLACEHOLDER,
  parsePreviewResult,
  previewNote,
  previewNotes,
  previewPayload,
  previewTimes,
  previewWorkers,
  sceneStartsOf as payloadSceneStarts,
} from "../studio/frame-preview.ts";


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
  // Wait marks whose time has passed are stale once the stage runs again.
  await db()`
    UPDATE work_orders SET not_before = NULL, wait_reason = NULL
    WHERE run_id = ${runId} AND stage = 'assets' AND state = 'pending' AND not_before IS NOT NULL AND not_before <= now()
  `;
  const rows = await db()`
    UPDATE work_orders w SET state = 'running', attempts = w.attempts + 1, started_at = now(), updated_at = now(), error = NULL,
      not_before = NULL, wait_reason = NULL
    WHERE w.id = (
      SELECT o.id FROM work_orders o JOIN pipeline_runs r ON r.id = o.run_id
      WHERE o.run_id = ${runId} AND o.stage = 'assets' AND o.state = 'pending' AND r.state = 'running'
        AND (o.not_before IS NULL OR o.not_before <= now())
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

type Produced =
  | { kind: "done" }
  | { kind: "waiting" }
  /** Hermes is rate limited. Not a failure: the order goes back to pending and keeps its attempt budget. */
  | { kind: "busy"; until: Date; text: string }
  | { kind: "failed"; reason: string; cause: FailureClass };

/**
 * Puts a claimed order back to pending without spending an attempt, and marks every pending order of the run with
 * the same not-before time and status, so the run page shows why nothing moves.
 */
async function returnOrderBusy(runId: string, orderId: string, until: Date, text: string): Promise<void> {
  const sql = db();
  await sql`
    UPDATE work_orders SET state = 'pending', attempts = GREATEST(attempts - 1, 0), not_before = ${until}, wait_reason = ${text.slice(0, 300)},
      error = NULL, updated_at = now()
    WHERE id = ${orderId} AND state = 'running' AND job_id IS NULL
  `;
  await sql`
    UPDATE work_orders SET not_before = ${until}, wait_reason = ${text.slice(0, 300)}
    WHERE run_id = ${runId} AND stage = 'assets' AND state = 'pending'
  `;
}

/** A paused order goes back to pending with the attempt it used returned, so Retry starts it fresh. */
async function returnOrderPaused(orderId: string): Promise<void> {
  await db()`
    UPDATE work_orders SET state = 'pending', attempts = GREATEST(attempts - 1, 0), error = NULL, updated_at = now()
    WHERE id = ${orderId} AND state IN ('running', 'failed') AND job_id IS NULL
  `;
}

/**
 * Makes one shot's image along the fallback chain: Hermes image_gen (which walks its own provider chain), then a
 * 9router image model a real call has proven (a listed model alone is never used), then a CC0 file fetched by a worker
 * job, then a Muse agent task when the owner switched those on. A rate-limited Hermes returns "busy", not a failure.
 */
async function produceOrder(run: RunInfo, order: OrderRow, excluded: Set<string>): Promise<Produced> {
  // Only a 9router model a real call has proven, and not one that refused a request earlier in this stage.
  const routerImage = await routerImageModel(excluded);
  const chain = fallbackChain({
    hermesConfigured: Boolean(env().HERMES_BASE_URL),
    museAgentTasks: env().MUSE_AGENT_TASKS === "1",
    routerImageAvailable: routerImage !== null,
  });
  const reasons: string[] = [];
  const causes: FailureClass[] = [];
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
          provider: spec.provider,
          needs: spec.needs,
        });
        if (!r.ok) {
          if (r.cause === "busy" && r.busyUntil) return { kind: "busy", until: r.busyUntil, text: r.error };
          reasons.push(`Hermes image attempt ${attempt}: ${r.error}`);
          causes.push(r.cause);
          // A refused key or an unreachable Hermes will not change on the next attempt.
          if (r.cause === "auth" || r.cause === "unreachable") break;
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
          backend: img.backend,
          plugin: img.plugin,
          model: img.model,
          prompt: spec.prompt,
          originUrl: img.originUrl,
          runId: run.id,
          workOrderId: order.id,
          shotRef: order.shotRef,
          channelId: run.channelId,
          createdBy: null,
        });
        const made: Record<string, unknown> = { executor: "hermes-image", model: img.model };
        if (img.backend) made.backend = img.backend;
        if (img.plugin) made.plugin = img.plugin;
        if (spec.provider) made.preferredProvider = spec.provider;
        if (spec.needs) made.needs = spec.needs;
        await finishOrder(order.id, saved.assetId, saved.provider, {
          ...made,
          hermesAsks: r.attempts,
          claim: order.attempts,
          ...(r.tried.length > 0 ? { hermesTried: r.tried.map((t) => t.provider) } : {}),
        });
        return { kind: "done" };
      }
    } else if (step === "router-image") {
      const r = await generateRouterImage({ prompt: spec.prompt, format: run.config.format, note: spec.note || undefined }, excluded);
      if (!r.ok) {
        reasons.push(`9router image: ${r.error}`);
        causes.push(r.cause);
        // Never send the same request to a model that refused it, for the rest of this stage.
        if (r.cause === "client" && r.model) excluded.add(r.model);
        continue;
      }
      const img = r.image;
      const saved = await saveGeneratedAsset({
        bytes: img.bytes,
        name: safeFileName(order.shotRef, IMAGE_EXT[img.info.mime] ?? "png"),
        contentType: img.info.mime,
        kind: "image",
        executor: "router-image",
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
      await finishOrder(order.id, saved.assetId, saved.provider, { executor: "router-image", model: img.model, via: "9router", claim: order.attempts });
      return { kind: "done" };
    } else if (step === "library") {
      const found = await findCc0Candidate(spec.prompt);
      if (!found.ok) {
        if (found.cause === "busy" && found.busyUntil) return { kind: "busy", until: found.busyUntil, text: found.error };
        reasons.push(`Public-domain search: ${found.error}`);
        causes.push(found.cause);
        continue;
      }
      const queued = await createFetchAssetJob(ref, found.candidate, null);
      if (!queued.ok) {
        reasons.push(`Public-domain download: ${queued.error}`);
        causes.push("content");
        continue;
      }
      await waitOnJob(order.id, queued.jobId, "fetch-asset");
      return { kind: "waiting" };
    } else {
      try {
        const jobId = await createAgentTaskJob(ref, null, await agentPictureExtras(run, order));
        await waitOnJob(order.id, jobId, "agent-task");
        return { kind: "waiting" };
      } catch (err) {
        reasons.push(`Muse agent task: ${errorText(err)}`);
        causes.push("server");
      }
    }
  }
  if (!chain.includes("hermes-image") && !chain.includes("router-image")) {
    // Nothing that can make a picture was available. Say what is missing instead of only listing the fallbacks that failed.
    const snap = await getCapabilities().catch(() => null);
    reasons.unshift(missingCapabilityMessage("image", scanStateOf(snap)));
  }
  return { kind: "failed", reason: reasons.join(" | ").slice(0, 480) || "No image source is configured", cause: orderFailureCause(causes) };
}

/**
 * The context of the agent-task picture fallback (docs/muse-agent-tasks.md): the shot prompt and the exact file in
 * SPEC.json, the style contract in CONTRACT.md and the run's approved script and shot list in PLAN.md. The agent
 * reads these from the inbox, never from its own workspace.
 */
async function agentPictureExtras(run: RunInfo, order: OrderRow): Promise<AgentTaskExtras> {
  const sql = db();
  const [script, shape] = await Promise.all([approvedScript(sql, run.id), storyboardShape(sql, run.id)]);
  const packId = run.config.stylePack?.id ?? null;
  const contract = packId ? await packContract(packId).catch(() => null) : null;
  const m = /^shot-(\d{1,4})$/.exec(order.shotRef);
  const plan = planMarkdown({
    topic: run.topic,
    styleId: run.config.styleId,
    script: script?.value.script ?? null,
    shots: shape?.shots.map((s) => ({ beatRole: s.beatRole, seconds: s.seconds, description: s.description, imagePrompt: s.imagePrompt })) ?? null,
    shotRef: order.shotRef,
    shotIndex: m ? Number(m[1]) - 1 : null,
  });
  const short = run.config.format === "short";
  const built = pictureFallbackContext({
    shotRef: order.shotRef,
    prompt: order.spec.prompt,
    format: run.config.format,
    width: short ? 1080 : 1920,
    height: short ? 1920 : 1080,
    plan,
    contract: contractMarkdown({ styleId: run.config.styleId, packId, contract }),
  });
  return { ...built, project: run.topic || "VenStudio run", stage: "assets" };
}

/** Counts work orders by state for one run. */
async function orderCounts(sql: Q, runId: string) {
  const rows = await sql`SELECT state FROM work_orders WHERE run_id = ${runId} AND stage = 'assets'`;
  return countOrders(rows.map((r) => r.state as string));
}

/**
 * One pass over the pending orders. A pass is bounded so a bad run cannot loop forever; the reaper resumes it.
 * - A rate-limited Hermes ends the pass: the order goes back to pending (its attempt is not spent) and the stage waits
 *   with a not-before time (deferStage), to be resumed by a timer, the worker claim route or a page. After
 *   HERMES_WAIT_GIVE_UP_MS of waiting without progress it becomes a stage error the owner can Retry.
 * - When the first shots of a pass fail with the same systemic cause (auth, unreachable, server), the stage pauses
 *   once with one stage error instead of failing every shot. Those shots go back to pending.
 * - A 9router model that answered with a 4xx is not used again in this stage.
 */
async function runAssetsStage(run: RunInfo, st: StageRow): Promise<void> {
  const excluded = new Set<string>();
  const outcomes: Array<FailureClass | "ok"> = [];
  const pausable: Array<{ id: string; reason: string }> = [];
  let progressed = false;
  for (let i = 0; i < 200; i++) {
    const order = await claimOrder(run.id);
    if (!order) break;
    let out: Produced;
    try {
      out = await produceOrder(run, order, excluded);
    } catch (err) {
      console.error("work order failed", run.id, order.shotRef, err);
      out = { kind: "failed", reason: `Unexpected error: ${errorText(err)}`, cause: "content" };
    }
    if (out.kind === "busy") {
      await returnOrderBusy(run.id, order.id, out.until, out.text);
      if (!progressed && waitExpired(st.output.waitSince, Date.now())) {
        await recordStageError(run.id, st.id, "assets", `${giveUpMessage()} ${out.text}`);
        return;
      }
      await deferStage(run.id, st.id, out.until, out.text, { restartClock: progressed });
      return;
    }
    if (out.kind === "failed") {
      await failOrder(order.id, out.reason).catch(() => {});
      outcomes.push(out.cause);
      pausable.push({ id: order.id, reason: out.reason });
      const decision = systemicPause(outcomes);
      if (decision.pause) {
        for (const p of pausable) await returnOrderPaused(p.id);
        await recordStageError(run.id, st.id, "assets", pauseMessage(decision.cause, pausable.length, pausable[pausable.length - 1].reason));
        return;
      }
    } else {
      outcomes.push("ok");
      progressed = true;
    }
  }
  // Orders another pass put on hold for Hermes are not claimable yet: wait with them instead of idling as running.
  const [held] = await db()`
    SELECT min(not_before) AS until, max(wait_reason) AS reason FROM work_orders
    WHERE run_id = ${run.id} AND stage = 'assets' AND state = 'pending' AND not_before > now()
  `;
  if (held && held.until instanceof Date) {
    await deferStage(run.id, st.id, held.until, typeof held.reason === "string" ? held.reason : "Waiting for Hermes", { restartClock: progressed });
    return;
  }
  await finalizeAssets(run.id);
}

interface AssetRow {
  shotRef: string;
  provider: string;
  /** The Hermes plugin in front of the backend, from the asset metadata. Empty for older assets and non-Hermes paths. */
  plugin: string;
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
    const providerKind: ProviderKind = kindText === "tts" ? "tts" : kindText === "library" ? "library" : kindText === "video" ? "video" : "image";
    const tags = Array.isArray(r.tags) ? (r.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];
    return {
      shotRef: (r.shot_ref as string | null) ?? "",
      provider: normalizeProvider(text(meta.provider) || ((r.provider as string | null) ?? "")),
      plugin: text(meta.plugin),
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
  const conclusion = await assetsConclusion(sql, runId, template, await listProviderTerms());
  await concludeStage(run, st, template, conclusion);
}

/** The assets gate (G-assets plus provider terms) on the finished images, and what the card shows. Reads only. */
async function assetsConclusion(sql: Q, runId: string, template: Template, providerTerms: ProviderTerms[]): Promise<StageConclusion> {
  const rows = await loadAssetRows(sql, runId);
  const total = (await sql`SELECT count(*)::int AS n FROM work_orders WHERE run_id = ${runId} AND stage = 'assets'`)[0]?.n as number | undefined;
  const shotCount = total ?? rows.length;
  const base = assetsGate(
    rows.map((r) => r.record),
    { use: "publish", shotCount, coveredShots: rows.length, visionFlags: [], template },
  );
  const uses = rows.map((r) => ({ title: r.record.title, provider: r.provider, kind: r.providerKind }));
  const terms = providerTermsIssues(uses, providerTerms);
  const gate = addGateIssues(base, terms);
  const providers = Array.from(new Set(rows.map((r) => r.provider)));
  // The storyboards forbid real people, but a disclosure is cheap: assume anything AI made may look realistic.
  const disclosure = aiDisclosureRequired({ sources: rows.map((r) => r.record.source), realisticSynthetic: true });
  const media: ReviewMedia = {
    images: rows.map((r) => {
      const item: { assetId: string; shotRef: string; provider: string; plugin?: string } = { assetId: r.assetId, shotRef: r.shotRef, provider: r.provider };
      if (r.plugin) item.plugin = r.plugin;
      return item;
    }),
  };
  const result = { done: rows.length, total: shotCount, providers, aiDisclosureRequired: disclosure, termsOnly: onlyTermsIssues(gate.issues) };
  return { result, gate, media, providers: providerRowsUsed(uses) };
}

/**
 * The approved plan's shots and planned length (sum of the shots), or null when it cannot be read: the storyboard, or
 * in a workflow without pictures the scene spec or the skill brief that stands in its place (recipes.ts).
 */
async function storyboardShape(q: Q, runId: string): Promise<{ shots: Shot[]; plannedSec: number } | null> {
  const out = await latestPassedOutput(q, runId, "storyboard");
  let shots: Shot[] | null = null;
  if (out) {
    const board = validateStoryboard(out.result);
    shots = board.ok ? board.value.shots : null;
  } else {
    const spec = await latestPassedOutput(q, runId, "scene-spec");
    const brief = spec ? null : await latestPassedOutput(q, runId, "skill-brief");
    const page = spec || brief ? null : await latestPassedOutput(q, runId, "html-design");
    const s = spec ? readSceneSpec(spec.result) : null;
    const b = brief ? readSkillBrief(brief.result) : null;
    const d = page ? readHtmlDesign(page.result) : null;
    shots = s ? sceneSpecShots(s) : b ? skillBriefShots(b) : d ? htmlDesignShots(d) : null;
  }
  if (!shots) return null;
  return { shots, plannedSec: shots.reduce((n, s) => n + s.seconds, 0) };
}

/** The approved script (the newest passed attempt, which a script fit replaces), with its attempt number. */
async function approvedScript(q: Q, runId: string): Promise<{ attempt: number; output: Record<string, unknown>; value: ScriptOutput } | null> {
  const [r] = await q`
    SELECT attempt, output FROM pipeline_stages WHERE run_id = ${runId} AND stage = 'script' AND state = 'passed'
    ORDER BY attempt DESC LIMIT 1
  `;
  if (!r) return null;
  const output = toObject(r.output);
  const checked = validateScript(output.result);
  return checked.ok ? { attempt: Number(r.attempt), output, value: checked.value } : null;
}

/** The voice that spoke a narration result, for its speech-rate key. Older results lack `speaker` and use their own fields. */
function speakerOf(result: Record<string, unknown>): { provider: string; model: string; voice: string } {
  const sp = toObject(result.speaker);
  return {
    provider: text(sp.provider) || text(result.provider),
    model: text(sp.model) || text(result.model),
    voice: text(sp.voice) || text(result.voice),
  };
}

const finiteOr = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/**
 * The voice gate on a narration result: language, clipping, the format's limits, the storyboard's shots, the script
 * estimate at the voice's pace (a note unless it is far off), and the provider terms. Used when the voice is made and
 * when its card is checked again or fitted. Reads only.
 */
function voiceConclusionFrom(i: {
  run: RunInfo;
  template: Template;
  result: Record<string, unknown>;
  script: string | null;
  board: { shots: Shot[]; plannedSec: number } | null;
  pace: Pace;
  providerTerms: ProviderTerms[];
}): StageConclusion {
  const r = i.result;
  const provider = text(r.provider);
  const narrationSec = finiteOr(r.narrationSec, 0);
  const estimate = i.script ? estimateNarrationSec(i.script, i.pace.wpm) : finiteOr(r.scriptEstimateSec, 0);
  const a = voiceAssessment({
    languageCode: i.run.config.language,
    provider,
    scriptEstimateSec: estimate,
    narrationSec,
    clipped: r.clipped === true,
    format: i.run.config.format,
    shotCount: i.board?.shots.length,
    maxShotSeconds: i.template.pacing.maxShotSeconds,
    plannedSec: i.board?.plannedSec,
    tempo: tempoOf(r.tempo),
    wordsPerMinute: i.pace.wpm,
  });
  const base: GateResult = { gate: a.gate, passed: a.passed, issues: a.issues, executor: a.executor };
  if (a.notes) base.notes = a.notes;
  const gate = addGateIssues(base, providerTermsIssues([{ title: "Narration", provider, kind: "tts" }], i.providerTerms));
  const result = { ...r, scriptEstimateSec: estimate, wordsPerMinute: i.pace.wpm, paceLearned: i.pace.learned };
  const assetId = asUuid(r.assetId) ?? "";
  return {
    result,
    gate,
    media: { audioAssetId: assetId, voiceProvider: provider },
    providers: [{ name: provider, kind: "tts", count: 1 }],
    voice: a.fix,
    notes: a.notes ?? [],
  };
}

/** Each non-revoked worker's reported capabilities, mapped from postgres rows. Null when the read fails. */
/**
 * The machine that drew the approved stills, when it can still take the render. The preview is a promise about the
 * look, so the video is drawn by the same worker: two machines can differ in what they can render (a browser without
 * WebGL draws only text), and that difference must not show up as a video that disagrees with its own preview.
 */
async function previewWorkerPin(q: Q, runId: string, packCapability: string | null): Promise<{ workerId: string | null; hadPreview: boolean }> {
  try {
    const rows = await q`
      SELECT j.worker_id, w.status, w.capabilities
      FROM jobs j JOIN workers w ON w.id = j.worker_id
      WHERE j.type = 'preview-frames' AND j.worker_id IS NOT NULL AND j.payload->>'runId' = ${runId}
      ORDER BY j.created_at DESC LIMIT 1`;
    const r = rows[0] as { worker_id?: unknown; status?: unknown; capabilities?: unknown } | undefined;
    if (!r || typeof r.worker_id !== "string") return { workerId: null, hadPreview: false };
    if (r.status === "revoked") return { workerId: null, hadPreview: true };
    const caps = Array.isArray(r.capabilities) ? (r.capabilities as unknown[]).map((c) => String(c)) : [];
    if (packCapability && !caps.includes(packCapability)) return { workerId: null, hadPreview: true };
    return { workerId: r.worker_id, hadPreview: true };
  } catch {
    return { workerId: null, hadPreview: false };
  }
}

async function workerCapabilityLists(q: Q): Promise<string[][] | null> {
  try {
    const rows = await q`SELECT capabilities FROM workers WHERE status <> 'revoked'`;
    return rows.map((r) => (Array.isArray(r.capabilities) ? (r.capabilities as unknown[]).map((c) => String(c)) : []));
  } catch {
    return null;
  }
}

/** True when every render worker can play a narration at a changed tempo (worker 0.6.0+). False when unknown. */
export async function narrationTempoReady(q: Q = db()): Promise<boolean> {
  const lists = await workerCapabilityLists(q);
  return lists !== null && tempoReadyFor(lists);
}

/**
 * For a re-check of an assets or voice card: the same conclusion the stage reached, worked out again from the work
 * that is already saved and the given terms. It reads only: no work order changes, nothing is generated or
 * synthesized, no provider is registered. Runs inside the caller's transaction (which holds the run and stage locks).
 * With `fit` on a voice card, the narration is given the tempo that makes it fit the shots (nothing is made again).
 */
export async function recheckConclusion(
  q: Q,
  run: RunInfo,
  st: StageRow,
  template: Template,
  providerTerms: ProviderTerms[],
  opts: { fit?: boolean } = {},
): Promise<{ ok: true; conclusion: StageConclusion } | { ok: false; error: string }> {
  if (st.stage === "assets") {
    if (opts.fit) return { ok: false, error: "Only a voice card can be fitted to the video." };
    const counts = await orderCounts(q, run.id);
    if (counts.failed > 0 || counts.pending > 0 || counts.running > 0) {
      return { ok: false, error: "Some shots are not finished, so the terms alone cannot pass them. Use Retry failed shots." };
    }
    const conclusion = await assetsConclusion(q, run.id, template, providerTerms);
    if ((conclusion.media?.images ?? []).length === 0) return { ok: false, error: "No finished images were found for this run." };
    return { ok: true, conclusion };
  }
  if (st.stage === "voice") {
    const result = toObject(st.output.result);
    const assetId = asUuid(result.assetId);
    const provider = text(result.provider);
    if (!assetId || !provider) return { ok: false, error: "The narration of this run could not be read back. Use Make the voice again." };
    const [asset] = await q`SELECT id FROM assets WHERE id = ${assetId}`;
    if (!asset) return { ok: false, error: "The narration file is gone. Use Make the voice again." };
    const script = await approvedScript(q, run.id);
    const board = await storyboardShape(q, run.id);
    const pace = await paceForRun(run.config.language, speakerOf(result), q);
    const input = { run, template, script: script?.value.script ?? null, board, pace, providerTerms };
    let conclusion = voiceConclusionFrom({ ...input, result });
    if (opts.fit) {
      const tempo = conclusion.voice?.fitTempo ?? null;
      if (tempo === null) {
        return { ok: false, error: `This narration cannot be fitted by a small speed change. Use ${tightenLabel(runStagesOf(run.config).includes("assets"))}.` };
      }
      conclusion = voiceConclusionFrom({ ...input, result: { ...result, tempo } });
    }
    return { ok: true, conclusion };
  }
  if (st.stage === "render") {
    // A reel that recorded its own voice (hermes-skill, hermes.voice skill): only its voice backend's terms are judged
    // again, on the video that is already made. Nothing is rendered again.
    if (opts.fit) return { ok: false, error: "Only a voice card can be fitted to the video." };
    const result = toObject(st.output.result);
    const by = toObject(result.narrationBy);
    const assetId = asUuid(result.assetId);
    const name = normalizeProvider(text(by.backend) || text(by.provider));
    if (!assetId || !name) return { ok: false, error: "This video has no voice of its own to check; use Try again." };
    const [asset] = await q`SELECT id FROM assets WHERE id = ${assetId}`;
    if (!asset) return { ok: false, error: "The video file is gone. Use Try again." };
    const base: GateResult = { gate: "G-voice", passed: true, issues: [], executor: "hermes-skill" };
    const gate = addGateIssues(base, providerTermsIssues([{ title: "Narration (recorded by the skill)", provider: name, kind: "tts" }], providerTerms));
    return {
      ok: true,
      conclusion: { result, gate, extra: { renderer: text(st.output.renderer) || "hermes" }, media: { videoAssetId: assetId, voiceProvider: name }, providers: [{ name, kind: "tts", count: 1 }] },
    };
  }
  return { ok: false, error: "Only the assets, voice and skill-voiced render steps can be checked again." };
}

/**
 * Plans a script fit for the run's voice card: the target length from the narration, the storyboard and the format,
 * and this voice's pace. Reads only. Fails when the narration or the storyboard cannot be read, or nothing fits.
 */
export async function planScriptFit(
  q: Q,
  runId: string,
  direction: LengthDirection,
  note: string,
): Promise<{ ok: true; request: TightenRequest } | { ok: false; error: string }> {
  const run = await loadRun(q, runId);
  const template = run?.templateId ? await getTemplate(run.templateId) : null;
  if (!run || !template) return { ok: false, error: "The run or its template no longer exists" };
  const [v] = await q`SELECT output FROM pipeline_stages WHERE run_id = ${runId} AND stage = 'voice' ORDER BY attempt DESC LIMIT 1`;
  const result = toObject(toObject(v?.output).result);
  const narrationSec = finiteOr(result.narrationSec, 0);
  if (!(narrationSec > 0)) return { ok: false, error: "The narration length of this run is not known, so the script cannot be fitted to it." };
  const script = await approvedScript(q, runId);
  const board = await storyboardShape(q, runId);
  if (!script || !board) return { ok: false, error: "The approved script or storyboard is missing" };
  const pace = await paceForRun(run.config.language, speakerOf(result), q);
  const window = fitWindow({ format: run.config.format, shotCount: board.shots.length, maxShotSeconds: template.pacing.maxShotSeconds });
  const request = tightenRequest({
    narrationSec,
    words: countWords(script.value.script),
    plannedSec: board.plannedSec,
    window,
    direction,
    fallbackWpm: pace.wpm,
    note,
  });
  if (!request) return { ok: false, error: "No narration length fits both the format and the storyboard's shots. Send a revision to the storyboard." };
  return { ok: true, request };
}

// ---------------------------------------------------------------------------------------------------------------
// Voice

/**
 * Has Hermes rewrite the approved script to the requested length, keeping the storyboard's beats, and stores it as
 * the newest approved script. The storyboard, the work orders and every image are left as they are. Returns the new
 * script, or null when the stage was deferred (Hermes busy) or failed (a stage error with Retry, which asks again).
 */
async function fitScript(run: RunInfo, st: StageRow, request: TightenRequest): Promise<{ script: string; words: number } | null> {
  const sql = db();
  const script = await approvedScript(sql, run.id);
  const board = await storyboardShape(sql, run.id);
  if (!script || !board) {
    await recordStageError(run.id, st.id, "voice", "The approved script or storyboard is missing, so the script cannot be fitted");
    return null;
  }
  const targetWords = fitTargetWords(request.targetSec, request.wordsPerMinute);
  const prompt = scriptFitPrompt({
    script: script.value.script,
    shots: board.shots,
    targetSec: request.targetSec,
    wordsPerMinute: request.wordsPerMinute,
    language: run.config.language,
    note: request.note || undefined,
  });
  const streak = slowStreakOf(st.output) + 1;
  const r = await hermesJson(prompt, (v) => validateFittedScript(v, targetWords), { kind: "script-fit", slowStreak: streak });
  if (!r.ok) {
    if (r.cause === "busy" && r.busyUntil && !waitExpired(st.output.waitSince, Date.now())) {
      await deferStage(run.id, st.id, r.busyUntil, r.error, r.slow ? { slow: { afterMs: r.slow.afterMs, streak } } : {});
      return null;
    }
    await recordStageError(run.id, st.id, "voice", `Hermes could not fit the script to the pictures: ${r.error}`.slice(0, 500));
    return null;
  }
  const words = countWords(r.value.script);
  const output = {
    result: { ...script.value, script: r.value.script },
    feedback: request.note,
    autoRevisions: 0,
    auto: false,
    fittedFrom: script.attempt,
    fit: { targetSec: request.targetSec, words, direction: request.direction },
  };
  await sql.begin(async (tx) => {
    // The fitted script becomes the newest approved script; the storyboard stays approved and no work order changes.
    await tx`
      INSERT INTO pipeline_stages (run_id, stage, state, attempt, output, started_at, finished_at)
      SELECT ${run.id}::uuid, 'script', 'passed', COALESCE(MAX(attempt), 0) + 1, ${json(output)}::text::jsonb, now(), now()
      FROM pipeline_stages WHERE run_id = ${run.id} AND stage = 'script'
    `;
    // Done: a retry of this voice stage now speaks the fitted script instead of asking Hermes again.
    await tx`UPDATE pipeline_stages SET output = output - 'tighten' WHERE id = ${st.id}`;
  });
  return { script: r.value.script, words };
}

async function runVoiceStage(run: RunInfo, st: StageRow, template: Template): Promise<void> {
  const sql = db();
  const checked = await approvedScript(sql, run.id);
  if (!checked) {
    await recordStageError(run.id, st.id, "voice", "The approved script is missing");
    return;
  }
  let script = checked.value.script;
  let fittedWords: number | null = null;
  const ttsJobId = asUuid(st.output.ttsJobId);
  // Back from a worker's Kokoro: the script is the one the job spoke (a fit is not asked for again), and the job decides.
  const spoken = ttsJobId && typeof st.output.ttsScript === "string" ? st.output.ttsScript : null;
  const fitRequest = spoken ? null : parseTightenRequest(st.output.tighten);
  if (spoken) {
    script = spoken;
    if (typeof st.output.ttsFittedWords === "number") fittedWords = st.output.ttsFittedWords;
  }
  if (fitRequest) {
    const fitted = await fitScript(run, st, fitRequest);
    if (!fitted) return;
    script = fitted.script;
    fittedWords = fitted.words;
  }
  let tts: SynthesisResult;
  const workerVoice = (st.output.ttsVoice ?? null) as { voice?: string; verified?: boolean; notes?: string[] } | null;
  if (ttsJobId && spoken) {
    const job = await pollTtsJob(ttsJobId);
    if (job.kind === "wait") {
      const until = new Date(Date.now() + job.pollSec * 1000);
      await deferRenderPoll(run.id, st.id, until, {}, { until: until.toISOString(), text: job.text });
      return;
    }
    if (job.kind === "done") {
      tts = { ok: true, narration: workerNarration(job.audio, { voice: workerVoice?.voice ?? "", verified: workerVoice?.verified === true, notes: workerVoice?.notes ?? [] }) };
    } else {
      // The worker could not speak it: the Hermes paths are next, with what happened kept in the notes.
      tts = await synthesize(script, run.config.language);
      if (tts.ok) tts = { ok: true, narration: { ...tts.narration, skipped: [job.error, ...tts.narration.skipped], note: `Other voice paths: ${[job.error, ...tts.narration.skipped].join(" ")}` } };
    }
  } else {
    tts = await synthesize(script, run.config.language, { workerTts: await ttsWorkerAvailable() });
    if (!tts.ok && tts.workerTts) {
      const w = tts.workerTts;
      let jobId: string | null = null;
      try {
        jobId = await startTtsJob({ runId: run.id, channelId: run.channelId, chunks: w.chunks, voice: w.voice });
      } catch (err) {
        console.error("could not queue the worker narration", run.id, err);
      }
      if (jobId) {
        const until = new Date(Date.now() + TTS_POLL_SEC * 1000);
        await deferRenderPoll(
          run.id,
          st.id,
          until,
          { ttsJobId: jobId, ttsScript: script, ttsVoice: { voice: w.voice, verified: w.verified, notes: w.notes }, ...(fittedWords !== null ? { ttsFittedWords: fittedWords } : {}) },
          { until: until.toISOString(), text: "Waiting for a worker with Kokoro to take the narration" },
        );
        return;
      }
      // Could not queue it: carry on with the Hermes paths, as if no worker were offered.
      tts = await synthesize(script, run.config.language);
    }
  }
  if (!tts.ok) {
    // 9router could not speak and Hermes is rate limited: wait for Hermes instead of failing the voice.
    if (tts.busyUntil && !waitExpired(st.output.waitSince, Date.now())) {
      await deferStage(run.id, st.id, tts.busyUntil, tts.error, tts.slow ? { slow: { afterMs: tts.slow.afterMs, streak: slowStreakOf(st.output) + 1 } } : {});
      return;
    }
    await recordStageError(run.id, st.id, "voice", tts.busyUntil ? `${giveUpMessage(undefined, tts.slow ? "slow" : "rate-limit")} ${tts.error}` : tts.error);
    return;
  }
  const n = tts.narration;
  const saved = await saveGeneratedAsset({
    bytes: n.audio,
    name: safeFileName("narration", n.ext),
    contentType: n.mime,
    kind: "audio",
    executor: n.executor,
    title: `Narration (${n.provider})`,
    provider: n.provider,
    backend: n.backend,
    plugin: n.plugin,
    model: n.model,
    runId: run.id,
    channelId: run.channelId,
    createdBy: null,
  });
  const words = countWords(script);
  const speaker = { provider: n.provider, model: n.model, voice: n.voice };
  // The pace of this voice from earlier recordings; this narration is recorded after the check so it does not judge itself.
  const pace = await paceForRun(run.config.language, speaker);
  // WAV and MP3 lengths are measured here. CapCut audio that is Ogg is refused at the source, so only WAV and MP3 (measured) reach here.
  const narrationSec = n.durationSec ?? estimateNarrationSec(script, pace.wpm);
  const result = {
    assetId: saved.assetId,
    provider: saved.provider,
    voice: n.voice,
    model: n.model,
    speaker,
    ...(n.backend ? { backend: n.backend } : {}),
    ...(n.plugin ? { plugin: n.plugin } : {}),
    via: n.via,
    skipped: n.skipped,
    voiceVerified: n.voiceVerified,
    narrationSec,
    words,
    ...(fittedWords !== null ? { fittedWords } : {}),
    clipped: n.clipped,
    deferredCheck: n.deferredCheck,
    mime: n.mime,
    note: n.note,
  };
  const board = await storyboardShape(sql, run.id);
  const conclusion = voiceConclusionFrom({ run, template, result, script, board, pace, providerTerms: await listProviderTerms() });
  if (n.durationSec !== null) {
    await recordSpeechSample({ ...speaker, language: run.config.language, words, seconds: n.durationSec, source: "narration", runId: run.id });
  }
  await concludeStage(run, st, template, conclusion);
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
    // A hermes render whose narration job failed stops here with its reason; Hermes is never asked again from here.
    if ((status === "failed" || status === "cancelled") && isRecord(st.output.hermesClip)) {
      await completeRender(existing);
      return;
    }
  }
  // The run's plan: the storyboard (image-sequence, and every run from before workflows), the scene spec or the brief.
  const recipe = runRecipeOf(run.config);
  const planStage = recipe === "scene-spec" ? "scene-spec" : recipe === "hermes-skill" ? "skill-brief" : recipe === "html-design" ? "html-design" : "storyboard";
  const boardOut = await latestPassedOutput(sql, run.id, planStage);
  const board = recipe === "image-sequence" ? validateStoryboard(boardOut?.result) : null;
  const spec = recipe === "scene-spec" ? readSceneSpec(boardOut?.result) : null;
  const brief: SkillBrief | null = recipe === "hermes-skill" ? readSkillBrief(boardOut?.result) : null;
  const design: HtmlDesign | null = recipe === "html-design" ? readHtmlDesign(boardOut?.result) : null;
  const planShots: Shot[] | null = board ? (board.ok ? board.value.shots : null) : spec ? sceneSpecShots(spec) : brief ? skillBriefShots(brief) : design ? htmlDesignShots(design) : null;
  const scriptOut = await latestPassedOutput(sql, run.id, "script");
  const script = validateScript(scriptOut?.result);
  const voiceOut = await latestPassedOutput(sql, run.id, "voice");
  const voiceResult = toObject(voiceOut?.result);
  if (!planShots || !script.ok) {
    const what = recipe === "scene-spec" ? "scene spec" : recipe === "hermes-skill" ? "skill brief" : recipe === "html-design" ? "page" : "storyboard";
    await recordStageError(run.id, st.id, "render", `The approved ${what} or script is missing`);
    return;
  }
  // A page Hermes wrote is research only: rendered only for a trial (always so for html-design, run-config.ts).
  if (recipe === "html-design" && !run.config.stylePack?.trial) {
    await recordStageError(run.id, st.id, "render", "A page Hermes wrote is research only, so it renders only as a trial. This run is not a trial; nothing was rendered.");
    return;
  }
  const done = await sql`SELECT shot_ref, asset_id FROM work_orders WHERE run_id = ${run.id} AND stage = 'assets' AND state = 'done' AND asset_id IS NOT NULL`;
  const shotAssets: Record<string, string> = {};
  for (const d of done) shotAssets[(d.shot_ref as string | null) ?? ""] = d.asset_id as string;
  if (recipe === "scene-spec" || recipe === "html-design") {
    // No picture is generated: every shot gets the run's plain plate, because the render contract carries one per shot.
    const f = VIDEO_FORMATS[run.config.format];
    const plate = await ensureRunPlate(run, { width: f.width, height: f.height });
    workOrdersFromStoryboard(planShots).forEach((w) => (shotAssets[w.shotRef] = plate));
  }
  // Same pick as the preview render: the newest font in the library. Without one the render runs without captions.
  const [font] = await sql`SELECT id FROM assets WHERE kind = 'font' AND storage_path IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
  // The style decides the engine, and an engine the worker has no path for must fail here rather
  // than fall through to stills. Same for the scene plan: it is what an animating template renders.
  // The story words of each shot ride along with its length: the pack's page draws them, and a look without a
  // vocabulary simply never has any (planShots and the work orders are one list in the same order).
  const shotSpecs = workOrdersFromStoryboard(planShots).map((w, i) => ({
    shotRef: w.shotRef,
    seconds: w.spec.seconds,
    ...(planShots[i]?.intent ? { intent: { ...planShots[i]?.intent } as Record<string, unknown> } : {}),
  }));
  // A pack the catalogue does not know (an html-capture adaptation, a research pack) plans and renders from its own
  // contract (styleFromPack), never as stills by default.
  const packStyle = await packStyleFor(template.styleId);
  const renderParams = renderParamsForStyle(template.styleId, packStyle);
  // The hermes renderer (research only) is run by the portal: Hermes renders the video, no worker job is queued.
  if (renderParams && isPortalEngine(renderParams.engine)) {
    await runHermesRenderStage(run, st, template, {
      style: packStyle,
      shots: planShots,
      shotRefs: shotSpecs.map((x) => x.shotRef),
      captions: captionLines(script.value.script),
      voiceResult,
      shotAssets,
      transitionSec: renderParams.transitionSec,
      brief,
      script: script.value.script,
    });
    return;
  }

  // A cross-fade is a two-sided change: the worker has to build the xfade and accept a timeline whose
  // shots add up to more than the narration. So the portal only asks once a worker says it can, and a
  // capability read that fails (null) means no fades and no engine gate, rather than a failed run.
  let workerCapabilities: string[] | null = null;
  try {
    const rows = (await sql`SELECT DISTINCT unnest(capabilities) AS cap FROM workers WHERE status <> 'revoked'`) as unknown as Array<{ cap: unknown }>;
    workerCapabilities = rows.map((r) => String(r.cap)).filter(Boolean);
  } catch {
    workerCapabilities = null;
  }
  const fadeSec = transitionForWorker(workerCapabilities, shotSpecs.map((s) => s.seconds));
  // Once any worker reports, an engine none of them can run fails here, at planning, instead of being claimed by a
  // worker that would refuse it (0.5+) or, worse, render it as stills (0.4). With no worker enrolled the job waits.
  const gate = gateCapabilities(workerCapabilities);
  const engine = renderParams?.engine ?? DEFAULT_RENDER_ENGINE;
  // Read once, outside the closure, so the narrowing above holds.
  const boardShots = planShots;
  const captions = captionLines(script.value.script);
  // A fitted narration plays at its tempo: the shots, captions and video length are planned for the played length,
  // and the worker (0.6.0+) applies the tempo. Without a fit the payload is exactly what it was before.
  const tempo = tempoOf(voiceResult.tempo);
  const rawNarrationSec = typeof voiceResult.narrationSec === "number" ? voiceResult.narrationSec : 0;
  if (tempo !== 1) {
    const lists = await workerCapabilityLists(sql);
    // With no worker enrolled the job waits in the queue like any other render; once workers report, all must cope.
    if (lists && lists.length > 0 && !tempoReadyFor(lists)) {
      await recordStageError(run.id, st.id, "render", tempoWorkerMessage(tempo));
      return;
    }
  }
  const fontAssetId = font ? asUuid(font.id) : null;
  // The length the shots, the captions and the mix are all planned for: a fitted voice plays at its tempo.
  const narrationSec = tempo !== 1 ? rawNarrationSec / tempo : rawNarrationSec;
  const frame = VIDEO_FORMATS[run.config.format];
  // The mix and the caption style change the video only on a worker that honours them (0.7.0). Any render worker may
  // claim the job, so they are sent only when every one of them reports the capability; otherwise the payload is the
  // 0.6.0 one and the stage says what was held back.
  const mix = mixFeaturesFor(await workerCapabilityLists(sql));
  // Geometry, not taste. The spec scales by frame height, so a portrait job and a landscape job both get
  // numbers that were measured instead of numbers that happened to be typed for one frame.
  const captionSpec = mix.captionStyle
    ? captionSpecFor({ width: frame.width, height: frame.height, fontAssetId, safeAreaPct: template.captions.safeAreaPct })
    : null;
  // Ambience needs no asset. The bed is the one layer that does, and only a track the owner marked as music, with a
  // licence and confirmed terms, qualifies (music-bed.ts). Never the narration, which is saved as audio too.
  const sound = run.config.sound ?? DEFAULT_SOUND;
  const bedPick = mix.audio && narrationSec > 0 ? await pickRunBed(sql, run, template, asUuid(voiceResult.assetId), sound.bed) : null;
  const bed = bedPick?.bed ?? null;
  // Accents sit on shot boundaries: the board already knows where the picture changes, so no second guess is needed.
  const cues = mix.audio && planShots ? sfxCues(planShots, sound.sfx) : [];
  const sfxAssets = cues.length > 0 ? await pickSfxLibrary(sql) : [];
  const sfx = cues.length > 0 ? pairCues(cues, sfxAssets) : [];
  await noteMissingSound(recordNeeds, { bed, bedChoice: sound.bed, cues, sfxAssets, ambience: sound.ambience }).catch(() => undefined);
  const audio =
    mix.audio && narrationSec > 0
      ? buildAudioPlan({
          policy: template.audio.musicPolicy,
          narrated: template.audio.narrated,
          durationSec: narrationSec,
          targetLufs: template.audio.targetLufs,
          maxTruePeakDb: template.audio.maxTruePeakDb,
          bed: bed ? { assetId: bed.id, ...(typeof bed.durationSec === "number" ? { durationSec: bed.durationSec } : {}) } : null,
          sfx,
          ambience: sound.ambience,
        })
      : null;
  if (audio && !audio.ok) {
    await recordStageError(run.id, st.id, "render", audio.issues.join(". "));
    return;
  }
  const planFor = (transitionSec: number): RenderPlan => {
    const scenes = renderParams?.elementAnimation ? buildScenePlan({ styleId: template.styleId, format: run.config.format, shots: boardShots, transitionSec, style: packStyle }) : null;
    if (scenes && !scenes.ok) return { ok: false, issues: scenes.issues };
    return buildRenderPayload({
      fontAssetId,
      format: run.config.format,
      shots: shotSpecs,
      shotAssets,
      narrationAssetId: asUuid(voiceResult.assetId),
      narrationSec,
      ...(tempo !== 1 ? { narrationTempo: tempo } : {}),
      captions,
      targetLufs: template.audio.targetLufs,
      maxShotSeconds: template.pacing.maxShotSeconds,
      runId: run.id,
      ...(captionSpec ? { captionSpec } : {}),
      ...(audio?.ok ? { audioPlan: audio.plan } : {}),
      ...(renderParams ? { engine: renderParams.engine, transitionSec } : {}),
      ...(scenes?.ok ? { scenePlan: scenes.plan } : {}),
      ...(gate ? { workerCapabilities: gate } : {}),
    });
  };
  // Fades make the shots longer by the overlaps; a storyboard planned with no room for that renders with hard cuts.
  const plan = withFadeFallback(fadeSec, planFor).result;
  if (!plan.ok) {
    await recordStageError(run.id, st.id, "render", renderStageError(plan.issues, engine));
    return;
  }
  if (design && boardOut) {
    // html-design: the page Hermes wrote travels with the job as an html-page asset (the worker serves it as page/).
    const from = await approvedPlanRow(sql, run.id, "html-design");
    const pageAssetId = await ensureRunPage(run, design, from ?? { stageId: st.id, attempt: st.attempt });
    plan.payload.page = { assetId: pageAssetId };
    plan.payload.inputs = [...plan.payload.inputs, pageAssetId];
  }
  // A run started with a style pack renders with the pack version this portal serves now (workers update to it) and
  // only on a worker that reports it. Runs started before packs keep the engine routing they had.
  const stylePack = await renderPackFor(run.config.stylePack ?? null);
  const packNote = packWaitNote(stylePack, gate);
  // Phase 4 has no animatic, so the draft stage is recorded as skipped once.
  await sql`
    INSERT INTO pipeline_stages (run_id, stage, state, attempt, output, finished_at)
    SELECT ${run.id}::uuid, 'draft', 'skipped', 1, ${json({ reason: "No animatic in Phase 4" })}::text::jsonb, now()
    WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE run_id = ${run.id} AND stage = 'draft')
  `;
  const packCap = stylePack ? `pack:${stylePack.id}@${stylePack.version}` : null;
  const preview = await previewWorkerPin(sql, run.id, packCap);
  const pin = preview.workerId;
  const jobId = await createJob({
    type: "render-video",
    payload: { ...plan.payload },
    channelId: run.channelId,
    priority: URGENT_PRIORITY,
    createdBy: null,
    // The machine that drew the approved stills takes the render, so the look the owner approved is the look that
    // ships; a machine that went away is not pinned and the card says the render may be drawn elsewhere.
    ...(pin ? { preferredWorkerId: pin } : {}),
    // Queued under the pack's capability (or, for runs without a pack, the engine's), so only a worker that can run it claims it.
    capability: renderJobCapability(plan.payload.engine, plan.payload.transitionSec, stylePack),
  });
  const music = bedPick ? bedNote(bedPick, template.audio.musicPolicy) : null;
  const starts = payloadSceneStarts(plan.payload);
  // Frozen: the payload hash and the pack that draws it. `intent.parts` travels inside the payload, so a story composed
  // from primitives is covered by the same hash as a named one — a re-render can be compared, not remembered.
  const frozen = frozenRender(plan.payload, stylePack ? { id: stylePack.id, version: stylePack.version } : null);
  await mergeStageOutput(st.id, {
    jobId,
    frozen,
    shots: plan.payload.shots.length,
    narrationSec: plan.payload.narrationSec,
    // Where each scene sits in the video that was rendered: the qc stage compares the approved stills against these.
    timeline: starts.map((start, i) => ({ start, seconds: plan.payload.shots[i]?.seconds ?? 0 })),
    ...(music ? { music } : {}),
    ...(mix.note ? { mixNote: mix.note } : {}),
    ...(stylePack ? { stylePack } : {}),
    ...(pin ? { previewWorker: pin } : {}),
    ...(preview.hadPreview && !pin
      ? { previewWorkerNote: "The stills came from a machine that is no longer taking work, so another worker draws this render; its picture can differ from the preview." }
      : {}),
    ...(packNote ? { packNote } : {}),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Preview (still frames, worker 0.11.0)

/** The newest passed attempt of a plan stage: its row id and attempt (the page asset records where it came from). */
async function approvedPlanRow(q: Q, runId: string, stage: string): Promise<{ stageId: string; attempt: number } | null> {
  const [r] = await q`SELECT id, attempt FROM pipeline_stages WHERE run_id = ${runId} AND stage = ${stage} AND state = 'passed' ORDER BY attempt DESC LIMIT 1`;
  return r ? { stageId: String(r.id), attempt: Number(r.attempt) } : null;
}

/** What the preview shows: the approved scene spec or page, as shots for the payload and lines for the card. */
async function previewPlanOf(q: Q, run: RunInfo): Promise<{ shots: Shot[]; plan: NonNullable<ReviewPayload["plan"]>; design: HtmlDesign | null } | null> {
  const recipe = runRecipeOf(run.config);
  if (recipe === "html-design") {
    const design = readHtmlDesign((await latestPassedOutput(q, run.id, "html-design"))?.result);
    return design ? { shots: htmlDesignShots(design), plan: { kind: "html-design", lines: htmlDesignLines(design), text: design.note }, design } : null;
  }
  const spec = readSceneSpec((await latestPassedOutput(q, run.id, "scene-spec"))?.result);
    // The card carries the measured build beside the story words: what the parts became, in blocks and symmetry.
  return spec ? { shots: sceneSpecShots(spec), plan: { kind: "scene-spec", lines: sceneSpecLines(spec, run.config.styleId) }, design: null } : null;
}

/** A failed check that only the owner decides on (production stages are never revised automatically). */

/**
 * The preview stage: still frames of the run's html-capture page with its real render props (the narration's length
 * when a voice exists, else the planned scene times), taken by a worker that reports preview-frames. Without such a
 * worker a scene-spec run's card says so and the owner may continue from the spec text (what the studio did before);
 * an html-design run stops with a stage error instead, because its page is never rendered without the check.
 */
async function runPreviewStage(run: RunInfo, st: StageRow, template: Template): Promise<void> {
  const sql = db();
  const existing = asUuid(st.output.jobId);
  if (existing) {
    const status = await jobStatus(existing);
    if (status === "queued" || status === "running") return;
    if (status === "succeeded" || status === "failed" || status === "cancelled") {
      await completePreview(existing);
      return;
    }
  }
  const recipe = runRecipeOf(run.config);
  const shown = await previewPlanOf(sql, run);
  if (!shown) {
    await recordStageError(run.id, st.id, "preview", `The approved ${recipe === "html-design" ? "page" : "scene spec"} is missing, so there is nothing to preview`);
    return;
  }
  if (recipe === "html-design" && !run.config.stylePack?.trial) {
    await recordStageError(run.id, st.id, "preview", "A page Hermes wrote is research only, so it is previewed and rendered only as a trial. This run is not a trial.");
    return;
  }
  const packStyle = await packStyleFor(template.styleId);
  const renderParams = renderParamsForStyle(template.styleId, packStyle);
  const engine = renderParams?.engine ?? DEFAULT_RENDER_ENGINE;
  if (engine !== "html-capture") {
    // Stills are taken of html-capture pages only (a scene-spec run may render with remotion-2d): continue from the text.
    if (recipe === "html-design") {
      await recordStageError(run.id, st.id, "preview", `A page Hermes wrote is captured by html-capture only, but this style renders with ${engine}. Nothing was previewed or rendered.`);
      return;
    }
    await concludeStage(run, st, template, {
      result: { stills: [], skipped: "engine" },
      gate: null,
      plan: { ...shown.plan, note: `Still frames are taken of html-capture pages only, and this style renders with ${engine}. You can approve and continue with the spec text only; the final video's card shows the real render.` },
    });
    return;
  }
  const stylePack = await renderPackFor(run.config.stylePack ?? null);
  const packCap = stylePack ? `pack:${stylePack.id}@${stylePack.version}` : null;
  const workers = previewWorkers(await workerCapabilityLists(sql), packCap);
  if (workers === "no-worker") {
    if (recipe === "html-design") {
      await recordStageError(run.id, st.id, "preview", HTML_DESIGN_NEEDS_PREVIEW);
      return;
    }
    await concludeStage(run, st, template, {
      result: { stills: [], skipped: "no-worker" },
      gate: null,
      plan: { ...shown.plan, note: NO_PREVIEW_CONTINUE },
      notes: [NO_PREVIEW_WORKER],
    });
    return;
  }
  const script = validateScript((await latestPassedOutput(sql, run.id, "script"))?.result);
  if (!script.ok) {
    await recordStageError(run.id, st.id, "preview", "The approved script is missing");
    return;
  }
  // The narration's timing when the run already has one (a revision after the voice), otherwise the planned scenes.
  const voiceResult = toObject((await latestPassedOutput(sql, run.id, "voice"))?.result);
  const tempo = tempoOf(voiceResult.tempo);
  const recorded = typeof voiceResult.narrationSec === "number" && voiceResult.narrationSec > 0 ? voiceResult.narrationSec / tempo : 0;
  const shotSpecs = workOrdersFromStoryboard(shown.shots).map((w) => ({ shotRef: w.shotRef, seconds: w.spec.seconds }));
  const narrationSec = recorded > 0 ? recorded : shotSpecs.reduce((n, x) => n + x.seconds, 0);
  const frame = VIDEO_FORMATS[run.config.format];
  const plate = await ensureRunPlate(run, { width: frame.width, height: frame.height });
  const shotAssets: Record<string, string> = {};
  for (const x of shotSpecs) shotAssets[x.shotRef] = plate;
  const [font] = await sql`SELECT id FROM assets WHERE kind = 'font' AND storage_path IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
  let caps: string[] | null = null;
  try {
    const rows = (await sql`SELECT DISTINCT unnest(capabilities) AS cap FROM workers WHERE status <> 'revoked'`) as unknown as Array<{ cap: unknown }>;
    caps = rows.map((r) => String(r.cap)).filter(Boolean);
  } catch {
    caps = null;
  }
  const fadeSec = transitionForWorker(caps, shotSpecs.map((x) => x.seconds));
  const planFor = (transitionSec: number): RenderPlan => {
    const scenes = renderParams?.elementAnimation ? buildScenePlan({ styleId: template.styleId, format: run.config.format, shots: shown.shots, transitionSec, style: packStyle }) : null;
    if (scenes && !scenes.ok) return { ok: false, issues: scenes.issues };
    return buildRenderPayload({
      fontAssetId: font ? asUuid(font.id) : null,
      format: run.config.format,
      shots: shotSpecs,
      shotAssets,
      narrationAssetId: PREVIEW_NARRATION_PLACEHOLDER,
      narrationSec,
      captions: captionLines(script.value.script),
      targetLufs: template.audio.targetLufs,
      maxShotSeconds: template.pacing.maxShotSeconds,
      runId: run.id,
      engine,
      transitionSec,
      ...(scenes?.ok ? { scenePlan: scenes.plan } : {}),
    });
  };
  const plan = withFadeFallback(fadeSec, planFor).result;
  if (!plan.ok) {
    await recordStageError(run.id, st.id, "preview", `The still frames could not be planned: ${plan.issues.join(". ")}`.slice(0, 500));
    return;
  }
  const pageAssetId = shown.design ? await ensureRunPage(run, shown.design, (await approvedPlanRow(sql, run.id, "html-design")) ?? { stageId: st.id, attempt: st.attempt }) : null;
  const times = previewTimes(payloadSceneStarts(plan.payload), plan.payload.durationSec);
  const jobId = await createJob({
    type: "preview-frames",
    payload: previewPayload(plan.payload, times, pageAssetId),
    channelId: run.channelId,
    priority: URGENT_PRIORITY,
    createdBy: null,
    // Only a worker that has this pack version (and runs preview-frames, 0.11.0+) takes it.
    ...(packCap ? { capability: packCap as `pack:${string}` } : {}),
  });
  await mergeStageOutput(st.id, {
    jobId,
    times,
    narrationTiming: recorded > 0 ? "narration" : "planned",
    ...(pageAssetId ? { pageAssetId } : {}),
    ...(stylePack ? { stylePack } : {}),
    ...(workers === "waiting-pack" ? { packNote: `Waiting for a worker with ${packCap}: workers install it with their next signed update.` } : {}),
  });
}

/** Concludes the preview stage from its finished job: the stills on the card, or why there are none. */
async function completePreview(jobId: string): Promise<boolean> {
  const job = await loadJob(jobId);
  if (!job || job.type !== "preview-frames") return false;
  const runId = asUuid(job.payload.runId);
  if (!runId) return false;
  const waiting = await stageWaitingOn(runId, "preview", jobId);
  if (!waiting) return false;
  const { run, template, st } = waiting;
  const shown = await previewPlanOf(db(), run);
  const designed = runRecipeOf(run.config) === "html-design";
  const plan = shown?.plan;
  if (job.status !== "succeeded") {
    const why = job.status === "cancelled" ? "the job was cancelled" : job.error || "the worker gave no reason";
    // Preview stops the run, it does not ask the owner to approve anyway: a page that cannot be photographed here
    // fails the render the same way, and the render costs ten minutes to find out. Retry, or a note back to the plan.
    const issue = `The still frames could not be taken: ${why}`.slice(0, 600);
    await concludeStage(run, st, template, {
      result: { jobId, stills: [], failed: why.slice(0, 500) },
      gate: null,
      extra: { jobId },
      issues: [issue],
      block: `${issue}. The run does not go on to the voice and the video. Retry the preview, or send a note back to the ${designed ? "page" : "scene spec"}.`,
      ...(plan ? { plan: { ...plan, note: "Retry the preview, or send a note back to this plan and the stills are taken again." } } : {}),
    });
    return true;
  }
  const r = parsePreviewResult(job.result);
  const rows = await db()`SELECT id, name FROM artifacts WHERE job_id = ${jobId} AND name LIKE 'still-%' ORDER BY name LIMIT 12`;
  const stills = rows.flatMap((a) => {
    const at = r.stills.find((x) => x.name === String(a.name));
    return at ? [{ artifactId: String(a.id), atSec: at.atSec }] : [];
  });
  const issues = [
    ...(stills.length === 0 ? ["The worker finished but sent no still frames back"] : []),
    ...r.blocked.slice(0, 5).map((b) => `The page tried something the sandbox blocks: ${b}. The render would fail.`),
  ];
  // No still, or a page that tried what the sandbox blocks: the render would fail, so the run stops here.
  const block = issues.length > 0 ? `${issues.join(" ")} The run does not go on to the voice and the video. Retry the preview, or send a note back to the ${designed ? "page" : "scene spec"}.` : null;
  await concludeStage(run, st, template, {
    result: { jobId, stills, page: r.page, consoleErrors: r.consoleErrors, blocked: r.blocked, ...(toObject(job.payload.preview).page ? { pageAssetId: toObject(job.payload.preview).page } : {}) },
    gate: null,
    extra: { jobId },
    media: { stills },
    notes: [
      ...previewNotes({ consoleErrors: r.consoleErrors, blocked: [] }),
      ...(r.stopped
        ? [`The worker stopped drawing frames early (${r.stopped}), so this card shows ${stills.length} of ${r.planned ?? stills.length} stills. The final render still draws every frame.`]
        : []),
    ],
    ...(plan ? { plan: { ...plan, note: previewNote({ stills: stills.length, drawsCaptions: r.drawsCaptions, designed }) } } : {}),
    ...(block ? { issues, block } : {}),
  });
  return true;
}

/**
 * Renderer hermes (research only, owner decision): the portal sends Hermes the storyboard, the scene plan, the media
 * host URLs of the pictures and the narration, and the pack's contract, through the Hermes gate; Hermes renders with
 * its own tools and answers with a /clip/ URL. The clip is checked like any Hermes clip, stored as a video asset with
 * renderer hermes and its backend and plugin in the provenance, and the stage concludes like a worker render, so the
 * quality check, the Review card and the curation log are the same. A run that is not a trial is refused, by name.
 */
async function runHermesRenderStage(
  run: RunInfo,
  st: StageRow,
  template: Template,
  i: {
    style: Style | undefined;
    shots: readonly Shot[];
    shotRefs: readonly string[];
    captions: string[];
    voiceResult: Record<string, unknown>;
    shotAssets: Record<string, string>;
    transitionSec: number;
    /** hermes-skill workflow: the approved skill brief the skill renders from. Null: the storyboard and pictures. */
    brief?: SkillBrief | null;
    script?: string;
  },
): Promise<void> {
  const sql = db();
  const pack = run.config.stylePack ?? null;
  if (!pack || !pack.trial) {
    await recordStageError(run.id, st.id, "render", "A Hermes render is research only, so it runs only as a trial of its style pack. This run is not a trial; nothing was rendered.");
    return;
  }
  const frame = VIDEO_FORMATS[run.config.format];
  const scenes = buildScenePlan({ styleId: template.styleId, format: run.config.format, shots: [...i.shots], transitionSec: i.transitionSec, style: i.style });
  // A research pack that names a Hermes skill (style.json hermes): the request names it, and the provenance records it.
  const skillOf = (await registryEntry(pack.id).catch(() => undefined))?.pack?.hermes ?? null;
  const skill = skillOf ? { name: skillOf.skill, aliases: [...skillOf.aliases], mode: skillOf.mode, input: skillOf.input, output: skillOf.output } : null;
  const narrationId = asUuid(i.voiceResult.assetId);
  // A fitted narration plays at its tempo, as on the worker path: the video is planned for the played length.
  const tempo = tempoOf(i.voiceResult.tempo);
  const rawNarrationSec = typeof i.voiceResult.narrationSec === "number" ? i.voiceResult.narrationSec : 0;
  const narrationSec = tempo !== 1 ? rawNarrationSec / tempo : rawNarrationSec;
  const ids = [...new Set([...Object.values(i.shotAssets), ...(narrationId ? [narrationId] : [])].filter((x) => asUuid(x) !== null))];
  const rows = ids.length > 0 ? await sql`SELECT id, origin_url FROM assets WHERE id = ANY(${ids}::uuid[])` : [];
  const trusted = hermesTrustedOrigins();
  const urlOf = new Map(rows.map((r) => [String(r.id), mediaHostUrl(text(r.origin_url), trusted)] as const));
  const shots = i.shots.map((s, k) => {
    const ref = i.shotRefs[k] ?? `shot-${String(k + 1).padStart(2, "0")}`;
    const assetId = i.shotAssets[ref];
    return {
      shotRef: ref,
      seconds: s.seconds,
      beatRole: s.beatRole,
      description: s.description,
      imageUrl: assetId ? (urlOf.get(assetId) ?? null) : null,
    };
  });
  const durationSec = narrationSec > 0 ? narrationSec : shots.reduce((a, s) => a + s.seconds, 0);
  // A skill that voices itself (hermes.voice skill): the run has no voice stage, the skill records from the script.
  const brief = i.brief ?? null;
  const skillVoice = brief !== null && !runStagesOf(run.config).includes("voice");
  // Every other hermes render uses the run's own narration, which Hermes cannot read: a worker lays it on Hermes's
  // picture afterwards (hermes-mux.ts), so Hermes is asked for the picture and the captions only.
  const mux = skillVoice ? null : narrationId && narrationSec > 0 ? { narrationId, narrationSec, tempo } : null;
  const scale = hermesTimeoutScale(process.env);
  const fin: RenderFinish = { run, st, template, pack, frame, durationSec, skill: skill?.name ?? null, brief, skillVoice, mux };
  // Worker first: a Muse worker draws this video, whatever the run asked for. The portal keeps the render only when
  // the owner said so (executors.render = "hermes", research only) or when no Muse renderer is ready — and then the
  // stage says so in its own words, instead of quietly rendering in the portal as it used to.
  const choice = renderExecutor(run.config.executors);
  if (choice !== "hermes") {
    const ready = choice === "muse" ? null : await museRenderReadiness(pack.id);
    const route = renderRoute(run.config.executors, ready ? { skill: ready.skill !== null, refusals: ready.refusals } : null);
    if (route.route === "muse") {
      await runMuseRender(fin, { skill, brief, captions: i.captions, script: i.script ?? "", narrationId, narrationSec });
      return;
    }
    if (route.note) await mergeStageOutput(st.id, { renderNote: route.note });
  }
  let job = readRenderJob(st.output.hermesRender);
  // Started (the start ask was sent): never ask again, wait for the file. Also after a restart or a reaper resume.
  if (job?.askedAt) {
    await pollHermesRender(fin, job, scale);
    return;
  }
  if (!skillVoice && !mux) {
    await recordStageError(run.id, st.id, "render", "This run has no recorded narration to add to Hermes's video, so the video would be silent. Record the voice again (send a revision to the voice step), then render. Nothing was rendered.");
    return;
  }
  // Checked before Hermes is asked: without a worker that adds the narration, the render would only make a silent video.
  if (mux) {
    const why = muxWorkerIssue(await workerCapabilityLists(sql));
    if (why) {
      await recordStageError(run.id, st.id, "render", why);
      return;
    }
  }
  const base = renderFileBase();
  if (!base) {
    await recordStageError(run.id, st.id, "render", "Hermes is not set up (no HERMES_BASE_URL or media host), so the studio cannot say where the video goes. Nothing was rendered.");
    return;
  }
  // A revision of a Hermes video: the owner's note and the previous file go to Hermes with the new attempt.
  const ownerNote = text(st.output.ownerNote).trim();
  const previousFile = ownerNote ? await previousRenderFile(sql, run.id, st.attempt) : null;
  const fresh = !job;
  job ??= newRenderJob({ file: renderFileName(run.id, st.attempt, randomBytes(5).toString("hex")), base, attempt: st.attempt, skill: skill?.name ?? null, budgetMin: renderBudgetMinutes(skillOf), nowMs: Date.now() });
  job = { ...job, askedAt: new Date().toISOString() };
  // Stored before the ask: a restart while Hermes works waits for this file instead of asking again. A render from
  // before render jobs (the old one-turn ask, "slow, retrying") starts here once, with a fresh clock.
  await sql`
    UPDATE pipeline_stages
    SET output = (output - ${fresh ? ["slowStreak", "waitSince", "hermesWait"] : ["hermesWait"]}::text[]) || ${json({ renderer: "hermes", hermesRender: job })}::text::jsonb
    WHERE id = ${st.id} AND state = 'running'
  `;
  const asked = await askRenderStart(
    {
      topic: run.topic,
      format: run.config.format,
      width: frame.width,
      height: frame.height,
      fps: frame.fps,
      durationSec,
      shots,
      scenePlan: scenes.ok ? scenes.plan : null,
      narration: { url: narrationId ? (urlOf.get(narrationId) ?? null) : null, seconds: narrationSec, tempo },
      captions: i.captions,
      packId: pack.id,
      packVersion: pack.version,
      contract: await packContract(pack.id),
      skill,
      ...(brief ? { brief: { skill: brief.skill, format: brief.format, shots: brief.shots, ...(brief.text ? { text: brief.text } : {}) } } : {}),
      ...(skillVoice ? { voice: "skill" as const, script: i.script ?? "" } : {}),
      ...(mux ? { audioBy: "studio" as const } : {}),
      ...(ownerNote ? { revision: { note: ownerNote, previousFile } } : {}),
    },
    { file: job.file, url: job.url },
  );
  const notTaken = async (until: Date, error: string) => {
    // Hermes did not take the request (rate limited, the gate busy, not reached): the same file is asked for later,
    // up to the same 3-hour cap as every other wait for Hermes.
    if (job) await mergeStageOutput(st.id, { hermesRender: { ...job, askedAt: null } });
    if (waitExpired(fresh ? null : st.output.waitSince, Date.now())) {
      await recordStageError(run.id, st.id, "render", `${giveUpMessage()} Hermes could not start the render: ${error}`);
      return;
    }
    await deferStage(run.id, st.id, until, error);
  };
  if (!asked.ok) {
    if (asked.slow) {
      // Hermes took the request and is still working on it: it is rendering. Never asked again; the file is awaited.
      job = { ...job, reply: { status: "unclear", file: job.file, url: job.url, note: `Hermes did not answer the start ask within ${durationText(asked.slow.afterMs)}; it is taken as rendering`, provider: "", backend: "", model: "", voice: null } };
      await waitForRenderFile(fin, job, Date.now() + renderPollEveryMs(0, scale), scale);
      return;
    }
    if (asked.cause === "busy" || asked.cause === "unreachable") {
      await notTaken(asked.busyUntil ?? new Date(Date.now() + slowBackoffMs(1, scale)), asked.error);
      return;
    }
    await mergeStageOutput(st.id, { hermesRender: job });
    await recordStageError(run.id, st.id, "render", `Hermes could not start the render: ${asked.error}`);
    return;
  }
  const reply = asked.reply;
  if (reply.status === "error" && looksRateLimited(reply.note)) {
    await notTaken(new Date(Date.now() + slowBackoffMs(1, scale)), `Hermes said it is rate limited: ${reply.note}`);
    return;
  }
  job = applyStartReply(job, reply);
  if (reply.status === "error") {
    await mergeStageOutput(st.id, { hermesRender: job });
    await recordStageError(run.id, st.id, "render", `Hermes could not render the video: ${reply.note || "it gave no reason"}`);
    return;
  }
  // Done already (a quick skill, or a Hermes that renders within the turn): take the file now. Else the first look
  // is in a minute.
  if (job.doneReported) await pollHermesRender(fin, job, scale);
  else await waitForRenderFile(fin, job, Date.now() + renderPollEveryMs(0, scale), scale);
}

/** What finishing a hermes render needs, worked out once per pass. */
interface RenderFinish {
  run: RunInfo;
  st: StageRow;
  template: Template;
  pack: RunStylePack;
  frame: { width: number; height: number; fps: number };
  durationSec: number;
  skill: string | null;
  brief: SkillBrief | null;
  skillVoice: boolean;
  /** The run's narration, laid on Hermes's picture by a hermes-mux job (hermes-mux.ts). Null: Hermes's own audio. */
  mux: { narrationId: string; narrationSec: number; tempo: number } | null;
}

/**
 * The render on Muse (agent-task, stage render, worker 0.16.0+): the skill, the brief, the contract and the narration go
 * to the inbox, the stage waits for out/video.mp4 without holding a Hermes slot, and the video then goes the way a
 * Hermes picture goes: stored, the narration laid on by a hermes-mux job, then the quality check.
 */
async function runMuseRender(
  f: RenderFinish,
  i: {
    skill: { name: string; aliases: string[]; mode: string; input: string; output: string } | null;
    brief: SkillBrief | null;
    captions: string[];
    script: string;
    narrationId: string | null;
    narrationSec: number;
  },
): Promise<void> {
  const { run, st, frame } = f;
  const sql = db();
  const wait = async (jobId: string, text: string, sec: number) => {
    const until = new Date(Date.now() + sec * 1000);
    await deferRenderPoll(run.id, st.id, until, { museJobId: jobId, renderer: "muse" }, { until: until.toISOString(), text });
  };
  const existing = asUuid(st.output.museJobId);
  if (existing) {
    const state = await pollMuseRender(existing);
    if (state.kind === "wait") return wait(existing, state.text, state.pollSec);
    if (state.kind === "error") return recordStageError(run.id, st.id, "render", state.error);
    await finishHermesRender(f, {
      bytes: state.bytes,
      info: state.info,
      provider: "muse-agent",
      backend: "muse",
      plugin: i.skill?.name ?? "",
      model: "",
      originUrl: "",
      voice: null,
      by: "muse",
    });
    return;
  }
  if (!f.mux || !i.narrationId) {
    await recordStageError(run.id, st.id, "render", "This run has no recorded narration, so Muse's video would be silent. Record the voice again (send a revision to the voice step), then render. Nothing was rendered.");
    return;
  }
  const why = muxWorkerIssue(await workerCapabilityLists(sql));
  if (why) {
    await recordStageError(run.id, st.id, "render", why);
    return;
  }
  // The skill comes from venstudio-styles skills/ (curated or candidate); only a worker that installed it may render.
  const ready = await museRenderReadiness(f.pack.id);
  if (ready.refusals.length > 0 || !ready.skill) {
    await recordStageError(run.id, st.id, "render", `Muse cannot render this video: ${ready.refusals.join(". ")}`);
    return;
  }
  const [n] = await sql`SELECT content_type FROM assets WHERE id = ${i.narrationId}`;
  const type = text(n?.content_type);
  const ext = type === "audio/mpeg" ? "mp3" : type === "audio/ogg" ? "ogg" : "wav";
  const ownerNote = text(st.output.ownerNote).trim();
  const jobId = await startMuseRender({
    runId: run.id,
    skillRef: ready.skill,
    channelId: run.channelId,
    project: run.topic || "VenStudio video",
    width: frame.width,
    height: frame.height,
    fps: frame.fps,
    durationSec: f.durationSec,
    narration: { assetId: i.narrationId, ext, seconds: i.narrationSec },
    captions: i.captions,
    script: i.script,
    skill: i.skill,
    brief: i.brief ? { format: i.brief.format, shots: i.brief.shots, ...(i.brief.text ? { text: i.brief.text } : {}) } : null,
    contract: await packContract(f.pack.id),
    ...(ownerNote ? { ownerNote } : {}),
  });
  return wait(jobId, "Waiting for a Muse worker to take the render", MUSE_POLL_SEC);
}

/** The file the newest earlier render attempt of this run asked Hermes for, or null. */
async function previousRenderFile(q: Q, runId: string, attempt: number): Promise<string | null> {
  // A finished stage's output is replaced by its conclusion, so the job is gone; its result keeps the clip's URL.
  const [r] = await q`
    SELECT coalesce(output->'hermesRender'->>'file', output->'result'->>'originUrl') AS file FROM pipeline_stages
    WHERE run_id = ${runId} AND stage = 'render' AND attempt < ${attempt}
      AND coalesce(output->'hermesRender'->>'file', output->'result'->>'originUrl') IS NOT NULL
    ORDER BY attempt DESC LIMIT 1
  `;
  if (!r || typeof r.file !== "string" || !r.file) return null;
  // The bare file name, whether the row held the name or the full media-host URL.
  const name = r.file.split("?")[0].split("/").pop() ?? "";
  return /^[\w.-]{1,200}$/.test(name) ? name : null;
}

/** The stage waits as pending until `untilMs`, with the job and the "rendering" status stored. No gate slot is held. */
async function waitForRenderFile(f: RenderFinish, job: RenderJob, untilMs: number, scale: number): Promise<void> {
  const every = renderPollEveryMs(job.polls, scale);
  await deferRenderPoll(f.run.id, f.st.id, new Date(untilMs), { renderer: "hermes", hermesRender: job }, renderingWait(job, every));
}

/**
 * One pass of the wait: look for the file on the media host, and take it when it is complete. Past the budget, Hermes
 * is asked once whether it is still rendering; then the stage fails with Retry (a new render, a new file name). The
 * render is never started again from here.
 */
async function pollHermesRender(f: RenderFinish, start: RenderJob, scale: number): Promise<void> {
  const { run, st } = f;
  let job = start;
  const fail = async (j: RenderJob, reason: string) => {
    await mergeStageOutput(st.id, { hermesRender: j });
    await recordStageError(run.id, st.id, "render", reason);
  };
  // At most a look, a check ask and a second look in one pass.
  for (let pass = 0; pass < 3; pass++) {
    const looked = await probeRender(job.url);
    const step = renderPollStep(job, looked.probe, Date.now(), scale);
    if (step.action === "wait") return waitForRenderFile(f, step.job, step.untilMs, scale);
    if (step.action === "fail") return fail(step.job, step.reason);
    if (step.action === "check") {
      const c = await askRenderCheck(step.job, { voice: f.skillVoice, why: "overdue" });
      if (c.ok) {
        job = applyCheckReply(step.job, c.reply, Date.now());
        continue;
      }
      if (c.slow) {
        // Asked, but no answer within the check timeout: the next look decides.
        job = { ...step.job, checkAskedAt: new Date().toISOString(), checkReply: null };
        continue;
      }
      // Not asked (Hermes busy or not reached): look again later and ask then, within the grace time.
      return waitForRenderFile(f, { ...step.job, checkTries: step.job.checkTries + 1 }, Date.now() + renderPollEveryMs(step.job.polls, scale), scale);
    }
    // The file is complete (same size twice, or Hermes said done): download and check the real bytes.
    const got = looked.bytes ? checkRenderBytes(looked.bytes) : await downloadRender(step.job.url);
    if (!got.ok) {
      const next = renderFetchFailed(step.job, got.issue, Date.now(), scale);
      if (next.action === "fail") return fail(next.job, next.reason);
      return waitForRenderFile(f, next.job, next.action === "wait" ? next.untilMs : Date.now() + renderPollEveryMs(next.job.polls, scale), scale);
    }
    job = step.job;
    // A skill that recorded its own voice must say with what, so the narration's provenance and terms are known.
    let voice = job.reply?.voice ?? job.checkReply?.voice ?? null;
    let told: RenderReply | null = null;
    if (f.skillVoice && !voice) {
      if (job.voiceAsks >= RENDER_VOICE_ASKS) {
        return fail(job, `Hermes rendered ${job.file} but did not say which voice backend recorded the narration, so its provenance and terms are unknown. Retry starts a new render.`);
      }
      const c = await askRenderCheck(job, { voice: true, why: "provenance" });
      // Hermes busy (the ask was not made): ask again after the busy time, without counting it.
      if (!c.ok && c.cause === "busy" && !c.slow) return waitForRenderFile(f, job, (c.busyUntil?.getTime() ?? Date.now()) + 1000, scale);
      job = { ...job, voiceAsks: job.voiceAsks + 1 };
      if (c.ok) {
        told = c.reply;
        voice = c.reply.voice;
      }
      if (!voice) {
        return job.voiceAsks >= RENDER_VOICE_ASKS
          ? fail(job, `Hermes rendered ${job.file} but did not say which voice backend recorded the narration, so its provenance and terms are unknown. Retry starts a new render.`)
          : waitForRenderFile(f, job, Date.now() + renderPollEveryMs(job.polls, scale), scale);
      }
    }
    const maker = renderMaker([told, job.checkReply, job.reply]);
    await mergeStageOutput(st.id, { hermesRender: { ...job, finishedAt: new Date().toISOString() } });
    await finishHermesRender(f, { bytes: got.bytes, info: got.info, provider: maker.provider, backend: maker.backend, plugin: maker.plugin, model: maker.model, originUrl: job.url, voice });
    return;
  }
  // Three passes without a decision cannot happen (the second look after a check always decides); wait to be safe.
  return waitForRenderFile(f, job, Date.now() + renderPollEveryMs(job.polls, scale), scale);
}

/**
 * Queues the hermes-mux job that lays the run's narration (and its mix: bed, ambience, accents, mastered loudness) on
 * Hermes's picture, on a worker that reports hermes-mux. The stage waits on the job like a worker render; completeRender
 * stores the result as the run's video. With no such worker it stops with a stage error naming the fix: a silent
 * video is never concluded.
 */
async function queueHermesMux(
  f: RenderFinish,
  made: { saved: { assetId: string; provider: string }; v: HermesRender; result: Record<string, unknown> },
): Promise<void> {
  const { run, st, template, frame } = f;
  const mux = f.mux as NonNullable<RenderFinish["mux"]>;
  const sql = db();
  const clip = {
    assetId: made.saved.assetId,
    provider: made.saved.provider,
    backend: made.v.backend,
    plugin: made.v.plugin,
    model: made.v.model,
    originUrl: made.v.originUrl,
    hermesSkill: f.skill,
    ...(made.v.by === "muse" ? { by: "muse" } : {}),
  };
  const why = muxWorkerIssue(await workerCapabilityLists(sql));
  if (why) {
    await mergeStageOutput(st.id, { hermesClip: clip });
    await recordStageError(run.id, st.id, "render", why);
    return;
  }
  const sound = run.config.sound ?? DEFAULT_SOUND;
  const bedPick = await pickRunBed(sql, run, template, mux.narrationId, sound.bed);
  const bed = bedPick.bed;
  // The mux path has no shot list of its own — the picture arrived as one rendered clip — so no accents are placed
  // here. The bed and the ambience are still the owner's choice, and both are mixed.
  const audio = buildAudioPlan({
    policy: template.audio.musicPolicy,
    narrated: template.audio.narrated,
    durationSec: mux.narrationSec,
    targetLufs: template.audio.targetLufs,
    maxTruePeakDb: template.audio.maxTruePeakDb,
    bed: bed ? { assetId: bed.id, ...(typeof bed.durationSec === "number" ? { durationSec: bed.durationSec } : {}) } : null,
    ambience: sound.ambience,
  });
  if (!audio.ok) {
    await mergeStageOutput(st.id, { hermesClip: clip });
    await recordStageError(run.id, st.id, "render", audio.issues.join(". "));
    return;
  }
  const payload = hermesMuxPayload({
    runId: run.id,
    format: run.config.format,
    width: frame.width,
    height: frame.height,
    fps: frame.fps,
    pictureAssetId: made.saved.assetId,
    narrationAssetId: mux.narrationId,
    narrationSec: mux.narrationSec,
    tempo: mux.tempo,
    targetLufs: template.audio.targetLufs,
    audio: audio.plan,
  });
  const jobId = await createJob({
    type: "render-video",
    payload,
    channelId: run.channelId,
    priority: URGENT_PRIORITY,
    createdBy: null,
    // Only a worker whose code runs engine hermes-mux (0.13.0+) reports this, so no older worker can claim it.
    capability: HERMES_MUX_CAPABILITY,
  });
  const music = bedNote(bedPick, template.audio.musicPolicy);
  await mergeStageOutput(st.id, { jobId, hermesClip: clip, hermesResult: made.result, ...(music ? { music } : {}) });
}

/** Stores the clip as the run's video (research only, with its provenance) and concludes the stage like a worker render. */
async function finishHermesRender(f: RenderFinish, v: HermesRender): Promise<void> {
  const { run, st, template, pack, frame, durationSec, brief } = f;
  const sql = db();
  const skill = f.skill ? { name: f.skill } : null;
  // With the run's narration laid on afterwards, any voice Hermes names is not in the video (its audio is dropped).
  if (f.mux) v = { ...v, voice: null };
  const maker = v.by === "muse" ? "Muse" : "Hermes";
  const saved = await saveGeneratedAsset({
    bytes: v.bytes,
    name: `${v.by === "muse" ? "muse" : "hermes"}-render.${v.info.mime === "video/webm" ? "webm" : v.info.mime === "video/quicktime" ? "mov" : "mp4"}`,
    contentType: v.info.mime,
    kind: "video",
    executor: v.by === "muse" ? "muse-agent" : "hermes-render",
    title: f.mux ? `${run.topic || "Video"} (${maker} picture, research only)` : `${run.topic || "Video"} (${maker} render, research only)`,
    provider: v.provider,
    backend: v.backend,
    plugin: v.plugin,
    model: v.model,
    originUrl: v.originUrl,
    runId: run.id,
    channelId: run.channelId,
    hermesSkill: skill?.name ?? null,
    ...(brief
      ? {
          basis: v.voice
            ? `this run's skill brief and script, voiced by the skill with ${v.voice.backend}${v.voice.model ? ` (${v.voice.model})` : ""}`
            : "this run's skill brief and narration",
          narration: v.voice ? { by: "hermes-skill" as const, provider: v.voice.provider, backend: v.voice.backend, model: v.voice.model } : null,
        }
      : {}),
  });
  await sql`
    INSERT INTO pipeline_stages (run_id, stage, state, attempt, output, finished_at)
    SELECT ${run.id}::uuid, 'draft', 'skipped', 1, ${json({ reason: "No animatic in Phase 4" })}::text::jsonb, now()
    WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE run_id = ${run.id} AND stage = 'draft')
  `;
  const result = {
    assetId: saved.assetId,
    renderer: v.by === "muse" ? "muse" : "hermes",
    // The planned length; the quality check measures the real one.
    durationSec: Math.round(durationSec * 100) / 100,
    width: frame.width,
    height: frame.height,
    provider: saved.provider,
    backend: v.backend,
    plugin: v.plugin,
    hermesSkill: skill?.name ?? null,
    originUrl: v.originUrl,
    captionsBurned: true,
    captionNote: `${maker} drew the captions with the skill's tools`,
    music: "",
    stylePack: pack,
    researchOnly: true,
    sceneStarts: [] as number[],
    ...(brief ? { workflow: "hermes-skill", brief: true } : {}),
    ...(v.voice ? { narrationBy: { by: "hermes-skill", provider: v.voice.provider, backend: v.voice.backend, model: v.voice.model } } : {}),
  };
  if (f.mux) {
    await queueHermesMux(f, { saved, v, result });
    return;
  }
  if (v.voice) {
    // The skill's own voice is a voice like any other: its backend is a provider row, and its terms gate the narration.
    const name = normalizeProvider(v.voice.backend || v.voice.provider);
    await ensureProvider(name, "tts");
    const base: GateResult = { gate: "G-voice", passed: true, issues: [], executor: "hermes-skill" };
    const gate = addGateIssues(base, providerTermsIssues([{ title: "Narration (recorded by the skill)", provider: name, kind: "tts" }], await listProviderTerms()));
    await concludeStage(run, st, template, {
      result,
      gate,
      extra: { renderer: "hermes" },
      media: { videoAssetId: saved.assetId, voiceProvider: name },
      providers: [{ name, kind: "tts", count: 1 }],
    });
    return;
  }
  await concludeStage(run, st, template, { result, gate: null, extra: { renderer: "hermes" }, media: { videoAssetId: saved.assetId } });
}

/** The pack version a run renders with: the vendored one with the run's pack id, else what the run started with. */
async function renderPackFor(started: RunStylePack | null): Promise<RunStylePack | null> {
  if (!started) return null;
  const entry = await registryEntry(started.id).catch(() => undefined);
  if (!entry?.pack) return started;
  // The run stays what it was started as: a trial (a lab study's run) and a lab trial keep their marks.
  const fresh = runStylePack(entry.pack, { lab: started.lab === true });
  return { ...fresh, trial: fresh.trial || started.trial };
}

/** The style of a pack the catalogue does not know (derived from its contract), or undefined for a catalogue style. */
async function packStyleFor(styleId: string): Promise<Style | undefined> {
  if (STYLE_BY_ID[styleId]) return undefined;
  const entry = await registryEntry(styleId).catch(() => undefined);
  return entry?.pack && entry.style ? entry.style : undefined;
}

/** Every narration this run recorded: the current voice result and every earlier voice attempt. */
async function runNarrationIds(q: Q, runId: string, current: string | null): Promise<string[]> {
  const rows = await q`SELECT output->'result'->>'assetId' AS id FROM pipeline_stages WHERE run_id = ${runId} AND stage = 'voice'`;
  const ids = rows.map((r) => asUuid(r.id)).filter((x): x is string => x !== null);
  return [...new Set([...(current ? [current] : []), ...ids])];
}

/**
 * The music bed for a run, by the rule in music-bed.ts. Only rows tagged as music are read; the rest of the rule
 * (never speech, the template's policies, provenance, provider terms, channel) is pure code with its own tests.
 */
async function pickRunBed(q: Q, run: RunInfo, template: Template, narrationId: string | null, choice: BedChoice = "auto"): Promise<BedPick> {
  // The owner's word beats the library's: "none" is a decision, and a named track is judged by the same rules as any
  // other bed (licence, confirmed terms, never the narration) — it just has one candidate instead of fifty.
  if (choice === "none") return { bed: null, skipped: [{ title: "this run", reason: "the owner chose no music" }] };
  const rows = await q`
    SELECT id, title, kind, source, license, origin_url, tags, channel_id, storage_path IS NOT NULL AS has_file, metadata
    FROM assets
    WHERE kind = 'audio' AND ${MUSIC_TAG} = ANY(tags)
    ORDER BY created_at DESC
    LIMIT 50
  `;
  const candidates = rows.map((r): BedCandidate => {
    const meta = toObject(r.metadata);
    const seconds = typeof meta.durationSec === "number" && Number.isFinite(meta.durationSec) && meta.durationSec > 0 ? meta.durationSec : null;
    return {
      id: String(r.id),
      title: text(r.title),
      kind: r.kind as AssetKind,
      source: r.source as AssetSource,
      license: text(r.license),
      originUrl: text(r.origin_url),
      tags: Array.isArray(r.tags) ? (r.tags as unknown[]).filter((t): t is string => typeof t === "string") : [],
      provider: text(meta.provider),
      providerKind: text(meta.providerKind),
      runId: asUuid(meta.runId),
      channelId: asUuid(r.channel_id),
      hasFile: r.has_file === true,
      durationSec: seconds,
    };
  });
  const pool = choice === "auto" ? candidates : candidates.filter((c) => c.id === choice);
  if (choice !== "auto" && pool.length === 0) return { bed: null, skipped: [{ title: choice, reason: "the chosen track is not in the library, or has no file" }] };
  return pickMusicBed(pool, {
    template,
    runId: run.id,
    channelId: run.channelId,
    narrationAssetIds: await runNarrationIds(q, run.id, narrationId),
    providerTerms: await listProviderTerms(),
  });
}

/** Music tracks the library can offer as a bed, newest first. Stored rows only: the form never waits on a worker. */
export async function listBedTracks(): Promise<Array<{ id: string; title: string }>> {
  const rows = await db()`
    SELECT id, title FROM assets
    WHERE kind = 'audio' AND 'music' = ANY(tags) AND storage_path IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 50
  `;
  return rows.map((r) => ({ id: String(r.id), title: String(r.title) }));
}


/**
 * Bookkeeping for the library, and nothing else. A run that asked for a bed and found none, or for a riser the library has
 * never had, leaves a need behind so the next find run looks for that — which is how the collection grows with use instead
 * of by guesswork. Never throws: a render does not fail because its bookkeeping did.
 */
async function noteMissingSound(
  record: typeof recordNeeds,
  i: {
    bed: unknown;
    bedChoice: string;
    cues: ReadonlyArray<{ tag: string }>;
    sfxAssets: ReadonlyArray<SfxAsset>;
    ambience: boolean | string;
  },
): Promise<void> {
  const needs: Array<{ assetClass: "music" | "sfx" | "ambience"; tag: string; reason: string }> = [];
  if (!i.bed && i.bedChoice === "auto") {
    needs.push({ assetClass: "music", tag: "bed", reason: "A run asked for a bed and the library had no music track it could use." });
  }
  const tags = [...new Set(i.cues.map((c) => c.tag))];
  for (const tag of tags) {
    const covered = i.sfxAssets.some((a) => a.tags.includes(tag));
    if (!covered) needs.push({ assetClass: "sfx", tag, reason: `A cue needed a ${tag} and the library had none, so it was dropped.` });
  }
  if (i.ambience && typeof i.ambience === "string") {
    needs.push({ assetClass: "ambience", tag: i.ambience, reason: `A scene asked for ${i.ambience} atmosphere and the library had none.` });
  }
  if (needs.length > 0) await record(needs);
}

/** Accent files the library holds: tagged `sfx`, with a stored file. Cue tags (whoosh, impact, riser) are tags too. */
async function pickSfxLibrary(q: Q): Promise<SfxAsset[]> {
  const rows = await q`
    SELECT id, tags FROM assets
    WHERE kind = 'audio' AND 'sfx' = ANY(tags) AND storage_path IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 200
  `;
  return rows.map((r) => ({
    id: String(r.id),
    tags: Array.isArray(r.tags) ? (r.tags as unknown[]).filter((t): t is string => typeof t === "string") : [],
  }));
}

interface FinishedJob {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  error: string;
  /** The worker that finished it (kept on a succeeded job), and its name. */
  workerId: string;
  workerName: string;
}

async function loadJob(jobId: string): Promise<FinishedJob | null> {
  const [j] = await db()`
    SELECT j.id, j.type, j.status, j.payload, j.result, j.error, j.worker_id, w.name AS worker_name
    FROM jobs j LEFT JOIN workers w ON w.id = j.worker_id WHERE j.id = ${jobId}
  `;
  if (!j) return null;
  return {
    id: j.id as string,
    type: j.type as string,
    status: j.status as string,
    payload: toObject(j.payload),
    result: toObject(j.result),
    error: text(j.error),
    workerId: text(j.worker_id),
    workerName: text(j.worker_name),
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

async function firstArtifact(jobId: string, namePrefix: string, typePrefixes?: readonly string[]): Promise<ArtifactRow | null> {
  const types = (typePrefixes ?? [""]).map((t) => `${t}%`);
  const rows = await db()`
    SELECT id, name, content_type, bytes, sha256, storage_path FROM artifacts
    WHERE job_id = ${jobId} AND name LIKE ${`${namePrefix}%`} AND content_type LIKE ANY(${types}::text[]) ORDER BY created_at LIMIT 1
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
  if (job.payload.engine === HERMES_MUX_ENGINE) return completeHermesMux(job, waiting);
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
  const inputs = await db()`SELECT id, title, license, source, origin_url, metadata FROM assets WHERE id = ANY(${inputIds}::uuid[]) ORDER BY created_at`;
  // The bed is named as the music, so its maker and licence are in the video's licence however many pictures it has.
  const bedId = asUuid(toObject(toObject(job.payload.audio).bed).assetId);
  const licenseInputs = inputs.map((a): RenderLicenseInput => {
    const item: RenderLicenseInput = {
      title: text(a.title),
      provider: text(toObject(a.metadata).provider),
      license: text(a.license),
      source: text(a.source),
      originUrl: text(a.origin_url),
    };
    if (bedId !== null && String(a.id) === bedId) item.role = "Music bed";
    return item;
  });
  const license = renderLicenseText(licenseInputs);
  const bedInput = licenseInputs.find((i) => i.role === "Music bed");
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
    // The renderer plugin that drew it (worker 0.10.0+ says; older workers ran the payload's engine).
    renderer: text(r.renderer) || text(job.payload.engine) || DEFAULT_RENDER_ENGINE,
    // What plays under the narration, from the payload the worker rendered (0.7.0+): the bed's title and licence.
    music: bedInput ? `Music bed: ${bedInput.title} (${bedInput.license})` : toObject(job.payload.audio).bed === null ? "No music bed" : "",
    ...(text(st.output.mixNote) ? { mixNote: text(st.output.mixNote) } : {}),
    // The style pack version this video was rendered with (the curation log reads it).
    ...(isRecord(st.output.stylePack) ? { stylePack: st.output.stylePack } : {}),
    // Where each scene starts (worker 0.5+). The qc stage hands these to the cut check.
    sceneStarts: Array.isArray(r.sceneStarts) ? (r.sceneStarts as unknown[]).filter((v): v is number => num(v) !== null).slice(0, 500) : [],
  };
  await concludeStage(run, st, template, { result, gate: null, extra: { jobId }, media: { videoAssetId: assetId } });
  return true;
}

/**
 * Stores a finished hermes-mux job (the run's narration on Hermes's picture) as the run's video and concludes the render
 * stage as a hermes render. The asset names every input: Hermes's picture (its backend, plugin, skill and media-host
 * URL), the run's narration and the mix's bed, and records how the lengths were matched.
 */
async function completeHermesMux(job: FinishedJob, waiting: RunningStage): Promise<boolean> {
  const { run, template, st } = waiting;
  const sql = db();
  if (job.status !== "succeeded") {
    const why = job.status === "cancelled" ? "the job was cancelled" : job.error || "the worker gave no reason";
    await recordStageError(run.id, st.id, "render", `Hermes rendered the picture, but adding the run's narration to it failed: ${why}`.slice(0, 600));
    return true;
  }
  const artifact = await firstArtifact(job.id, "video.");
  if (!artifact) {
    await recordStageError(run.id, st.id, "render", "The narration was added to Hermes's picture, but no video file came back");
    return true;
  }
  const clip = toObject(st.output.hermesClip);
  const pictureId = asUuid(toObject(job.payload.picture).assetId);
  const narrationId = asUuid(job.payload.narrationAssetId);
  const bedId = asUuid(toObject(toObject(job.payload.audio).bed).assetId);
  const inputIds = Array.isArray(job.payload.inputs) ? job.payload.inputs.map(asUuid).filter((x): x is string => x !== null) : [];
  const rows = inputIds.length > 0 ? await sql`SELECT id, title, license, source, origin_url, metadata FROM assets WHERE id = ANY(${inputIds}::uuid[]) ORDER BY created_at` : [];
  const byMuse = text(clip.by) === "muse";
  const role = (id: string) => (id === pictureId ? `Picture (${byMuse ? "Muse" : "Hermes"} render, research only)` : id === narrationId ? "Narration" : id === bedId ? "Music bed" : undefined);
  const licenseInputs = rows.map((a): RenderLicenseInput => {
    const r = role(String(a.id));
    return {
      title: text(a.title),
      provider: text(toObject(a.metadata).provider),
      license: text(a.license),
      source: text(a.source),
      originUrl: text(a.origin_url),
      ...(r ? { role: r } : {}),
    };
  });
  const narrationRow = rows.find((a) => String(a.id) === narrationId);
  const r = job.result;
  const plan = readMuxPlan(r.mux);
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const narration = narrationId
    ? { assetId: narrationId, title: narrationRow ? text(narrationRow.title) : "", provider: narrationRow ? text(toObject(narrationRow.metadata).provider) : "" }
    : null;
  const picture = {
    assetId: pictureId,
    executor: byMuse ? "muse-agent" : "hermes-render",
    provider: text(clip.provider),
    backend: text(clip.backend),
    plugin: text(clip.plugin),
    model: text(clip.model),
    originUrl: text(clip.originUrl),
  };
  const assetId = await assetFromArtifact({
    artifact,
    title: `${run.topic || "Video"} (${byMuse ? "Muse" : "Hermes"} render with the run's narration, research only)`,
    kind: "video",
    source: "worker",
    license: `${renderLicenseText(licenseInputs)} Research only: never published.`.slice(0, 1900),
    originUrl: "",
    channelId: run.channelId,
    metadata: {
      runId: run.id,
      jobId: job.id,
      executor: HERMES_MUX_ENGINE,
      renderer: byMuse ? "muse" : "hermes",
      researchOnly: true,
      inputAssetIds: inputIds,
      // Who made what: Hermes drew the picture, the run's voice stage recorded the narration, the worker mixed them.
      picture,
      narration,
      ...(bedId ? { musicBed: { assetId: bedId } } : {}),
      provider: picture.provider,
      backend: picture.backend,
      plugin: picture.plugin,
      hermesSkill: text(clip.hermesSkill) || null,
      ...(plan ? { mux: plan } : {}),
      integratedLufs: num(r.integratedLufs),
    },
  });
  const note = plan ? muxNote(plan) : "";
  const base = toObject(st.output.hermesResult);
  const result = {
    ...base,
    assetId,
    jobId: job.id,
    durationSec: num(r.durationSec) ?? base.durationSec ?? null,
    width: num(r.width) ?? base.width ?? null,
    height: num(r.height) ?? base.height ?? null,
    pictureAssetId: pictureId,
    narrationAssetId: narrationId,
    audioBy: "studio",
    ...(plan ? { mux: plan, muxNote: note } : {}),
    integratedLufs: num(r.integratedLufs),
    narrationClipped: r.narrationClipped === true,
    music: text(st.output.music) || (bedId ? "Music bed" : "No music bed"),
  };
  await concludeStage(run, st, template, { result, gate: null, extra: { renderer: "hermes", jobId: job.id }, media: { videoAssetId: assetId } });
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Quality check

/**
 * The approved stills, each with the time its own scene has in the video that was just rendered. The preview runs before
 * the voice, so its seconds are the planned ones; the video's are fitted to the narration. Both name the same scenes, so
 * a still maps to the middle of its scene in the render's timeline, which is where the picture must still match.
 */
async function previewStillChecks(
  run: RunInfo,
  renderResult: Record<string, unknown>,
): Promise<Array<{ assetId: string; atSec: number }>> {
  const sql = db();
  const preview = toObject((await latestPassedOutput(sql, run.id, "preview"))?.result);
  const stills = Array.isArray(preview.stills) ? (preview.stills as unknown[]) : [];
  const timelineRaw = Array.isArray(renderResult.timeline) ? (renderResult.timeline as unknown[]) : [];
  const timeline = timelineRaw.flatMap((raw) => {
    const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    return typeof o.start === "number" && typeof o.seconds === "number" && o.seconds > 0 ? [{ start: o.start, seconds: o.seconds }] : [];
  });
  if (stills.length === 0 || timeline.length === 0) return [];
  // Which scene each still belongs to: the scene it falls inside on the planned timeline the preview drew.
  const previewJob = asUuid(preview.jobId) ? await loadJob(asUuid(preview.jobId) as string) : null;
  const plannedShots = Array.isArray(previewJob?.payload.shots) ? (previewJob.payload.shots as Array<{ seconds: number }>) : [];
  const plannedFade = plannedShots.length > 1 ? Number(previewJob?.payload.transitionSec) || 0 : 0;
  const plannedStarts: number[] = [];
  for (let i = 0, at = 0; i < plannedShots.length; i++) {
    plannedStarts.push(at);
    at += (Number(plannedShots[i].seconds) || 0) - plannedFade;
  }
  const out: Array<{ assetId: string; atSec: number }> = [];
  for (const raw of stills) {
    const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const assetId = asUuid(o.artifactId);
    const at = typeof o.atSec === "number" && Number.isFinite(o.atSec) ? o.atSec : null;
    if (!assetId || at === null) continue;
    let shot = -1;
    for (const [i, start] of plannedStarts.entries()) if (at + 1e-6 >= start) shot = i;
    if (shot < 0 || shot >= timeline.length) continue;
    const atSec = Math.round((timeline[shot].start + timeline[shot].seconds / 2) * 100) / 100;
    out.push({ assetId, atSec });
  }
  return out.slice(0, 6);
}

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
  const renderResult = toObject(renderOut?.result);
  const assetId = asUuid(renderResult.assetId);
  if (!assetId) {
    await recordStageError(run.id, st.id, "qc", "There is no rendered video to check");
    return;
  }
  // Scene starts after the first one are the renderer's own cuts; fades and animated changes hide them from the detector.
  const plannedCuts = Array.isArray(renderResult.sceneStarts)
    ? (renderResult.sceneStarts as unknown[]).filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0).slice(0, 500)
    : [];
  const sampleFrames = advisoryFrameCount();
  const compareStills = await previewStillChecks(run, renderResult);
  const jobId = await createJob({
    type: "qc-video",
    // sampleFrames: a few stills for Hermes's presentation advisory (worker 0.10.0+; older workers ignore it). Only
    // when Hermes is set up, since nothing else looks at them.
    payload: {
      inputs: [assetId],
      runId: run.id,
      ...(plannedCuts.length > 0 ? { plannedCuts } : {}),
      ...(sampleFrames > 0 ? { sampleFrames } : {}),
      ...(compareStills.length > 0 ? { compareStills } : {}),
    },
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
  // A workflow without an assets stage never stores G-assets, so the final decision does not wait for it.
  const qc = combineGates(gates, template, finalGatesFor(runStagesOf(run.config)));
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
    // What the card needs to say whether a failed check may be approved anyway (review.ts qcWaiver).
    qcFacts: { failedGates: gates.filter((g) => !g.passed).map((g) => g.gate), narrated: template.audio.narrated !== false },
    final: true,
  });
  // A Trial pack's run: its QC result (and an automatic approval, if the autonomy policy gave one) goes into the
  // curation log the Styles page counts.
  await recordTrialOutcome(runId);
  // Hermes's look at the sampled stills, in the background: advisory only, nothing waits for it.
  void runPresentationAdvisory(runId, jobId);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Entry points used by the engine

/** Runs one claimed production stage. Render and qc only start their job and leave the stage running. */
export async function runProductionStage(run: RunInfo, st: StageRow, template: Template): Promise<void> {
  if (st.stage === "preview") return runPreviewStage(run, st, template);
  if (st.stage === "assets") return runAssetsStage(run, st);
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
  // An agent task may also return result.json (agent-result.json): the picture is its first image or sound file.
  const artifact = await firstArtifact(job.id, isAgent ? "agent-" : "asset.", isAgent ? ["image/", "audio/"] : undefined);
  if (!artifact) {
    await failOrder(orderId, `${label} finished but no ${isAgent ? "picture" : "file"} came back`);
    return runId;
  }
  const run = await loadRun(sql, runId);
  const shotRef = (o.shot_ref as string | null) ?? "shot";
  const kind: AssetKind = job.payload.kind === "audio" ? "audio" : "image";
  let assetId: string;
  let provider: string;
  if (isAgent) {
    const prompt = text(job.payload.prompt);
    const built = buildProvenance({
      executor: "muse-agent",
      title: `${shotRef} image`,
      kind,
      provider: "muse-agent",
      prompt,
      promptSha256: prompt ? createHash("sha256").update(prompt).digest("hex") : undefined,
      workerId: job.workerId || undefined,
      workerName: job.workerName || undefined,
      shotRef,
    });
    assetId = await assetFromArtifact({
      artifact,
      title: built.record.title,
      kind,
      source: built.record.source,
      license: built.record.license,
      originUrl: "",
      channelId: run?.channelId ?? null,
      metadata: {
        ...built.metadata,
        runId,
        workOrderId: orderId,
        jobId: job.id,
        contextFiles: Array.isArray(job.result.contextFiles) ? job.result.contextFiles : [],
      },
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
      licence: claimedLicence(text(job.payload.licence), text(job.payload.licenceUrl), url),
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
    // A render waiting on Muse: the run picks it up now instead of at the next look.
    if (job.type === "agent-task" && job.payload.museRender === true) return runId;
    // A voice stage waiting on a worker's Kokoro: the run picks it up now instead of at the next look.
    if (job.type === "tts") return runId;
    // A thinking stage waiting on its Muse task: the run picks it up now instead of at the next look.
    if (job.type === "agent-task" && isMuseThinkStage(job.payload.museStage)) return runId;
    if (job.type === "fetch-asset" || job.type === "agent-task") {
      const settled = await settleOrderJob(job);
      if (!settled) return null;
      await finalizeAssets(settled);
      return settled;
    }
    if (job.type === "render-video") return (await completeRender(jobId)) ? runId : null;
    if (job.type === "preview-frames") return (await completePreview(jobId)) ? runId : null;
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
    UPDATE work_orders SET state = 'pending', attempts = 0, error = NULL, job_id = NULL, result = NULL, not_before = NULL, wait_reason = NULL, updated_at = now()
    WHERE run_id = ${runId} AND stage = 'assets' AND state = 'failed'
  `;
  // Orders a pause or a rate limit left pending start fresh too.
  await tx`
    UPDATE work_orders SET not_before = NULL, wait_reason = NULL, updated_at = now()
    WHERE run_id = ${runId} AND stage = 'assets' AND state = 'pending'
  `;
}

/** Revise: every order runs again and the owner's note travels in the spec as data for the image prompt. */
export async function resetOrdersForRevision(tx: Q, runId: string, note: string): Promise<void> {
  await tx`
    UPDATE work_orders SET state = 'pending', attempts = 0, error = NULL, job_id = NULL, asset_id = NULL, provider = NULL, result = NULL,
      not_before = NULL, wait_reason = NULL,
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
    WHERE s.state = 'running' AND r.state = 'running' AND s.stage IN ('preview', 'assets', 'voice', 'render', 'qc')
  `;
  for (const s of rows) {
    try {
      const runId = s.run_id as string;
      const stage = s.stage as ProductionStage;
      const jobId = asUuid(toObject(s.output).jobId);
      const job = jobId ? await loadJob(jobId) : null;
      const orders = stage === "assets" ? await orderCounts(sql, runId) : undefined;
      const portalRender = stage === "render" && toObject(s.output).renderer === "hermes";
      // A hermes render is limited by its own budget (hermes-render-job.ts), counted from when it was asked for.
      const renderClockNow = portalRender ? renderClock(toObject(s.output).hermesRender, Date.now()) : null;
      const act = productionStageAction({ stage, idleMinutes: Number(s.idle), jobStatus: job ? job.status : null, jobError: job?.error ?? null, orders, portalRender, renderClock: renderClockNow });
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
        else if (stage === "preview") await completePreview(jobId);
      } else if (act.action === "fail") {
        await recordStageError(runId, s.id as string, stage, act.reason);
      }
    } catch (err) {
      console.error("reap production stage failed", s.id, err);
    }
  }
}
