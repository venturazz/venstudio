import "server-only";
import type { Sql } from "postgres";
import { db } from "./db.ts";
import { audit } from "./audit.ts";
import { saveQcReport } from "./qc.ts";
import { ensureSeedTemplates, getTemplate } from "./templates.ts";
import { hermesJson } from "./hermes-json.ts";
import { decideNext, type AutonomyLevel } from "../studio/autonomy.ts";
import { combineGates, scriptGate, storyboardGate, type CombinedQc, type GateResult } from "../studio/qc.ts";
import type { Format } from "../studio/catalog.ts";
import type { Template } from "../studio/templates.ts";
import {
  MAX_NOTE_CHARS,
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
  type DirectorStage,
  type Idea,
  type ResearchNote,
} from "../studio/director.ts";
import { DEFAULT_DURATION_SEC, isEngineStage, nextStage, revisionTarget, stageSummary, STUCK_MINUTES } from "../studio/engine.ts";
import { decisionOptions, reviewTitle, stageLabel, type ReviewDecision, type ReviewKind, type ReviewPayload } from "../studio/review.ts";

/**
 * The Hermes director engine: idea, research, script and storyboard as stages of a pipeline run.
 * Model output is validated data and is never executed. This module only reads channels; the category, home
 * worker and autonomy level are set by the owner alone. Work orders are created, never executed (Phase 4).
 */

/** A transaction handle is accepted wherever a connection is. */
type Q = Sql;

interface RunConfig {
  format: Format;
  language: string;
  durationSec: number;
  themeId: string;
  styleId: string;
  purposes: string[];
  topicHint: string;
}

interface RunInfo {
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

interface StageRow {
  id: string;
  stage: DirectorStage;
  attempt: number;
  output: Record<string, unknown>;
}

const DIRECTOR_STAGE_SQL = "('idea', 'research', 'script', 'storyboard')";
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

function parseConfig(raw: unknown): RunConfig {
  const c = toObject(raw);
  const format: Format = c.format === "long" ? "long" : "short";
  return {
    format,
    language: typeof c.language === "string" && c.language ? c.language : "en",
    durationSec: typeof c.durationSec === "number" && c.durationSec > 0 ? c.durationSec : DEFAULT_DURATION_SEC[format],
    themeId: typeof c.themeId === "string" ? c.themeId : "",
    styleId: typeof c.styleId === "string" ? c.styleId : "",
    purposes: Array.isArray(c.purposes) ? c.purposes.filter((p): p is string => typeof p === "string") : [],
    topicHint: typeof c.topicHint === "string" ? c.topicHint : "",
  };
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

async function loadRun(sql: Q, runId: string): Promise<RunInfo | null> {
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
    config: parseConfig(r.config),
    niche: (r.niche as string | null) ?? "",
    plan: (r.plan as string | null) ?? "",
    category: (r.category as string | null) ?? "",
  };
}

async function latestPassedOutput(sql: Q, runId: string, stage: DirectorStage): Promise<Record<string, unknown> | null> {
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
async function insertPending(sql: Q, runId: string, stage: string, feedback: string, autoRevisions: number): Promise<void> {
  await sql`
    INSERT INTO pipeline_stages (run_id, stage, attempt, output)
    SELECT ${runId}::uuid, ${stage}::text, COALESCE(MAX(attempt), 0) + 1, ${json({ feedback, autoRevisions })}::text::jsonb
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

export async function startRun(input: {
  channelId: string;
  templateId: string;
  format: Format;
  language: string;
  topic: string;
  userId: string;
}): Promise<StartResult> {
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

    const topic = input.topic.trim().slice(0, 300);
    const config: RunConfig = {
      format: input.format,
      language: input.language,
      durationSec: DEFAULT_DURATION_SEC[input.format],
      themeId: (c.category as string | null) ?? "",
      styleId: template.styleId,
      purposes: [],
      topicHint: topic,
    };
    const level = toLevel(c.autonomy_level);
    const runId = await sql.begin(async (tx) => {
      const [row] = await tx`
        INSERT INTO pipeline_runs (channel_id, template_id, template_version, topic, autonomy_level, config)
        VALUES (${input.channelId}, ${tpl.id}, ${tpl.version}, ${topic}, ${level}, ${json(config)}::text::jsonb)
        RETURNING id
      `;
      const id = row.id as string;
      await insertPending(tx, id, "idea", "", 0);
      return id;
    });
    await safeAudit({ userId: input.userId, action: "run.start", target: runId, detail: { channelId: input.channelId, templateId: template.id, format: input.format } });
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
    UPDATE pipeline_stages s SET state = 'running', started_at = now(), error = NULL
    WHERE s.id = (
      SELECT p.id FROM pipeline_stages p JOIN pipeline_runs r ON r.id = p.run_id
      WHERE p.run_id = ${runId} AND p.state = 'pending' AND r.state = 'running' AND p.stage IN ('idea', 'research', 'script', 'storyboard')
      ORDER BY p.attempt, p.id LIMIT 1 FOR UPDATE OF p SKIP LOCKED
    ) AND s.state = 'pending'
    RETURNING s.id, s.stage, s.attempt, s.output
  `;
  const r = rows[0];
  if (!r || !isEngineStage(r.stage as string)) return null;
  return { id: r.id as string, stage: r.stage as DirectorStage, attempt: r.attempt as number, output: toObject(r.output) };
}

type StageOutcome = { ok: true; result: unknown; gate: GateResult | null } | { ok: false; error: string };

function fromHermes<T>(r: { ok: true; value: T } | { ok: false; error: string }): { ok: true; value: T } | { ok: false; error: string } {
  return r.ok ? { ok: true, value: r.value } : { ok: false, error: r.error };
}

async function runModel(run: RunInfo, st: StageRow, template: Template, feedback: string): Promise<StageOutcome> {
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
  };
  const hint = feedback || undefined;

  if (st.stage === "idea") {
    const r = fromHermes(await hermesJson(ideaPrompt(ctx, hint), validateIdeas));
    return r.ok ? { ok: true, result: r.value, gate: null } : r;
  }

  const ideaOut = await latestPassedOutput(sql, run.id, "idea");
  const idea = ideaOut ? asIdea(ideaOut.chosenIdea) : null;
  if (!idea) return { ok: false, error: "No idea has been chosen for this run" };

  if (st.stage === "research") {
    const r = fromHermes(await hermesJson(researchPrompt(ctx, idea, hint), validateResearch));
    return r.ok ? { ok: true, result: r.value, gate: null } : r;
  }

  const researchOut = await latestPassedOutput(sql, run.id, "research");
  const checkedNotes = validateResearch(researchOut?.result);
  const notes: ResearchNote[] = checkedNotes.ok ? checkedNotes.value.notes : [];

  if (st.stage === "script") {
    const r = fromHermes(await hermesJson(scriptPrompt(ctx, idea, notes, hint), validateScript));
    if (!r.ok) return r;
    const needs = requiresSources(run.config.themeId, run.config.purposes);
    // When sources are required only sourced notes count as sources; otherwise every note is checked for copying.
    const sources = notes.filter((n) => !needs || n.sourced).map((n) => `${n.claim} ${n.summary}`);
    const gate = scriptGate({
      script: r.value.script,
      hooks: r.value.hooks,
      format: run.config.format,
      durationSec: run.config.durationSec,
      wordsPerMinute: wordsPerMinuteFor(template),
      sources,
      requiresSources: needs,
    });
    return { ok: true, result: r.value, gate };
  }

  const scriptOut = await latestPassedOutput(sql, run.id, "script");
  const checkedScript = validateScript(scriptOut?.result);
  if (!checkedScript.ok) return { ok: false, error: "The approved script is missing" };
  const r = fromHermes(await hermesJson(storyboardPrompt(ctx, checkedScript.value.script, hint), validateStoryboard));
  if (!r.ok) return r;
  return { ok: true, result: r.value, gate: storyboardGate(template, r.value.shots) };
}

/**
 * Marks a stage passed and starts the next one. After the storyboard it creates the work orders and leaves the
 * assets stage pending: Phase 4 picks it up. Runs inside the caller's transaction.
 */
async function approveStage(tx: Q, runId: string, stageId: string, stage: DirectorStage, extra: Record<string, unknown>): Promise<void> {
  const [row] = await tx`SELECT output FROM pipeline_stages WHERE id = ${stageId} FOR UPDATE`;
  if (!row) throw new DecisionError("The stage no longer exists");
  const output = { ...toObject(row.output), ...extra };
  await tx`UPDATE pipeline_stages SET state = 'passed', output = ${json(output)}::text::jsonb, finished_at = now() WHERE id = ${stageId}`;
  const chosen = asIdea(output.chosenIdea);
  if (stage === "idea" && chosen) await tx`UPDATE pipeline_runs SET topic = ${chosen.title.slice(0, 300)} WHERE id = ${runId}`;
  const next = nextStage(stage);
  if (next) {
    await insertPending(tx, runId, next, "", 0);
  } else {
    const board = validateStoryboard(output.result);
    if (!board.ok) throw new DecisionError("The storyboard could not be read back");
    await tx`DELETE FROM work_orders WHERE run_id = ${runId} AND stage = 'assets' AND state = 'pending' AND job_id IS NULL`;
    for (const w of workOrdersFromStoryboard(board.value.shots)) {
      await tx`
        INSERT INTO work_orders (run_id, stage, shot_ref, executor, spec)
        VALUES (${runId}, 'assets', ${w.shotRef}, ${w.executor}, ${json(w.spec)}::text::jsonb)
      `;
    }
    await insertPending(tx, runId, "assets", "", 0);
  }
  await tx`UPDATE pipeline_runs SET state = 'running' WHERE id = ${runId} AND state = 'waiting-human'`;
}

async function recordStageError(runId: string, stageId: string, stage: DirectorStage, message: string): Promise<void> {
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

async function concludeStage(run: RunInfo, st: StageRow, template: Template, outcome: { result: unknown; gate: GateResult | null }): Promise<void> {
  const gate = outcome.gate;
  if (gate) await saveQcReport({ result: gate, runId: run.id, details: { stage: st.stage, attempt: st.attempt } });
  const qc = gate ? combineGates([gate], template, []) : NO_GATE;
  const autoRevisions = typeof st.output.autoRevisions === "number" ? st.output.autoRevisions : 0;
  const feedback = typeof st.output.feedback === "string" ? st.output.feedback : "";
  const decision = decideNext({
    point: "stage",
    stage: st.stage,
    level: run.level,
    paused: run.paused,
    template,
    qc,
    videosSincePublishSpotCheck: 0,
    attempts: autoRevisions,
  });
  const base = { result: outcome.result, feedback, autoRevisions, ...(gate ? { gate } : {}) };
  const summary = stageSummary(st.stage, outcome.result);
  const issues = gate && !gate.passed ? gate.issues : [];

  await db().begin(async (tx) => {
    const [live] = await tx`
      SELECT s.id FROM pipeline_stages s JOIN pipeline_runs r ON r.id = s.run_id
      WHERE s.id = ${st.id} AND s.state = 'running' AND r.state = 'running' FOR UPDATE OF s
    `;
    // The run was cancelled or the stage reaped while the model was working: drop the result.
    if (!live) return;
    const store = async (state: string, extra: Record<string, unknown> = {}, error: string | null = null) => {
      await tx`
        UPDATE pipeline_stages SET state = ${state}, output = ${json({ ...base, ...extra })}::text::jsonb, error = ${error}, finished_at = now()
        WHERE id = ${st.id}
      `;
    };

    if (decision.action === "block") {
      await store("failed", {}, decision.reason);
      await tx`UPDATE pipeline_runs SET state = 'failed', finished_at = now() WHERE id = ${run.id}`;
      return;
    }
    if (decision.action === "revise") {
      await store("failed", {}, issues.join(" ") || decision.reason);
      await insertPending(tx, run.id, st.stage, issuesToFeedback(issues), autoRevisions + 1);
      return;
    }
    if (decision.action === "auto-approve" || decision.action === "auto-publish") {
      if (st.stage === "idea") {
        const ideas = validateIdeas(outcome.result);
        const best = ideas.ok ? pickIdea(ideas.value.ideas) : null;
        if (best) {
          await store("running", { chosenIdea: best, auto: true });
          await approveStage(tx, run.id, st.id, st.stage, {});
          return;
        }
        // Nothing to pick automatically: ask the owner instead.
      } else {
        await store("running", { auto: true });
        await approveStage(tx, run.id, st.id, st.stage, {});
        return;
      }
    }

    // ask-owner (or an idea stage with nothing pickable)
    await store("waiting-human");
    await tx`UPDATE pipeline_runs SET state = 'waiting-human' WHERE id = ${run.id}`;
    if (issues.length > 0) {
      await insertReview(tx, run.id, st.stage, "gate-failure", { summary, issues, reason: decision.reason });
    } else if (st.stage === "idea") {
      const ideas = validateIdeas(outcome.result);
      await insertReview(tx, run.id, st.stage, "idea", { summary, ideas: ideas.ok ? ideas.value.ideas : [], reason: decision.reason });
    } else {
      await insertReview(tx, run.id, st.stage, "approval", { summary, reason: decision.reason });
    }
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
  const feedback = typeof st.output.feedback === "string" ? st.output.feedback : "";
  const outcome = await runModel(run, st, template, feedback);
  if (!outcome.ok) {
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

/** Fails stages stuck in running (a restart or crash) and asks the owner. Returns the affected run ids. Never throws. */
export async function reapStuckStages(): Promise<string[]> {
  try {
    const sql = db();
    const stuck = await sql`
      UPDATE pipeline_stages SET state = 'failed', error = 'The stage stopped answering and was cancelled', finished_at = now()
      WHERE state = 'running' AND started_at < now() - make_interval(mins => ${STUCK_MINUTES}::int) AND stage IN ('idea', 'research', 'script', 'storyboard')
      RETURNING run_id, stage
    `;
    const runIds: string[] = [];
    for (const r of stuck) {
      const runId = r.run_id as string;
      const stage = r.stage as string;
      try {
        await sql.begin(async (tx) => {
          const moved = await tx`UPDATE pipeline_runs SET state = 'waiting-human' WHERE id = ${runId} AND state = 'running' RETURNING id`;
          if (moved.length === 0) return;
          await insertReview(tx, runId, stage, "stage-error", { summary: `${stageLabel(stage)} stopped`, error: "The stage stopped answering and was cancelled" });
        });
        runIds.push(runId);
      } catch (err) {
        console.error("reap failed", runId, err);
      }
    }
    return runIds;
  } catch (err) {
    console.error("reapStuckStages failed", err);
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Owner decisions

export type DecideResult = { ok: true; runId: string; message: string } | { ok: false; error: string };

const CLOSED = "This run is already finished or cancelled";

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
}): Promise<DecideResult> {
  try {
    const sql = db();
    const [rv] = await sql`SELECT id, run_id, stage, kind, state, payload FROM review_items WHERE id = ${input.reviewId}`;
    if (!rv) return { ok: false, error: "Unknown review item" };
    if (rv.state !== "open") return { ok: false, error: "This item was already decided" };
    const runId = rv.run_id as string;
    const kind = rv.kind as ReviewKind;
    const stageText = rv.stage as string;
    if (!isEngineStage(stageText)) return { ok: false, error: "This item is not about a stage Hermes runs" };
    const stage: DirectorStage = stageText;
    const decision = input.decision;
    if (!decisionOptions(kind).includes(decision)) return { ok: false, error: `${reviewTitle(kind, stage)}: that choice is not available here` };
    const note = input.note.trim().slice(0, MAX_NOTE_CHARS);
    const payload = toObject(rv.payload);

    let target: DirectorStage = stage;
    if (decision === "revise") {
      if (!note) return { ok: false, error: "Write what should change" };
      const c = await hermesJson(classifyPrompt(note, stage), validateClassification, { retries: 1, timeoutMs: 45_000 });
      target = revisionTarget(c.ok ? c.value.stage : null, note, stage);
    }
    let chosen: Idea | null = null;
    if (decision === "approve" && kind === "idea") {
      const ideas = Array.isArray(payload.ideas) ? payload.ideas.map(asIdea).filter((i): i is Idea => i !== null) : [];
      const idx = input.ideaIndex;
      if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx >= ideas.length) return { ok: false, error: "Choose one of the ideas" };
      chosen = ideas[idx];
    }

    const newState = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "revision";
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
        message = stage === "storyboard" ? "Approved. The storyboard is ready and asset sourcing comes next." : "Approved. Hermes continues.";
        return;
      }
      if (decision === "reject") {
        await supersedeOpenReviews(tx, runId);
        await clearOpenStages(tx, runId);
        await tx`UPDATE work_orders SET state = 'cancelled' WHERE run_id = ${runId} AND state = 'pending'`;
        await tx`UPDATE pipeline_runs SET state = 'cancelled', finished_at = now() WHERE id = ${runId}`;
        message = "Rejected. The run is cancelled.";
        return;
      }
      if (decision === "retry") {
        const issues = Array.isArray(payload.issues) ? payload.issues.filter((i): i is string => typeof i === "string") : [];
        await supersedeOpenReviews(tx, runId);
        await clearOpenStages(tx, runId);
        await insertPending(tx, runId, stage, issuesToFeedback(issues), 0);
        await tx`UPDATE pipeline_runs SET state = 'running' WHERE id = ${runId}`;
        message = "Trying again.";
        return;
      }
      // revise
      await supersedeOpenReviews(tx, runId);
      await clearOpenStages(tx, runId);
      await insertPending(tx, runId, target, note, 0);
      await tx`UPDATE pipeline_runs SET state = 'running' WHERE id = ${runId}`;
      message = target === stage ? "Revision sent. Hermes is redoing this step." : `Revision sent. Hermes goes back to the ${stageLabel(target).toLowerCase()} step.`;
    });
    await safeAudit({ userId: input.userId, action: `review.${decision}`, target: input.reviewId, detail: { runId, stage, kind } });
    return { ok: true, runId, message };
  } catch (err) {
    if (err instanceof DecisionError) return { ok: false, error: err.message };
    console.error("decideReview failed", err);
    return { ok: false, error: `Could not save the decision: ${errorText(err)}` };
  }
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
      await tx`UPDATE work_orders SET state = 'cancelled' WHERE run_id = ${runId} AND state = 'pending'`;
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
    const r = await hermesJson(selfTestPrompt(), validateSelfTest, { retries: 1, timeoutMs: 60_000 });
    if (r.ok) return { ok: true, detail: `Hermes returned valid JSON (${r.attempts === 1 ? "first try" : `after ${r.attempts} tries`}).` };
    return { ok: false, detail: r.error };
  } catch (err) {
    return { ok: false, detail: `The test could not run: ${errorText(err)}` };
  }
}
