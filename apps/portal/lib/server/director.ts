import "server-only";
import { studyExists } from "./lab-studies.ts";
import type { Sql, TransactionSql } from "postgres";
import { db } from "./db.ts";
import { audit } from "./audit.ts";
import { saveQcReport } from "./qc.ts";
import { ensureSeedTemplates, getTemplate } from "./templates.ts";
import { hermesJson } from "./hermes-json.ts";
import { museRenderReadiness, museStageReadiness, pollMuseStage, startMuseStage } from "./muse-stages.ts";
import { MUSE_POLL_SEC, museOverflowApplies, runsOnMuse, type MuseThinkStage } from "../studio/muse-stage.ts";
import { hermesBusyNow, hermesGateFull } from "./hermes-gate.ts";
import { isPortalEngine } from "../studio/render-engine.ts";
import { getCapabilities } from "./capabilities.ts";
import { skillHintsFor } from "../studio/capabilities.ts";
import { listEndpointHealth } from "./endpoint-health.ts";
import { knownImageBackends } from "../studio/asset-plan.ts";
import { giveUpMessage, waitExpired, type FailureClass, type HermesAskKind } from "../studio/pacing.ts";
import { decideNext, type AutonomyLevel } from "../studio/autonomy.ts";
import { estimateNarrationSec } from "../studio/voice.ts";
import { combineGates, scriptGate, storyboardGate, type CombinedQc, type GateId, type GateResult } from "../studio/qc.ts";
import type { Template } from "../studio/templates.ts";
import { briefFromInput, briefParagraph, freezeBrief, parseBrief } from "../studio/brief.ts";
import {
  MAX_NOTE_CHARS,
  type ChatMessage,
  type Validated,
  classifyPrompt,
  ideaPrompt,
  pickIdea,
  requiresSources,
  researchPrompt,
  scriptPrompt,
  selfTestPrompt,
  storyboardPrompt,
  validateClassification,
  validateIdeas,
  validateResearch,
  validateScript,
  validateSelfTest,
  validateStoryboard,
  wordsPerMinuteFor,
  workOrdersFromStoryboard,
  type DirectorContext,
  type Idea,
  type ResearchNote,
} from "../studio/director.ts";
import {
  isPlanStage,
  isProductionStage,
  isRunStage,
  nextRunStage,
  revisionTarget,
  stageSummary,
  MODEL_STAGE_STUCK_MINUTES,
  type RunStage,
} from "../studio/engine.ts";
import { alwaysReviewed, runRecipeOf, runStagesOf, withStudioVoice, workflowForPack } from "../studio/recipes.ts";
import { planReview } from "../studio/plan-review.ts";
import { sceneSpecGate, sceneSpecPrompt, scriptNumberIssues, validateSceneSpec } from "../studio/scene-spec.ts";
import { skillBriefGate, skillBriefPrompt, validateSkillBrief, type BriefSkill } from "../studio/skill-brief.ts";
import { htmlDesignGate, htmlDesignPrompt, validateHtmlDesign, type DesignBrief } from "../studio/html-design.ts";
import { packVendoredFiles } from "./style-packs.ts";
import { VIDEO_FORMATS } from "../studio/catalog.ts";
import { decisionRefusal, parseQcFacts, stageLabel, tightenLabel, videoRevisionMessage, type QcFacts, type ReviewDecision, type ReviewKind, type ReviewMedia, type ReviewPayload } from "../studio/review.ts";
import { addGateIssues, finalReason, productionDecision, productionSummary, retryStageFor } from "../studio/production.ts";
import { cancelRunWork, narrationTempoReady, planScriptFit, reapProduction, recheckConclusion, resetFailedOrders, resetOrdersForRevision, runProductionStage } from "./production.ts";
import { paceForRun } from "./speech-rate.ts";
import { parseVoiceFix, voiceRevisionRoute, type LengthDirection, type VoiceFix } from "../studio/voice-fit.ts";
import { listProviderTermsIn } from "./provider-terms.ts";
import {
  autoRecheckMatches,
  blockingRows,
  isTermsStage,
  parseProviderRows,
  fitMessage,
  recheckMessage,
  recheckRefusal,
  type ConclusionAction,
  type ProviderRowUse,
} from "../studio/terms-review.ts";
import type { ProviderKind } from "../studio/asset-plan.ts";
import { buildRunConfig, parseRunConfig, topicFromBrief, type RunConfig, type RunRequest } from "../studio/run-config.ts";
import { guardFinalDecision, labTrialOption, runStylePack, startRefusal } from "../studio/style-registry.ts";
import type { TrialBatch } from "../studio/trial-batch.ts";
import { registryEntry } from "./style-packs.ts";
import { reportedCapabilities } from "./workers.ts";
import { env } from "./env.ts";
import { recordTrialOutcome } from "./style-trials.ts";
import { scoreRefusal } from "./presentation.ts";

/**
 * The run engine: idea, research, script and storyboard are Hermes stages; assets, voice, render and qc are the
 * Phase 4 production stages whose drivers live in lib/server/production.ts. Model output is validated data and is
 * never executed. This module only reads channels; the category, home worker and autonomy level are set by the
 * owner alone.
 */

/** A transaction handle is accepted wherever a connection is. */
export type Q = Sql | TransactionSql;


export interface RunInfo {
  id: string;
  channelId: string | null;
  templateId: string | null;
  state: string;
  level: AutonomyLevel;
  paused: boolean;
  topic: string;
  config: RunConfig;
  niche: string;
  plan: string;
  category: string;
}

export interface StageRow {
  id: string;
  stage: RunStage;
  attempt: number;
  output: Record<string, unknown>;
}

/** A result for a stage that has no gate of its own: nothing to fail. */
const NO_GATE: CombinedQc = { passed: true, missingGates: [], score: 100, failedGates: [], blocking: false };

class DecisionError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toLevel(n: unknown): AutonomyLevel {
  const v = Number(n);
  return v >= 3 ? 3 : v === 2 ? 2 : v === 1 ? 1 : 0;
}

function toObject(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}

function asIdea(v: unknown): Idea | null {
  if (!isRecord(v)) return null;
  if (typeof v.title !== "string" || typeof v.hook !== "string" || typeof v.angle !== "string" || typeof v.score !== "number") return null;
  return { title: v.title, hook: v.hook, angle: v.angle, score: v.score };
}

function errorText(err: unknown): string {
  const m = err instanceof Error ? err.message : "unknown error";
  return m.slice(0, 300);
}

function json(v: unknown): string {
  return JSON.stringify(v);
}

export async function loadRun(sql: Q, runId: string): Promise<RunInfo | null> {
  const [r] = await sql`
    SELECT r.id, r.channel_id, r.template_id, r.state, r.autonomy_level, r.topic, r.config,
           c.niche, c.plan, c.category, c.autonomy_paused
    FROM pipeline_runs r LEFT JOIN channels c ON c.id = r.channel_id
    WHERE r.id = ${runId}
  `;
  if (!r) return null;
  return {
    id: r.id as string,
    channelId: (r.channel_id as string | null) ?? null,
    templateId: (r.template_id as string | null) ?? null,
    state: r.state as string,
    level: toLevel(r.autonomy_level),
    paused: r.autonomy_paused === true,
    topic: (r.topic as string | null) ?? "",
    config: parseRunConfig(r.config),
    niche: (r.niche as string | null) ?? "",
    plan: (r.plan as string | null) ?? "",
    category: (r.category as string | null) ?? "",
  };
}

export async function latestPassedOutput(sql: Q, runId: string, stage: RunStage): Promise<Record<string, unknown> | null> {
  const [r] = await sql`
    SELECT output FROM pipeline_stages WHERE run_id = ${runId} AND stage = ${stage} AND state = 'passed'
    ORDER BY attempt DESC LIMIT 1
  `;
  return r ? toObject(r.output) : null;
}

async function pastTitles(sql: Q, run: RunInfo): Promise<string[]> {
  if (!run.channelId) return [];
  const runs = await sql`
    SELECT topic AS t FROM pipeline_runs WHERE channel_id = ${run.channelId} AND id <> ${run.id} AND topic <> ''
    ORDER BY created_at DESC LIMIT 40
  `;
  const prods = await sql`SELECT title AS t FROM productions WHERE channel_id = ${run.channelId} ORDER BY created_at DESC LIMIT 40`;
  const out: string[] = [];
  for (const r of [...runs, ...prods]) {
    const t = r.t as string;
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 40);
}

/** Inserts the next attempt of a stage as pending. The feedback travels in the row's output until it runs. */
async function insertPending(sql: Q, runId: string, stage: string, feedback: string, autoRevisions: number, extra: Record<string, unknown> = {}): Promise<void> {
  await sql`
    INSERT INTO pipeline_stages (run_id, stage, attempt, output)
    SELECT ${runId}::uuid, ${stage}::text, COALESCE(MAX(attempt), 0) + 1, ${json({ ...extra, feedback, autoRevisions })}::text::jsonb
    FROM pipeline_stages WHERE run_id = ${runId} AND stage = ${stage}
  `;
}

async function insertReview(sql: Q, runId: string, stage: string, kind: ReviewKind, payload: ReviewPayload): Promise<void> {
  await sql`
    INSERT INTO review_items (run_id, stage, kind, payload)
    VALUES (${runId}, ${stage}, ${kind}, ${json(payload)}::text::jsonb)
    ON CONFLICT (run_id, stage, kind) WHERE state = 'open' DO NOTHING
  `;
}

async function supersedeOpenReviews(sql: Q, runId: string): Promise<void> {
  await sql`UPDATE review_items SET state = 'superseded', decided_at = now() WHERE run_id = ${runId} AND state = 'open'`;
}

function issuesToFeedback(issues: string[]): string {
  return issues.slice(0, 12).map((i) => `- ${i}`).join("\n");
}

async function safeAudit(entry: Parameters<typeof audit>[0]): Promise<void> {
  try {
    await audit(entry);
  } catch (err) {
    console.error("audit failed", entry.action, err);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Start

export type StartResult = { ok: true; runId: string } | { ok: false; error: string };

export async function startRun(
  input: RunRequest & {
    channelId: string;
    templateId: string;
    /** A saved plan the run was started from, or empty. */
    productionId?: string;
    /** A Template Lab study this run is a trial for, or empty. Such a run is always a trial. */
    labStudyId?: string;
    /**
     * A lab trial: the style is a Draft or Lab pack, run research only from Styles or a study (never published, kept
     * out of the promotion counts). Refused for any other status, and when no worker (or Hermes) can render it.
     */
    labTrial?: boolean;
    /** One run of a batch trial (trial-batch.ts), recorded on the run. */
    trialBatch?: TrialBatch;
    userId: string;
  },
): Promise<StartResult> {
  try {
    const sql = db();
    const [c] = await sql`SELECT id, category, autonomy_level FROM channels WHERE id = ${input.channelId}`;
    if (!c) return { ok: false, error: "Unknown channel" };
    let template = await getTemplate(input.templateId);
    if (!template) {
      await ensureSeedTemplates();
      template = await getTemplate(input.templateId);
    }
    if (!template) return { ok: false, error: "Unknown template" };
    const tpl: Template = template;
    if (template.status === "retired") return { ok: false, error: "This template is retired" };
    if (!template.formats.includes(input.format)) return { ok: false, error: `This template does not make ${input.format} videos` };
    // Only a Listed or Trial style pack starts a run; planned styles, drafts and retired packs never do.
    const entry = await registryEntry(template.styleId);
    const refusal = startRefusal(entry, { labTrial: input.labTrial === true });
    if (refusal || !entry?.pack) return { ok: false, error: refusal ?? "Unknown style" };
    if (input.labTrial) {
      // Said up front, from stored worker rows (no call to a worker): a lab trial nothing can render does not start.
      const option = labTrialOption(entry, await reportedCapabilities().catch(() => [] as string[]), { hermes: Boolean(env().HERMES_BASE_URL) });
      if (!option.ok) return { ok: false, error: `${option.reason}. ${option.fix}` };
    }
    if (!entry.pack.formats.includes(input.format)) return { ok: false, error: `This style does not make ${input.format} videos` };

    // "Muse does the thinking" is said up front: nothing starts that no worker could take.
    if (input.thinkOnMuse) {
      const refusals = await museStageReadiness();
      if (refusals.length > 0) return { ok: false, error: `Muse cannot do the thinking yet. ${refusals.join(". ")}` };
      // A style Hermes would render: Muse renders it with the skill from venstudio-styles, so a worker must have it.
      if (isPortalEngine(entry.pack.engine)) {
        const render = await museRenderReadiness(entry.pack.id);
        if (render.refusals.length > 0) return { ok: false, error: `Muse cannot render this style yet. ${render.refusals.join(". ")}` };
      }
    }
    // The theme defaults to the channel category; an override lives on this run only and never on the channel.
    const built = buildRunConfig(input, { category: (c.category as string | null) ?? "" }, template);
    if (!built.ok) return { ok: false, error: built.error };
    // The pack version and status go with the run (additive): a Trial pack marks it research only. A run started
    // from a Template Lab study is a trial whatever the pack's status, and keeps the link to its study.
    let labStudyId: string | undefined;
    if (input.labStudyId) {
      if (!(await studyExists(input.labStudyId))) return { ok: false, error: "Unknown lab study" };
      labStudyId = input.labStudyId;
    }
    const pack = runStylePack(entry.pack, { lab: input.labTrial === true });
    // The run's stage list is fixed here, from the pack's workflow (recipes.ts), and stored with the run.
    const flow = workflowForPack(entry.pack);
    if (!flow.ok) return { ok: false, error: flow.error };
    const config: RunConfig = {
      ...built.config,
      stylePack: labStudyId ? { ...pack, trial: true } : pack,
      ...(labStudyId ? { labStudyId } : {}),
      ...(input.trialBatch ? { trialBatch: input.trialBatch } : {}),
      workflow: env().SKILL_VOICE === "studio" ? withStudioVoice(flow.workflow) : flow.workflow,
    };
    const topic = topicFromBrief(config.topicHint);
    let productionId: string | null = null;
    if (input.productionId) {
      const [p] = await sql`SELECT id FROM productions WHERE id = ${input.productionId}`;
      productionId = p ? (p.id as string) : null;
    }
    const level = toLevel(c.autonomy_level);
    const runId = await sql.begin(async (tx) => {
      const [row] = await tx`
        INSERT INTO pipeline_runs (channel_id, template_id, template_version, topic, autonomy_level, config, production_id)
        VALUES (${input.channelId}, ${tpl.id}, ${tpl.version}, ${topic}, ${level}, ${json(config)}::text::jsonb, ${productionId})
        RETURNING id
      `;
      const id = row.id as string;
      await insertPending(tx, id, "idea", "", 0);
      return id;
    });
    await safeAudit({ userId: input.userId, action: "run.start", target: runId, detail: { channelId: input.channelId, templateId: template.id, format: input.format, language: config.language, purposes: config.purposes, themeSource: config.themeSource, stylePack: config.stylePack, recipe: flow.workflow.recipe, ...(config.labStudyId ? { labStudyId: config.labStudyId } : {}), ...(config.trialBatch ? { trialBatch: config.trialBatch } : {}) } });
    return { ok: true, runId };
  } catch (err) {
    console.error("startRun failed", err);
    return { ok: false, error: `Could not start the run: ${errorText(err)}` };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Advance

async function claimNext(runId: string): Promise<StageRow | null> {
  const rows = await db()`
    UPDATE pipeline_stages s SET state = 'running', started_at = now(), error = NULL, not_before = NULL, output = s.output - 'hermesWait'
    WHERE s.id = (
      SELECT p.id FROM pipeline_stages p JOIN pipeline_runs r ON r.id = p.run_id
      WHERE p.run_id = ${runId} AND p.state = 'pending' AND r.state = 'running' AND p.stage IN ('idea', 'research', 'script', 'storyboard', 'scene-spec', 'skill-brief', 'html-design', 'preview', 'assets', 'voice', 'render', 'qc')
        AND (p.not_before IS NULL OR p.not_before <= now())
      ORDER BY p.attempt, p.id LIMIT 1 FOR UPDATE OF p SKIP LOCKED
    ) AND s.state = 'pending'
    RETURNING s.id, s.stage, s.attempt, s.output
  `;
  const r = rows[0];
  if (!r || !isRunStage(r.stage as string)) return null;
  return { id: r.id as string, stage: r.stage as RunStage, attempt: r.attempt as number, output: toObject(r.output) };
}

type StageFailure = { ok: false; error: string; busyUntil?: Date; slow?: { afterMs: number }; museWait?: { jobId: string; until: Date; text: string; overflow?: boolean } };
type StageOutcome = { ok: true; result: unknown; gate: GateResult | null } | StageFailure;

function fromHermes<T>(
  r: { ok: true; value: T } | { ok: false; error: string; cause: FailureClass; busyUntil?: Date; slow?: { afterMs: number } },
): { ok: true; value: T } | StageFailure {
  if (r.ok) return { ok: true, value: r.value };
  if (r.cause !== "busy") return { ok: false, error: r.error };
  return r.slow ? { ok: false, error: r.error, busyUntil: r.busyUntil, slow: r.slow } : { ok: false, error: r.error, busyUntil: r.busyUntil };
}

/** How many slow answers in a row this stage attempt has had (deferStage counts them in output.slowStreak). */
export function slowStreakOf(output: Record<string, unknown>): number {
  const n = Number(output.slowStreak);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** The options of a stage's Hermes ask: its own call timeout, and the backoff step a slow answer would take. */
function stageAsk(kind: HermesAskKind, st: StageRow): { kind: HermesAskKind; slowStreak: number } {
  return { kind, slowStreak: slowStreakOf(st.output) + 1 };
}

/**
 * One thinking ask. Hermes unless the run sends this stage to Muse (config.executors): then the same prompt goes to the
 * Muse agent as a task, the stage waits on the job without holding a Hermes slot, and result.json is read back with the
 * same validator. A task's failure (including the agent's own reason) is the stage's error.
 */
async function think<T>(run: RunInfo, st: StageRow, stage: MuseThinkStage, prompt: ChatMessage[], validate: (v: unknown) => Validated<T>): Promise<{ ok: true; value: T } | StageFailure> {
  const existing = typeof st.output.museJobId === "string" ? st.output.museJobId : "";
  const waitFor = (jobId: string, text: string, sec: number, overflow = false): StageFailure => ({ ok: false, error: text, museWait: { jobId, until: new Date(Date.now() + sec * 1000), text, overflow } });
  // A task already queued for this attempt (chosen at the start, or taken over from a busy Hermes) is always the one to wait for.
  if (existing) {
    const state = await pollMuseStage(existing, stage);
    if (state.kind === "wait") return waitFor(existing, state.text, state.pollSec);
    if (state.kind === "error") return { ok: false, error: state.error };
    // The same check the Hermes answer gets, now on the parsed result (the stage validator already ran on the text).
    const checked = validate(state.value);
    return checked.ok ? { ok: true, value: checked.value } : { ok: false, error: `The Muse agent's ${stage} answer was not usable: ${checked.issues.slice(0, 5).join("; ")}` };
  }
  if (runsOnMuse(run.config.executors, stage)) {
    const refusals = await museStageReadiness();
    if (refusals.length > 0) return { ok: false, error: `Muse cannot take this step: ${refusals.join(". ")}` };
    const jobId = await startMuseStage({ runId: run.id, channelId: run.channelId, project: run.topic || "VenStudio video", stage, prompt });
    return waitFor(jobId, "Waiting for a Muse worker to take this step", MUSE_POLL_SEC);
  }
  // Overflow: Hermes answers one ask at a time. When it is busy, rate limited, slow or its gate is full, a ready Muse
  // worker takes this step instead of the run waiting. No ready Muse worker leaves things exactly as they were.
  const overflowOn = museOverflowApplies({ stage, executors: run.config.executors, overflowOn: env().MUSE_OVERFLOW === "1" });
  const takeOver = async (why: string): Promise<StageFailure | null> => {
    if (!overflowOn || (await museStageReadiness()).length > 0) return null;
    try {
      const jobId = await startMuseStage({ runId: run.id, channelId: run.channelId, project: run.topic || "VenStudio video", stage, prompt });
      return waitFor(jobId, `${why}, so a Muse worker takes this step`, MUSE_POLL_SEC, true);
    } catch (err) {
      console.error("muse overflow failed", run.id, stage, err);
      return null;
    }
  };
  if (overflowOn && (hermesGateFull() || (await hermesBusyNow()))) {
    const moved = await takeOver("Hermes is busy");
    if (moved) return moved;
  }
  const r = fromHermes(await hermesJson(prompt, validate, stageAsk(stage, st)));
  if (!r.ok && r.busyUntil) {
    const moved = await takeOver(r.slow ? "Hermes is slow" : "Hermes is busy");
    if (moved) return moved;
  }
  return r;
}

async function runModel(run: RunInfo, st: StageRow, template: Template, feedback: string): Promise<StageOutcome> {
  if (isProductionStage(st.stage)) return { ok: false, error: "This step is not a model step" };
  const sql = db();
  const ctx: DirectorContext = {
    niche: run.niche,
    plan: run.plan,
    category: run.category || undefined,
    language: run.config.language,
    format: run.config.format,
    durationSec: run.config.durationSec,
    themeId: run.config.themeId || undefined,
    template,
    pastTitles: st.stage === "idea" ? await pastTitles(sql, run) : [],
    topicHint: run.config.topicHint || undefined,
    purposes: run.config.purposes,
    subtitles: run.config.subtitles,
  };
  // A frozen brief supersedes the free string: the approved idea's title and angle travel with it into the script.
  if (run.config.brief?.frozenAt) ctx.topicHint = briefParagraph(run.config.brief);
  // A workflow without pictures tells the prompts that need to know (image-sequence prompts stay as they were).
  const recipe = runRecipeOf(run.config);
  if (recipe !== "image-sequence") ctx.recipe = recipe;
  // The script and storyboard plan with the measured pace of the voice this run will most likely get (the one that
  // spoke last for its language), so the script, the storyboard and the voice check agree on the narration length.
  if (st.stage === "script" || st.stage === "storyboard" || isPlanStage(st.stage)) {
    const pace = await paceForRun(run.config.language);
    if (pace.learned) ctx.wordsPerMinute = pace.wpm;
  }
  const wpm = wordsPerMinuteFor(template, ctx.wordsPerMinute);
  const hint = feedback || undefined;
  // Skill names Hermes reported in the last scan. No scan, or a failed read, means no hint.
  const snap = await getCapabilities().catch(() => null);

  if (st.stage === "idea") {
    const r = await think(run, st, "idea", ideaPrompt(ctx, hint), validateIdeas);
    return r.ok ? { ok: true, result: r.value, gate: null } : r;
  }

  const ideaOut = await latestPassedOutput(sql, run.id, "idea");
  const idea = ideaOut ? asIdea(ideaOut.chosenIdea) : null;
  if (!idea) return { ok: false, error: "No idea has been chosen for this run" };

  if (st.stage === "research") {
    const r = await think(run, st, "research", researchPrompt(ctx, idea, hint, skillHintsFor("research", snap)), validateResearch);
    return r.ok ? { ok: true, result: r.value, gate: null } : r;
  }

  const researchOut = await latestPassedOutput(sql, run.id, "research");
  const checkedNotes = validateResearch(researchOut?.result);
  const notes: ResearchNote[] = checkedNotes.ok ? checkedNotes.value.notes : [];

  if (st.stage === "script") {
    const r = await think(run, st, "script", scriptPrompt(ctx, idea, notes, hint, skillHintsFor("script", snap)), validateScript);
    if (!r.ok) return r;
    const needs = requiresSources(run.config.themeId, run.config.purposes);
    // When sources are required only sourced notes count as sources; otherwise every note is checked for copying.
    const sources = notes.filter((n) => !needs || n.sourced).map((n) => `${n.claim} ${n.summary}`);
    const gate = scriptGate({
      script: r.value.script,
      hooks: r.value.hooks,
      format: run.config.format,
      durationSec: run.config.durationSec,
      wordsPerMinute: wpm,
      sources,
      requiresSources: needs,
    });
    // A scene-spec run's captions are its script, on screen like the spec: digits in it must be sourced numbers too.
    if (recipe === "scene-spec") return { ok: true, result: r.value, gate: addGateIssues(gate, scriptNumberIssues(r.value.script, notes)) };
    return { ok: true, result: r.value, gate };
  }

  const scriptOut = await latestPassedOutput(sql, run.id, "script");
  const checkedScript = validateScript(scriptOut?.result);
  if (!checkedScript.ok) return { ok: false, error: "The approved script is missing" };
  const narrationSec = estimateNarrationSec(checkedScript.value.script, wpm);

  if (st.stage === "scene-spec") {
    // The page draws the spec: its contract decides the elements and motion tokens Hermes may use.
    const pack = (await registryEntry(template.styleId).catch(() => undefined))?.pack;
    const contract = { name: pack?.name ?? template.label, elements: pack?.plan?.elements ?? [], motionTokens: pack?.plan?.motionTokens ?? [] };
    if (contract.elements.length === 0) return { ok: false, error: "This style's pack names no on-screen elements, so no scene spec can be checked against it" };
    const r = await think(run, st, "scene-spec", sceneSpecPrompt(ctx, checkedScript.value.script, notes, contract, hint), (v) => validateSceneSpec(v, { contract, noteCount: notes.length }));
    if (!r.ok) return r;
    return { ok: true, result: r.value, gate: sceneSpecGate(template, r.value, notes, narrationSec) };
  }
  if (st.stage === "html-design") {
    // Research only (owner decision): Hermes writes the page, checked here before anything runs (html-design.ts).
    const pack = (await registryEntry(template.styleId).catch(() => undefined))?.pack;
    if (!pack || !pack.design || pack.engine !== "html-capture") return { ok: false, error: "This run's style pack has no design brief for an html-capture page, so Hermes cannot design the page" };
    if (!run.config.stylePack?.trial) return { ok: false, error: "A page Hermes writes is research only, so it runs only as a trial. This run is not a trial; nothing was asked." };
    const f = VIDEO_FORMATS[run.config.format];
    const brief: DesignBrief = {
      name: pack.name,
      brief: pack.design.brief,
      palette: pack.design.palette,
      typography: pack.design.typography,
      layout: pack.design.layout,
      elements: pack.plan?.elements ?? [],
      motionTokens: pack.plan?.motionTokens ?? [],
      vendored: await packVendoredFiles(pack.id),
      width: f.width,
      height: f.height,
      fps: f.fps,
      safeAreaPct: template.captions.safeAreaPct,
      drawsCaptions: pack.drawsCaptions === true,
    };
    const r = fromHermes(await hermesJson(htmlDesignPrompt(ctx, checkedScript.value.script, brief, hint), (v) => validateHtmlDesign(v, { vendored: brief.vendored }), stageAsk("html-design", st)));
    if (!r.ok) return r;
    return { ok: true, result: r.value, gate: htmlDesignGate(template, r.value, narrationSec) };
  }
  if (st.stage === "skill-brief") {
    const pack = (await registryEntry(template.styleId).catch(() => undefined))?.pack;
    // Without the pack the brief could not follow its skill's mapping: stop instead of writing a generic brief.
    if (!pack) return { ok: false, error: "This run's style pack could not be read, so the skill brief cannot follow its skill" };
    const h = pack.hermes ?? null;
    // A run with its own voice stage narrates for the skill (withStudioVoice): the brief must not tell the skill to record one.
    const voice = h && runStagesOf(run.config).includes("voice") ? "run" : h?.voice;
    const skill: BriefSkill | null = h ? { name: h.skill, mode: h.mode, voice: voice ?? "run", input: h.input } : null;
    const r = await think(run, st, "skill-brief", skillBriefPrompt(ctx, checkedScript.value.script, notes, skill, pack.name, hint), (v) => validateSkillBrief(v, skill));
    if (!r.ok) return r;
    return { ok: true, result: r.value, gate: skillBriefGate(template, r.value, narrationSec) };
  }
  // Backends Hermes has reported (its scan and its own image chain): the storyboard may pick one per shot, and any
  // other name is dropped with a note instead of failing the storyboard.
  const health = await listEndpointHealth("image");
  const backends = knownImageBackends(
    snap?.hermes?.imageProviders ?? [],
    health.filter((h) => h.endpoint === "hermes").map((h) => h.model),
  );
  const r = await think(
    run,
    st,
    "storyboard",
    storyboardPrompt(ctx, checkedScript.value.script, hint, skillHintsFor("image", snap), backends),
    (v) => validateStoryboard(v, { knownProviders: backends }),
  );
  if (!r.ok) return r;
  return { ok: true, result: r.value, gate: storyboardGate(template, r.value.shots, narrationSec) };
}

/**
 * Marks a stage passed and starts the next one. After the storyboard it creates the work orders and leaves the
 * assets stage pending. The production stages follow in order (assets, voice, render, qc); approving the quality
 * check finishes the run (upload is a later phase). Runs inside the caller's transaction.
 */
async function approveStage(tx: Q, runId: string, stageId: string, stage: RunStage, extra: Record<string, unknown>): Promise<void> {
  const [row] = await tx`SELECT output FROM pipeline_stages WHERE id = ${stageId} FOR UPDATE`;
  if (!row) throw new DecisionError("The stage no longer exists");
  const output = { ...toObject(row.output), ...extra };
  await tx`UPDATE pipeline_stages SET state = 'passed', output = ${json(output)}::text::jsonb, finished_at = now() WHERE id = ${stageId}`;
  const chosen = asIdea(output.chosenIdea);
  if (stage === "idea" && chosen) await tx`UPDATE pipeline_runs SET topic = ${chosen.title.slice(0, 300)} WHERE id = ${runId}`;
  // The run's own stage list (fixed at start); RUN_STAGES for a run from before workflows.
  const [cfg] = await tx`SELECT config FROM pipeline_runs WHERE id = ${runId}`;
  const stages = runStagesOf(parseRunConfig(cfg?.config));
  if (stage === "idea" && chosen) {
    // The owner picked one of the ideas: the brief stops moving here, and the script stage reads the frozen brief
    // instead of the conversation (docs/plans/2026-11-24-brief-and-duration.md).
    const stored = parseRunConfig(cfg?.config);
    const brief = parseBrief(stored.brief) ?? briefFromInput({ topic: stored.topicHint, durationSec: stored.durationSec, language: stored.language });
    const frozen = freezeBrief(brief, { title: chosen.title, angle: chosen.angle }, new Date().toISOString(), extra.auto === true ? "auto" : "owner");
    await tx`UPDATE pipeline_runs SET config = jsonb_set(config, '{brief}', ${json(frozen)}::text::jsonb, true) WHERE id = ${runId}`;
  }
  // Never finish a run because a stage is missing from its list: that is a bug to report, not the last stage.
  if (!stages.includes(stage)) throw new DecisionError(`The ${stageLabel(stage).toLowerCase()} is not a stage of this run's workflow`);
  const following = nextRunStage(stage, stages);
  if (stage === "storyboard" && following === "assets") {
    const board = validateStoryboard(output.result);
    if (!board.ok) throw new DecisionError("The storyboard could not be read back");
    // A new storyboard replaces every earlier work order, including finished ones from a revised run.
    await tx`DELETE FROM work_orders WHERE run_id = ${runId}`;
    for (const w of workOrdersFromStoryboard(board.value.shots)) {
      await tx`
        INSERT INTO work_orders (run_id, stage, shot_ref, executor, spec)
        VALUES (${runId}, 'assets', ${w.shotRef}, ${w.executor}, ${json(w.spec)}::text::jsonb)
      `;
    }
  }
  if (!following) {
    await tx`UPDATE pipeline_runs SET state = 'done', finished_at = now() WHERE id = ${runId}`;
    return;
  }
  await insertPending(tx, runId, following, "", 0);
  await tx`UPDATE pipeline_runs SET state = 'running' WHERE id = ${runId} AND state = 'waiting-human'`;
}

// ---------------------------------------------------------------------------------------------------------------
// Waiting for a busy Hermes

declare global {
  /** Run id to the time its resume timer fires. Duplicates are harmless (advanceRun is idempotent), so none is cancelled. */
  var __venstudioResumeAt: Map<string, number> | undefined;
}

/**
 * Wakes a run when its not-before time has passed, in this process. A restart loses the timer; the persisted
 * not_before then lets the worker claim route (nudgeRecovery) or any reaping page pick the run up.
 */
function scheduleResume(runId: string, until: Date): void {
  globalThis.__venstudioResumeAt ??= new Map();
  const planned = globalThis.__venstudioResumeAt;
  const at = until.getTime() + 250;
  const existing = planned.get(runId);
  // A timer already set for this moment covers it.
  if (existing !== undefined && existing > Date.now() && Math.abs(existing - at) < 1000) return;
  planned.set(runId, at);
  setTimeout(() => {
    if (planned.get(runId) === at) planned.delete(runId);
    void advanceRun(runId);
  }, Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1));
}

/**
 * Returns a running stage to pending with a not-before time because Hermes is rate limited or slow, and schedules the
 * resume. The stage keeps its attempt. `waitSince` in the output marks when the wait began (kept across resumes,
 * restarted when the stage made progress), so a wait that lasts past HERMES_WAIT_GIVE_UP_MS becomes a stage error.
 * `slow` marks a slow answer: the run page says so (pacing.ts stageWaitText) and `slowStreak` counts them, so the
 * next slow answer waits the next backoff step.
 */
export async function deferStage(
  runId: string,
  stageId: string,
  until: Date,
  text: string,
  opts: { restartClock?: boolean; slow?: { afterMs: number; streak: number } } = {},
): Promise<void> {
  const wait = opts.slow
    ? { until: until.toISOString(), text: text.slice(0, 300), reason: "slow", afterMs: Math.round(opts.slow.afterMs) }
    : { until: until.toISOString(), text: text.slice(0, 300) };
  const restart = opts.restartClock === true;
  const streak = opts.slow ? Math.max(1, Math.floor(opts.slow.streak)) : 0;
  const rows = await db()`
    UPDATE pipeline_stages SET state = 'pending', started_at = NULL, not_before = ${until},
      output = (output - 'finalizingAt') || jsonb_build_object(
        'hermesWait', ${json(wait)}::text::jsonb,
        'waitSince', CASE WHEN ${restart ? 1 : 0}::int = 1 OR output->>'waitSince' IS NULL THEN to_jsonb(now()) ELSE output->'waitSince' END,
        'slowStreak', CASE WHEN ${streak}::int > 0 THEN to_jsonb(${streak}::int) ELSE COALESCE(output->'slowStreak', to_jsonb(0)) END
      )
    WHERE id = ${stageId} AND state = 'running'
    RETURNING id
  `;
  if (rows.length > 0) scheduleResume(runId, until);
}

/**
 * A hermes render waits for its file (hermes-render-job.ts): the stage goes back to pending until the next poll, with
 * the render job and the "rendering" wait in its output, and a resume is scheduled. Not a wait for a busy Hermes: no
 * slow streak, no give-up clock (the render's budget is the limit), no gate slot held.
 */
export async function deferRenderPoll(runId: string, stageId: string, until: Date, patch: Record<string, unknown>, wait: Record<string, unknown>): Promise<void> {
  const rows = await db()`
    UPDATE pipeline_stages SET state = 'pending', started_at = NULL, not_before = ${until},
      output = (output - 'finalizingAt' - 'slowStreak' - 'waitSince') || ${json(patch)}::text::jsonb || jsonb_build_object('hermesWait', ${json(wait)}::text::jsonb)
    WHERE id = ${stageId} AND state = 'running'
    RETURNING id
  `;
  if (rows.length > 0) scheduleResume(runId, until);
}

export async function recordStageError(runId: string, stageId: string, stage: RunStage, message: string): Promise<void> {
  const text = message.slice(0, 500);
  await db().begin(async (tx) => {
    const failed = await tx`
      UPDATE pipeline_stages SET state = 'failed', error = ${text}, finished_at = now()
      WHERE id = ${stageId} AND state IN ('running', 'pending') RETURNING id
    `;
    if (failed.length === 0) return;
    const moved = await tx`UPDATE pipeline_runs SET state = 'waiting-human' WHERE id = ${runId} AND state = 'running' RETURNING id`;
    if (moved.length === 0) return;
    await insertReview(tx, runId, stage, "stage-error", { summary: `${stageLabel(stage)} stopped`, error: text });
  });
}

/** What a finished stage hands to concludeStage. The Phase 4 stages use the optional fields. */
export interface StageConclusion {
  result: unknown;
  gate: GateResult | null;
  /** Kept in the stage output next to the result (for example the job id of a render). */
  extra?: Record<string, unknown>;
  /** Decide on this combined result instead of the single gate (the final quality check has several gates). */
  qc?: CombinedQc;
  /** Plain issues to show when the problems come from several stored gates. */
  issues?: string[];
  /** One plain line per check, for the phone. */
  checks?: string[];
  media?: ReviewMedia;
  /** Assets and voice: the provider rows the work is saved under, for the card. */
  providers?: ProviderRowUse[];
  /** True for the approval of the finished video: decideNext uses its final point. */
  final?: boolean;
  /** Set by a re-check, so the new card says when it was checked again. */
  recheckedAt?: string;
  /** Lines the owner should read that do not fail the step (a narration longer than its estimate). */
  notes?: string[];
  /** Voice: what the gate found and which fixes the card can offer. */
  voice?: VoiceFix;
  /** Preview: the plan the stills show (the scene spec or the page), shown on the card with the stills. */
  plan?: ReviewPayload["plan"];
  /** The final quality check: which gates failed and whether the style is narrated (payload.qc). */
  qcFacts?: QcFacts;
}

/** What concludeStage decided, worked out before any write. */
interface ConclusionPlan {
  decision: ReturnType<typeof decideNext>;
  base: Record<string, unknown>;
  summary: string;
  issues: string[];
  reason: string;
  detail: Partial<ReviewPayload>;
  autoRevisions: number;
  result: unknown;
}

function planConclusion(run: RunInfo, st: StageRow, template: Template, outcome: StageConclusion): ConclusionPlan {
  const gate = outcome.gate;
  const stage = st.stage;
  const qc = outcome.qc ?? (gate ? combineGates([gate], template, []) : NO_GATE);
  const autoRevisions = typeof st.output.autoRevisions === "number" ? st.output.autoRevisions : 0;
  const feedback = typeof st.output.feedback === "string" ? st.output.feedback : "";
  const common = {
    level: run.level,
    paused: run.paused,
    template,
    qc,
    videosSincePublishSpotCheck: 0,
    attempts: autoRevisions,
  };
  const raw = outcome.final ? decideNext({ ...common, point: "final" }) : decideNext({ ...common, point: "stage", stage });
  // A revision cannot fix a provider terms or render problem, so production stages ask the owner instead.
  const staged = isProductionStage(stage) ? productionDecision(raw) : raw;
  // A trial (and every Hermes render) is never approved or published by the policy: the owner scores and decides.
  const guarded = outcome.final ? guardFinalDecision(staged, run.config.stylePack ?? null, null, runRecipeOf(run.config)) : staged;
  // A review point of the pack's workflow (style.json workflow.review): the owner looks at it whatever the level.
  const decision =
    !outcome.final && alwaysReviewed(run.config, stage) && (guarded.action === "auto-approve" || guarded.action === "auto-publish")
      ? { action: "ask-owner" as const, reason: `This style's workflow has the owner check the ${stageLabel(stage).toLowerCase()} every time` }
      : guarded;
  const base = { result: outcome.result, feedback, autoRevisions, ...(gate ? { gate } : {}), ...(outcome.extra ?? {}) };
  const summary = isProductionStage(stage) ? productionSummary(stage, outcome.result) : stageSummary(stage, outcome.result);
  const issues = outcome.issues ?? (gate && !gate.passed ? gate.issues : []);
  const reason = outcome.final ? finalReason(decision.reason, qc.missingGates as GateId[]) : decision.reason;
  const detail: Partial<ReviewPayload> = {
    ...(outcome.checks ? { checks: outcome.checks } : {}),
    ...(outcome.media ? { media: outcome.media } : {}),
    ...(outcome.providers && outcome.providers.length > 0 ? { providers: outcome.providers } : {}),
    ...(outcome.recheckedAt ? { recheckedAt: outcome.recheckedAt } : {}),
    ...(outcome.notes && outcome.notes.length > 0 ? { notes: outcome.notes } : {}),
    ...(outcome.voice ? { voice: outcome.voice } : {}),
    ...(isPlanStage(stage) ? planReview(stage, outcome.result, runStagesOf(run.config)) : {}),
    ...(outcome.plan ? { plan: outcome.plan } : {}),
    ...(outcome.qcFacts ? { qc: outcome.qcFacts } : {}),
  };
  return { decision, base, summary, issues, reason, detail, autoRevisions, result: outcome.result };
}

/**
 * Writes a planned conclusion inside the caller's transaction. The caller has locked the stage row and checked that
 * it may still be concluded. Returns what it did.
 */
async function applyConclusion(tx: Q, run: RunInfo, st: StageRow, plan: ConclusionPlan): Promise<ConclusionAction> {
  const { decision, base, summary, issues, reason, detail, autoRevisions } = plan;
  const stage = st.stage;
  const store = async (state: string, extra: Record<string, unknown> = {}, error: string | null = null) => {
    await tx`
      UPDATE pipeline_stages SET state = ${state}, output = ${json({ ...base, ...extra })}::text::jsonb, error = ${error}, finished_at = now()
      WHERE id = ${st.id}
    `;
  };

  if (decision.action === "block") {
    await store("failed", {}, decision.reason);
    // Park the run in the inbox so the owner sees it; retry or reject from there.
    await tx`UPDATE pipeline_runs SET state = 'waiting-human' WHERE id = ${run.id}`;
    await insertReview(tx, run.id, st.stage, "stage-error", { summary: `${stageLabel(st.stage)} blocked`, error: decision.reason });
    return "blocked";
  }
  if (decision.action === "revise") {
    await store("failed", {}, issues.join(" ") || decision.reason);
    await insertPending(tx, run.id, st.stage, issuesToFeedback(issues), autoRevisions + 1);
    return "revise";
  }
  if (decision.action === "auto-approve" || decision.action === "auto-publish") {
    if (stage === "idea") {
      const ideas = validateIdeas(plan.result);
      const best = ideas.ok ? pickIdea(ideas.value.ideas) : null;
      if (best) {
        await store("running", { chosenIdea: best, auto: true });
        await approveStage(tx, run.id, st.id, st.stage, {});
        return "approved";
      }
      // Nothing to pick automatically: ask the owner instead.
    } else {
      await store("running", { auto: true });
      await approveStage(tx, run.id, st.id, st.stage, {});
      return "approved";
    }
  }

  // ask-owner (or an idea stage with nothing pickable)
  await store("waiting-human");
  await tx`UPDATE pipeline_runs SET state = 'waiting-human' WHERE id = ${run.id}`;
  if (issues.length > 0) {
    await insertReview(tx, run.id, st.stage, "gate-failure", { summary, issues, reason, ...detail });
    return "gate-failure";
  }
  if (stage === "idea") {
    const ideas = validateIdeas(plan.result);
    await insertReview(tx, run.id, st.stage, "idea", { summary, ideas: ideas.ok ? ideas.value.ideas : [], reason: decision.reason });
  } else {
    await insertReview(tx, run.id, st.stage, "approval", { summary, reason, ...detail });
  }
  return "asked-approval";
}

export async function concludeStage(run: RunInfo, st: StageRow, template: Template, outcome: StageConclusion): Promise<void> {
  const gate = outcome.gate;
  if (gate) await saveQcReport({ result: gate, runId: run.id, details: { stage: st.stage, attempt: st.attempt } });
  const plan = planConclusion(run, st, template, outcome);
  await db().begin(async (tx) => {
    const [live] = await tx`
      SELECT s.id FROM pipeline_stages s JOIN pipeline_runs r ON r.id = s.run_id
      WHERE s.id = ${st.id} AND s.state = 'running' AND r.state = 'running' FOR UPDATE OF s
    `;
    // The run was cancelled or the stage reaped while the model was working: drop the result.
    if (!live) return;
    await applyConclusion(tx, run, st, plan);
  });
}

async function executeStage(runId: string, st: StageRow): Promise<void> {
  const sql = db();
  const run = await loadRun(sql, runId);
  if (!run || run.state !== "running") {
    await sql`UPDATE pipeline_stages SET state = 'skipped', finished_at = now() WHERE id = ${st.id} AND state = 'running'`;
    return;
  }
  const template = run.templateId ? await getTemplate(run.templateId) : null;
  if (!template) {
    await recordStageError(runId, st.id, st.stage, "The run's template no longer exists");
    return;
  }
  if (isProductionStage(st.stage)) {
    await runProductionStage(run, st, template);
    return;
  }
  const feedback = typeof st.output.feedback === "string" ? st.output.feedback : "";
  const outcome = await runModel(run, st, template, feedback);
  if (!outcome.ok) {
    // A stage waiting on its Muse task goes back to pending until the next look; a finished task resumes the run sooner.
    if (outcome.museWait) {
      const w = outcome.museWait;
      await deferRenderPoll(runId, st.id, w.until, { museJobId: w.jobId, ...(w.overflow ? { museOverflow: true } : {}) }, { until: w.until.toISOString(), text: w.text });
      return;
    }
    // A rate-limited or slow Hermes is not a failed stage: it waits and keeps its attempt, up to the give-up cap.
    if (outcome.busyUntil) {
      if (waitExpired(st.output.waitSince, Date.now())) {
        await recordStageError(runId, st.id, st.stage, `${giveUpMessage(undefined, outcome.slow ? "slow" : "rate-limit")} ${outcome.error}`);
      } else if (outcome.slow) {
        await deferStage(runId, st.id, outcome.busyUntil, outcome.error, { slow: { afterMs: outcome.slow.afterMs, streak: slowStreakOf(st.output) + 1 } });
      } else {
        await deferStage(runId, st.id, outcome.busyUntil, outcome.error);
      }
      return;
    }
    await recordStageError(runId, st.id, st.stage, outcome.error);
    return;
  }
  await concludeStage(run, st, template, outcome);
}

/** Runs pending stages one after another until the run needs the owner, fails or finishes the storyboard. Never throws. */
export async function advanceRun(runId: string): Promise<void> {
  try {
    for (let i = 0; i < 24; i++) {
      const st = await claimNext(runId);
      if (!st) return;
      try {
        await executeStage(runId, st);
      } catch (err) {
        console.error("stage failed", runId, st.stage, err);
        try {
          await recordStageError(runId, st.id, st.stage, `Unexpected error: ${errorText(err)}`);
        } catch (inner) {
          console.error("could not record stage error", runId, inner);
          return;
        }
      }
    }
  } catch (err) {
    console.error("advanceRun failed", runId, err);
  }
}

/**
 * Fails stages stuck in running (a restart or crash) and asks the owner, one transaction per stage. Also restarts
 * runs whose pending stage was never claimed (the after() callback was lost). Returns the run ids it touched.
 * Runs only when a page that calls it renders. Never throws.
 */
export async function reapStuckStages(): Promise<string[]> {
  const runIds: string[] = [];
  // Each model stage's own limit (engine.ts MODEL_STAGE_STUCK_MINUTES), from its call timeout and its asks.
  const stuckLimits = json(MODEL_STAGE_STUCK_MINUTES);
  try {
    const sql = db();
    const stuck = await sql`
      SELECT id FROM pipeline_stages
      WHERE state = 'running' AND stage IN ('idea', 'research', 'script', 'storyboard', 'scene-spec', 'skill-brief', 'html-design')
        AND started_at < now() - make_interval(mins => (${stuckLimits}::text::jsonb ->> stage)::int)
    `;
    for (const row of stuck) {
      try {
        const runId = await sql.begin(async (tx): Promise<string | null> => {
          const failed = await tx`
            UPDATE pipeline_stages SET state = 'failed', error = 'The stage stopped answering and was cancelled', finished_at = now()
            WHERE id = ${row.id as string} AND state = 'running' AND started_at < now() - make_interval(mins => (${stuckLimits}::text::jsonb ->> stage)::int)
            RETURNING run_id, stage
          `;
          const f = failed[0];
          if (!f) return null;
          const moved = await tx`UPDATE pipeline_runs SET state = 'waiting-human' WHERE id = ${f.run_id as string} AND state = 'running' RETURNING id`;
          if (moved.length > 0) {
            await insertReview(tx, f.run_id as string, f.stage as string, "stage-error", { summary: `${stageLabel(f.stage as string)} stopped`, error: "The stage stopped answering and was cancelled" });
          }
          return f.run_id as string;
        });
        if (runId) runIds.push(runId);
      } catch (err) {
        console.error("reap failed", row.id, err);
      }
    }
    // Production repairs first: a stage they put back to pending is found by the orphan query below.
    for (const id of await reapProduction()) if (!runIds.includes(id)) runIds.push(id);
    const orphaned = await sql`
      SELECT r.id FROM pipeline_runs r
      WHERE r.state = 'running'
        AND EXISTS (SELECT 1 FROM pipeline_stages p WHERE p.run_id = r.id AND p.state = 'pending' AND p.stage IN ('idea', 'research', 'script', 'storyboard', 'scene-spec', 'skill-brief', 'html-design', 'preview', 'assets', 'voice', 'render', 'qc')
          AND (p.not_before IS NULL OR p.not_before <= now()))
        AND NOT EXISTS (SELECT 1 FROM pipeline_stages q WHERE q.run_id = r.id AND q.state = 'running')
    `;
    for (const r of orphaned) {
      const id = r.id as string;
      if (!runIds.includes(id)) runIds.push(id);
      // claimNext is skip-locked and idempotent, so a second caller racing a live advanceRun is harmless.
      void advanceRun(id);
    }
  } catch (err) {
    console.error("reapStuckStages failed", err);
  }
  return runIds;
}

declare global {
  var __venstudioLastNudge: number | undefined;
}

/** At most one background recovery pass per this many milliseconds from nudgeRecovery. */
const NUDGE_EVERY_MS = 60_000;

/**
 * A throttled reaper call for places that run often without a page (the worker claim route, every ~25 s per held
 * worker). It resumes stages whose wait for Hermes is over and repairs stuck work even when nobody opens a page.
 * Returns at once when a pass ran in the last minute. Never throws.
 */
export async function nudgeRecovery(): Promise<void> {
  const now = Date.now();
  if (globalThis.__venstudioLastNudge !== undefined && now - globalThis.__venstudioLastNudge < NUDGE_EVERY_MS) return;
  globalThis.__venstudioLastNudge = now;
  try {
    await reapStuckStages();
  } catch (err) {
    console.error("nudgeRecovery failed", err);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Owner decisions

export type DecideResult = { ok: true; runId: string; message: string } | { ok: false; error: string };

const CLOSED = "This run is already finished or cancelled";

function approveMessage(stage: RunStage, next: RunStage | null = null): string {
  if (isPlanStage(stage)) {
    const what = stage === "scene-spec" ? "scene spec" : stage === "html-design" ? "page" : "skill brief";
    if (next === "preview") return `Approved. The ${what} is ready and a worker takes still frames of the page next.`;
    return next === "voice" ? `Approved. The ${what} is ready and the studio records the narration next.` : `Approved. The ${what} is ready and Hermes renders the video next.`;
  }
  switch (stage) {
    case "preview":
      return "Approved. The look is approved and the studio records the narration next.";
    case "storyboard":
      return "Approved. The storyboard is ready and asset sourcing comes next.";
    case "assets":
      return "Approved. The studio records the narration next.";
    case "voice":
      return "Approved. The studio renders the video next.";
    case "render":
      return "Approved. The studio checks the video next.";
    case "qc":
      return "Approved. The video is ready.";
    default:
      return "Approved. Hermes continues.";
  }
}

/** Marks the stage the owner was looking at (and anything pending) so a new attempt can start cleanly. */
async function clearOpenStages(tx: Q, runId: string): Promise<void> {
  await tx`UPDATE pipeline_stages SET state = 'skipped', finished_at = now() WHERE run_id = ${runId} AND state IN ('pending', 'waiting-human')`;
}

export async function decideReview(input: {
  reviewId: string;
  decision: ReviewDecision;
  note: string;
  ideaIndex?: number;
  userId: string;
  /** Approve anyway is the owner's alone; the action checks the role too. */
  isOwner?: boolean;
}): Promise<DecideResult> {
  try {
    const sql = db();
    const [rv] = await sql`SELECT id, run_id, stage, kind, state, payload FROM review_items WHERE id = ${input.reviewId}`;
    if (!rv) return { ok: false, error: "Unknown review item" };
    if (rv.state !== "open") return { ok: false, error: "This item was already decided" };
    const runId = rv.run_id as string;
    const kind = rv.kind as ReviewKind;
    const stageText = rv.stage as string;
    if (!isRunStage(stageText)) return { ok: false, error: "This item is not about a stage the studio runs" };
    const stage: RunStage = stageText;
    const decision = input.decision;
    const payload = toObject(rv.payload);
    const storedIssues = Array.isArray(payload.issues) ? payload.issues.filter((i): i is string => typeof i === "string") : [];
    if (decision === "recheck" || decision === "fit") return { ok: false, error: "Use Check again for this" };
    const voiceFix = parseVoiceFix(payload.voice);
    // tempoReady only matters for "fit", which goes through recheckReview.
    const qcFacts = parseQcFacts(payload.qc);
    // Whether a failed Hermes-skill render may move to Muse: the run renders with Hermes and has its own narration.
    const [cfgRow] = await sql`SELECT config FROM pipeline_runs WHERE id = ${runId}`;
    const cfg0 = parseRunConfig(cfgRow?.config);
    const museRender = cfg0.stylePack?.engine === "hermes" && runStagesOf(cfg0).includes("voice") && !runsOnMuse(cfg0.executors, "render");
    const refused = decisionRefusal(kind, decision, { stage, issues: storedIssues, voice: voiceFix, tempoReady: true, qc: qcFacts, museRender, isOwner: input.isOwner === true });
    if (refused) return { ok: false, error: refused };
    // Retry on Muse: said up front when no Muse worker has this skill, so nothing changes on the run.
    if (decision === "muse") {
      const ready = cfg0.stylePack ? await museRenderReadiness(cfg0.stylePack.id) : { refusals: ["This run has no style pack"], skill: null };
      if (ready.refusals.length > 0) return { ok: false, error: `Muse cannot render this video yet. ${ready.refusals.join(". ")}` };
    }
    // A trial's final video is scored by the owner before it is decided (the curation log needs the score).
    if (stage === "qc") {
      const refusal = await scoreRefusal(input.reviewId, decision);
      if (refusal) return { ok: false, error: refusal };
    }
    const note = input.note.trim().slice(0, MAX_NOTE_CHARS);
    // The run's own stage list: revisions land on a stage this run has (a scene-spec run has no storyboard).
    const [runCfg] = await sql`SELECT config FROM pipeline_runs WHERE id = ${runId}`;
    const runConfig = parseRunConfig(runCfg?.config);
    const stages = runStagesOf(runConfig);
    // A run whose video Hermes renders (its pack's engine, or the renderer its last video was made with): notes on the
    // video go back to Hermes, with the note, instead of to the voice.
    const [lastRender] = await sql`SELECT output->>'renderer' AS renderer FROM pipeline_stages WHERE run_id = ${runId} AND stage = 'render' ORDER BY attempt DESC LIMIT 1`;
    const hermesRender = runConfig.stylePack?.engine === "hermes" || lastRender?.renderer === "hermes";

    let target: RunStage = stage;
    // A script fit: Hermes rewrites the script to a length that fits and only the voice is made again. Asked for with
    // the button, or with a revision note about length or speed on a voice card.
    let fit: { direction: LengthDirection } | null = decision === "tighten" ? { direction: "fit" } : null;
    let fitRequest: Record<string, unknown> | null = null;
    if (decision === "revise" && stage === "voice" && note) {
      const route = voiceRevisionRoute(note);
      if (route?.route === "tighten") fit = { direction: route.direction };
    }
    if (fit) {
      const planned = await planScriptFit(sql, runId, fit.direction, decision === "revise" ? note : "");
      if (planned.ok) fitRequest = { ...planned.request };
      // The button needs a plan. A note that cannot be planned is sorted like any other revision note.
      else if (decision === "tighten") return { ok: false, error: planned.error };
    }
    if (decision === "revise" && !fitRequest) {
      if (!note) return { ok: false, error: "Write what should change" };
      if (stage === "voice" && voiceRevisionRoute(note)?.route === "voice") {
        target = "voice";
      } else if (isProductionStage(stage)) {
        // The Hermes classifier only knows the four director stages, so production notes are sorted by keywords.
        target = revisionTarget(null, note, stage, stages, { renderer: hermesRender ? "hermes" : null });
      } else {
        // A scene spec or skill brief is asked about as the storyboard it stands for; the answer maps back to the run's list.
        const c = await hermesJson(classifyPrompt(note, isPlanStage(stage) ? "storyboard" : stage), validateClassification, { retries: 1, timeoutMs: 45_000, queueTimeoutMs: 5_000 });
        target = revisionTarget(c.ok ? c.value.stage : null, note, stage, stages);
      }
    }
    let chosen: Idea | null = null;
    if (decision === "approve" && kind === "idea") {
      const ideas = Array.isArray(payload.ideas) ? payload.ideas.map(asIdea).filter((i): i is Idea => i !== null) : [];
      const idx = input.ideaIndex;
      if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= ideas.length) return { ok: false, error: "Choose one of the ideas" };
      chosen = ideas[idx];
    }

    const newState = decision === "approve" || decision === "override" ? "approved" : decision === "reject" ? "rejected" : "revision";
    let message = "";
    await sql.begin(async (tx) => {
      const [run] = await tx`SELECT state FROM pipeline_runs WHERE id = ${runId} FOR UPDATE`;
      if (!run || (run.state !== "waiting-human" && run.state !== "running")) throw new DecisionError(CLOSED);
      const claimed = await tx`
        UPDATE review_items SET state = ${newState}, note = ${note}, decided_by = ${input.userId}, decided_at = now()
        WHERE id = ${input.reviewId} AND state = 'open' RETURNING id
      `;
      if (claimed.length === 0) throw new DecisionError("This item was already decided");
      const [latest] = await tx`SELECT id, state, output FROM pipeline_stages WHERE run_id = ${runId} AND stage = ${stage} ORDER BY attempt DESC LIMIT 1 FOR UPDATE`;
      if (!latest) throw new DecisionError("The stage no longer exists");

      if (decision === "approve") {
        if (latest.state !== "waiting-human") throw new DecisionError("This stage is no longer waiting for you");
        await approveStage(tx, runId, latest.id as string, stage, chosen ? { chosenIdea: chosen, auto: false } : { auto: false });
        message = approveMessage(stage, nextRunStage(stage, stages));
        return;
      }
      if (decision === "override") {
        // Only offered for soft voice problems and for a final check whose failures may be waived (decisionOptions);
        // never for provider terms, clipping, language, provenance or a silent narrated video.
        if (latest.state !== "waiting-human") throw new DecisionError("This stage is no longer waiting for you");
        await approveStage(tx, runId, latest.id as string, stage, { auto: false, override: { by: input.userId, at: new Date().toISOString(), issues: storedIssues } });
        message = `Approved anyway. ${approveMessage(stage, nextRunStage(stage, stages)).replace(/^Approved\. /, "")}`;
        return;
      }
      if (fitRequest) {
        await supersedeOpenReviews(tx, runId);
        await clearOpenStages(tx, runId);
        // No work order and no storyboard changes: the pictures are kept, only the script and the voice are redone.
        await insertPending(tx, runId, "voice", note, 0, { tighten: fitRequest });
        await tx`UPDATE pipeline_runs SET state = 'running' WHERE id = ${runId}`;
        const secs = typeof fitRequest.targetSec === "number" ? Math.round(fitRequest.targetSec) : 0;
        const kept = stages.includes("assets") ? "The storyboard and every image are kept" : stages.includes("scene-spec") ? "The scene spec is kept" : stages.includes("html-design") ? "The page is kept" : "The plan is kept";
        message = `Hermes is fitting the script to about ${secs} seconds. ${kept}; only the voice is recorded again.`;
        return;
      }
      if (decision === "reject") {
        await supersedeOpenReviews(tx, runId);
        await clearOpenStages(tx, runId);
        await cancelRunWork(tx, runId);
        await tx`UPDATE pipeline_runs SET state = 'cancelled', finished_at = now() WHERE id = ${runId}`;
        message = "Rejected. The run is cancelled.";
        return;
      }
      if (decision === "muse") {
        // From now on this run's video is rendered on Muse; the script, brief and narration are kept.
        await tx`
          UPDATE pipeline_runs SET config = jsonb_set(config, '{executors}', coalesce(config->'executors', '{}'::jsonb) || '{"render":"muse"}'::jsonb)
          WHERE id = ${runId}
        `;
        await supersedeOpenReviews(tx, runId);
        await clearOpenStages(tx, runId);
        await insertPending(tx, runId, "render", "", 0);
        await tx`UPDATE pipeline_runs SET state = 'running' WHERE id = ${runId}`;
        message = "Sent to Muse. A Muse worker renders this video with the same skill.";
        return;
      }
      if (decision === "retry") {
        const issues = Array.isArray(payload.issues) ? payload.issues.filter((i): i is string => typeof i === "string") : [];
        const again = retryStageFor(stage, kind);
        await supersedeOpenReviews(tx, runId);
        await clearOpenStages(tx, runId);
        // Only the shots that failed run again; finished images are kept.
        if (again === "assets") await resetFailedOrders(tx, runId);
        // A voice stage that stopped while fitting the script asks Hermes again; once the script is fitted it is not.
        const latestOut = toObject(latest.output);
        const carry = again === "voice" && isRecord(latestOut.tighten) ? { tighten: latestOut.tighten } : {};
        await insertPending(tx, runId, again, issuesToFeedback(issues), 0, carry);
        await tx`UPDATE pipeline_runs SET state = 'running' WHERE id = ${runId}`;
        message = again === stage ? "Trying again." : `Trying again from the ${stageLabel(again).toLowerCase()} step.`;
        return;
      }
      // revise
      await supersedeOpenReviews(tx, runId);
      await clearOpenStages(tx, runId);
      // New notes about the images restart every shot, and the note reaches the image prompt as data.
      if (target === "assets") await resetOrdersForRevision(tx, runId, note);
      // A Hermes render made again for the owner's note: the note reaches Hermes's start ask (as a DATA block), with
      // the previous file's name, and a new file is asked for.
      await insertPending(tx, runId, target, note, 0, target === "render" && hermesRender ? { ownerNote: note } : {});
      await tx`UPDATE pipeline_runs SET state = 'running' WHERE id = ${runId}`;
      const onVideo = stage === "render" || stage === "qc" ? videoRevisionMessage(target, { hermesRender }) : null;
      message = onVideo ?? (target === stage ? "Revision sent. Hermes is redoing this step." : `Revision sent. Hermes goes back to the ${stageLabel(target).toLowerCase()} step.`);
    });
    // The owner's final decision on a Trial pack's video goes into the curation log.
    if (stage === "qc") await recordTrialOutcome(runId);
    const action = fitRequest ? "review.fit-script" : `review.${decision}`;
    await safeAudit({ userId: input.userId, action, target: input.reviewId, detail: { runId, stage, kind, ...(decision === "override" ? { issues: storedIssues } : {}), ...(decision === "override" && stage === "qc" ? { waived: "quality check" } : {}), ...(fitRequest ? { fit: fitRequest } : {}) } });
    return { ok: true, runId, message };
  } catch (err) {
    if (err instanceof DecisionError) return { ok: false, error: err.message };
    console.error("decideReview failed", err);
    return { ok: false, error: `Could not save the decision: ${errorText(err)}` };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Checking provider terms again

export type RecheckResult =
  | { ok: true; runId: string; action: ConclusionAction; message: string }
  | { ok: false; error: string };

/**
 * Runs only the gate again on an assets or voice card held up by provider terms: the images or the narration that
 * are already made are checked against the terms as they are now. No work order is touched and nothing is made or
 * recorded again. If the gate passes, the stage concludes as concludeStage would (an approval card, or the run goes
 * on when the autonomy level allows it); if not, the card is replaced by a new one naming what still blocks.
 *
 * Locking follows decideReview: the run row, then the review item, then the latest stage row, all FOR UPDATE in one
 * transaction, and the terms are read inside it. A second click, or the automatic re-check racing the owner, finds
 * the card no longer open and changes nothing. Safe to repeat. userId is null for the automatic re-check.
 */
export async function recheckReview(input: { reviewId: string; userId: string | null; fit?: boolean }): Promise<RecheckResult> {
  try {
    const sql = db();
    const [rv] = await sql`SELECT run_id, stage FROM review_items WHERE id = ${input.reviewId}`;
    if (!rv) return { ok: false, error: "Unknown review item" };
    const runId = rv.run_id as string;
    const stageText = rv.stage as string;
    if (!isTermsStage(stageText)) return { ok: false, error: "Only an assets card held up by provider terms, a voice card that did not pass, or a reel held up by its voice's terms can be checked again." };
    const stage = stageText;
    const fit = input.fit === true;
    if (fit && stage !== "voice") return { ok: false, error: "Only a voice card can be fitted to the video." };
    // A fitted narration is played at its tempo by the worker, so every render worker must be able to (0.6.0+).
    const pre = await loadRun(sql, runId);
    const template = pre?.templateId ? await getTemplate(pre.templateId) : null;
    if (!pre || !template) return { ok: false, error: "The run or its template no longer exists" };
    if (fit && !(await narrationTempoReady())) {
      return { ok: false, error: `Fitting the narration needs worker 0.6.0 or later on every render worker. Update the worker, or use ${tightenLabel(runStagesOf(pre.config).includes("assets"))}.` };
    }

    const recheckedAt = new Date().toISOString();
    const done = await sql.begin(async (tx): Promise<{ action: ConclusionAction; gate: GateResult | null; stillBlocking: string[]; attempt: number; tempo: number }> => {
      const [runRow] = await tx`SELECT state FROM pipeline_runs WHERE id = ${runId} FOR UPDATE`;
      const [item] = await tx`SELECT state, kind, payload FROM review_items WHERE id = ${input.reviewId} FOR UPDATE`;
      const [latest] = await tx`SELECT id, state, attempt, output FROM pipeline_stages WHERE run_id = ${runId} AND stage = ${stage} ORDER BY attempt DESC LIMIT 1 FOR UPDATE`;
      const payload = toObject(item?.payload);
      const issues = Array.isArray(payload.issues) ? payload.issues.filter((i): i is string => typeof i === "string") : [];
      const refusal = recheckRefusal({
        reviewState: item ? (item.state as string) : "missing",
        kind: (item?.kind as ReviewKind | undefined) ?? "stage-error",
        stage,
        issues,
        runState: runRow ? (runRow.state as string) : "missing",
        stageState: latest ? (latest.state as string) : null,
      });
      if (refusal) throw new DecisionError(refusal);
      // Autonomy level and pause as they are now, read under the run lock.
      const run = await loadRun(tx, runId);
      if (!run) throw new DecisionError(CLOSED);
      const st: StageRow = { id: latest.id as string, stage, attempt: latest.attempt as number, output: toObject(latest.output) };
      const terms = await listProviderTermsIn(tx);
      const checked = await recheckConclusion(tx, run, st, template, terms, { fit });
      if (!checked.ok) throw new DecisionError(checked.error);
      const stillBlocking = blockingRows(checked.conclusion.providers ?? [], terms).map((b) => b.name);
      const what = fit ? "Fitted the narration to the video" : stage === "voice" ? "Checked again" : "Checked the terms again";
      await tx`
        UPDATE review_items SET state = 'superseded', note = ${what}, decided_by = ${input.userId}, decided_at = now()
        WHERE id = ${input.reviewId} AND state = 'open'
      `;
      // approveStage moves a waiting run back to running; the gate-failure path parks it again.
      await tx`UPDATE pipeline_runs SET state = 'running' WHERE id = ${runId}`;
      const action = await applyConclusion(tx, run, st, planConclusion(run, st, template, { ...checked.conclusion, recheckedAt }));
      const tempo = fit ? (checked.conclusion.voice?.tempo ?? 1) : 1;
      return { action, gate: checked.conclusion.gate, stillBlocking, attempt: st.attempt, tempo };
    });
    if (done.gate) {
      await saveQcReport({ result: done.gate, runId, details: { stage, attempt: done.attempt, recheck: true, ...(fit ? { tempo: done.tempo } : {}) } }).catch((err) => console.error("recheck: qc report failed", err));
    }
    await safeAudit({ userId: input.userId, action: fit ? "review.fit" : "review.recheck", target: input.reviewId, detail: { runId, stage, outcome: done.action, ...(fit ? { tempo: done.tempo } : {}) } });
    const message = fit ? fitMessage(done.tempo, done.action) : recheckMessage(stage, done.action, done.stillBlocking);
    return { ok: true, runId, action: done.action, message };
  } catch (err) {
    if (err instanceof DecisionError) return { ok: false, error: err.message };
    console.error("recheckReview failed", err);
    return { ok: false, error: `Could not check the terms again: ${errorText(err)}` };
  }
}

/** Most open items one terms change re-checks. Each is a few small queries; nothing calls Hermes or a worker. */
const AUTO_RECHECK_LIMIT = 10;

/**
 * After the owner changes a provider's terms (on a card or in Settings): re-checks every open assets or voice card
 * whose only issues are provider terms and whose work is saved under that row. Bounded, best effort, never throws.
 * Returns the runs that moved on, so the caller can let advanceRun continue them.
 */
export async function recheckTermsReviews(changed: { name: string; kind: ProviderKind }, userId: string | null): Promise<{ checked: number; runIds: string[] }> {
  const runIds: string[] = [];
  let checked = 0;
  try {
    const rows = await db()`
      SELECT id, stage, kind, payload FROM review_items
      WHERE state = 'open' AND kind = 'gate-failure' AND stage IN ('assets', 'voice', 'render')
      ORDER BY created_at LIMIT 50
    `;
    const items = rows
      .map((r) => ({ id: r.id as string, stage: r.stage as string, kind: r.kind as ReviewKind, payload: reviewPayloadOf(r.payload) }))
      .filter((r) => autoRecheckMatches(r, changed))
      .slice(0, AUTO_RECHECK_LIMIT);
    for (const item of items) {
      const r = await recheckReview({ reviewId: item.id, userId });
      checked++;
      if (r.ok && r.action === "approved" && !runIds.includes(r.runId)) runIds.push(r.runId);
    }
  } catch (err) {
    console.error("recheckTermsReviews failed", err);
  }
  return { checked, runIds };
}

/** The parts of a stored payload the automatic re-check reads. */
function reviewPayloadOf(raw: unknown): { issues?: string[]; providers?: ProviderRowUse[]; media?: ReviewMedia } {
  const p = toObject(raw);
  const out: { issues?: string[]; providers?: ProviderRowUse[]; media?: ReviewMedia } = {};
  if (Array.isArray(p.issues)) out.issues = p.issues.filter((i): i is string => typeof i === "string");
  const used = parseProviderRows(p.providers);
  if (used.length > 0) out.providers = used;
  const m = toObject(p.media);
  const media: ReviewMedia = {};
  if (Array.isArray(m.images)) {
    media.images = m.images.map(toObject).map((i) => ({ assetId: String(i.assetId ?? ""), shotRef: String(i.shotRef ?? ""), provider: String(i.provider ?? "") }));
  }
  if (typeof m.voiceProvider === "string") media.voiceProvider = m.voiceProvider;
  out.media = media;
  return out;
}

/** Cancels a run on the owner's request. Safe to repeat. */
export async function cancelRun(runId: string, userId: string): Promise<DecideResult> {
  try {
    const sql = db();
    let changed = false;
    await sql.begin(async (tx) => {
      const [run] = await tx`SELECT state FROM pipeline_runs WHERE id = ${runId} FOR UPDATE`;
      if (!run || run.state === "cancelled" || run.state === "done") return;
      await supersedeOpenReviews(tx, runId);
      await clearOpenStages(tx, runId);
      await tx`UPDATE pipeline_stages SET state = 'skipped', finished_at = now() WHERE run_id = ${runId} AND state = 'running'`;
      await cancelRunWork(tx, runId);
      await tx`UPDATE pipeline_runs SET state = 'cancelled', finished_at = now() WHERE id = ${runId}`;
      changed = true;
    });
    if (!changed) return { ok: false, error: CLOSED };
    await safeAudit({ userId, action: "run.cancel", target: runId });
    return { ok: true, runId, message: "The run is cancelled." };
  } catch (err) {
    console.error("cancelRun failed", err);
    return { ok: false, error: `Could not cancel the run: ${errorText(err)}` };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Self test

/** Runs a tiny structured prompt so the owner can see whether this Hermes returns usable JSON. */
export async function testHermesJson(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await hermesJson(selfTestPrompt(), validateSelfTest, { retries: 1, timeoutMs: 60_000, queueTimeoutMs: 30_000 });
    if (r.ok) return { ok: true, detail: `Hermes returned valid JSON (${r.attempts === 1 ? "first try" : `after ${r.attempts} tries`}).` };
    return { ok: false, detail: r.error };
  } catch (err) {
    return { ok: false, detail: `The test could not run: ${errorText(err)}` };
  }
}
