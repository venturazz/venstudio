/**
 * Run engine helpers, pure. Stage order, which stage a revision restarts, stuck-stage detection and the
 * one-line summary of a stage result. The database side lives in lib/server/director.ts.
 */
import { hermesStageWorstSec } from "./pacing.ts";
import { guessRevisionStage, type DirectorStage, type Idea, type ResearchNote, type RevisableStage, type Shot } from "./director.ts";

export const ENGINE_STAGES: readonly DirectorStage[] = ["idea", "research", "script", "storyboard"];
/**
 * Production stages. They are not model calls: assets runs work orders, voice runs TTS, preview (0.11.0 workers),
 * render and qc wait for a worker job.
 */
export type ProductionStage = "preview" | "assets" | "voice" | "render" | "qc";
export const PRODUCTION_STAGES: readonly ProductionStage[] = ["preview", "assets", "voice", "render", "qc"];
/**
 * Hermes stages that stand where the storyboard stands in a workflow without pictures (recipes.ts): the scene spec of a
 * data-driven page, the brief a Hermes skill renders from, and the page Hermes writes (html-design, research only).
 * Model calls, like the storyboard.
 */
export type PlanStage = "scene-spec" | "skill-brief" | "html-design";
export const PLAN_STAGES: readonly PlanStage[] = ["scene-spec", "skill-brief", "html-design"];
export type RunStage = DirectorStage | PlanStage | ProductionStage;
/**
 * The stages of a run started before workflows, and of every image-sequence run (recipes.ts): the original pipeline,
 * in order. A run's own list is in its config (runStagesOf); this stays the list for runs that have none.
 */
export const RUN_STAGES: readonly RunStage[] = [...ENGINE_STAGES, "assets", "voice", "render", "qc"];
/** Every stage kind the engine runs, in canonical order (the plan stages share the storyboard's place). */
export const STAGE_KINDS: readonly RunStage[] = ["idea", "research", "script", "storyboard", "scene-spec", "skill-brief", "html-design", "preview", "assets", "voice", "render", "qc"];
/**
 * Where a kind sits in a run: the storyboard and the plan stages share a place, so a note about one finds the other.
 * The still-frame preview sits right after the plan it shows.
 */
const SLOT: Record<RunStage, number> = { idea: 0, research: 1, script: 2, storyboard: 3, "scene-spec": 3, "skill-brief": 3, "html-design": 3, preview: 3.5, assets: 4, voice: 5, render: 6, qc: 7 };
/**
 * Worst case for one pass of a model stage: hermesJson makes up to 3 asks, each up to the stage's own call timeout
 * (pacing.ts HERMES_ASK_TIMEOUT_SEC) plus its wait for a gate slot. A slow answer ends the pass early: the stage
 * waits as pending (not running), so the wait never counts toward this limit.
 */
export function modelStageWorstCaseSec(stage: DirectorStage | PlanStage): number {
  return hermesStageWorstSec(stage);
}
/**
 * A model stage that has been running this long is treated as lost (restart, crash) and failed: its worst case plus
 * 6 minutes for the gate and DB work. Per stage, so a 10-minute research ask is never reaped as stuck.
 */
export const MODEL_STAGE_STUCK_MINUTES: Readonly<Record<DirectorStage | PlanStage, number>> = Object.fromEntries(
  (["idea", "research", "script", "storyboard", "scene-spec", "skill-brief", "html-design"] as const).map((s) => [s, Math.ceil(modelStageWorstCaseSec(s) / 60) + 6]),
) as Record<DirectorStage | PlanStage, number>;
/** The longest model stage limit: the default of isStuck when no stage is named. */
export const STUCK_MINUTES = Math.max(...Object.values(MODEL_STAGE_STUCK_MINUTES));

/** The stuck limit of a model stage, in minutes. */
export function stuckMinutesFor(stage: DirectorStage | PlanStage): number {
  return MODEL_STAGE_STUCK_MINUTES[stage];
}
/** Default video length when the owner does not pick one: inside the catalog range for each format. */
export const DEFAULT_DURATION_SEC = { short: 45, long: 600 } as const;

export function isEngineStage(s: string): s is DirectorStage {
  return ENGINE_STAGES.some((e) => e === s);
}

export function isProductionStage(s: string): s is ProductionStage {
  return PRODUCTION_STAGES.some((e) => e === s);
}

export function isPlanStage(s: string): s is PlanStage {
  return PLAN_STAGES.some((e) => e === s);
}

/** A stage Hermes answers (idea, research, script, storyboard, scene spec, skill brief, HTML design), as opposed to a production stage. */
export function isModelStage(s: string): s is DirectorStage | PlanStage {
  return isEngineStage(s) || isPlanStage(s);
}

/** A stage kind the engine runs, in any workflow. */
export function isRunStage(s: string): s is RunStage {
  return STAGE_KINDS.some((e) => e === s);
}

/** Position of `stage` in a run's list (RUN_STAGES for runs without one), -1 when the run has no such stage. */
export function stageIndex(stage: RunStage, stages: readonly RunStage[] = RUN_STAGES): number {
  return stages.indexOf(stage);
}

/** The stage after `stage` in the run's list, or null after the last one (qc), where the owner gives the final approval. */
export function nextRunStage(stage: RunStage, stages: readonly RunStage[] = RUN_STAGES): RunStage | null {
  const i = stageIndex(stage, stages);
  return i < 0 ? null : (stages[i + 1] ?? null);
}

/**
 * The stage of this run's list that stands for `kind`: the kind itself when the run has it, else the latest stage of
 * the list at or before its place (a note about the pictures in a scene-spec run restarts the scene spec; a note about
 * the voice of a skill that voices itself restarts the skill brief).
 */
export function stageInRun(kind: RunStage, stages: readonly RunStage[] = RUN_STAGES): RunStage {
  if (stages.includes(kind)) return kind;
  let best: RunStage = stages[0] ?? "idea";
  // The preview has nothing to redo of its own: a note about the pictures or the plan lands on the plan before it.
  for (const s of stages) if (SLOT[s] <= SLOT[kind] && s !== "preview") best = s;
  return best;
}

/** The stage after `stage`, or null after the storyboard (work orders and assets come next, in Phase 4). */
export function nextStage(stage: DirectorStage): DirectorStage | null {
  return ENGINE_STAGES[ENGINE_STAGES.indexOf(stage) + 1] ?? null;
}

/**
 * Which stage an owner's revision note restarts. The classifier's answer wins; without one, keywords decide; a
 * note with no keyword restarts the stage the owner was looking at. The result is never later than that stage.
 */
export function revisionTarget(classified: RunStage | null, note: string, own: RunStage, stages: readonly RunStage[] = RUN_STAGES): RunStage {
  // A note on the still frames is about the plan they show: it goes back to the stage before the preview (the scene
  // spec, or the page Hermes wrote), or earlier when the note says so. The preview itself has nothing to redo.
  if (own === "preview") {
    const before = stages[stageIndex("preview", stages) - 1];
    if (before) own = before;
  }
  let target: RunStage;
  if (classified) target = classified;
  else {
    const a: RevisableStage = guessRevisionStage(note, "idea").stage;
    const b: RevisableStage = guessRevisionStage(note, "script").stage;
    // The two fallbacks differ only when no keyword matched.
    target = a === b ? a : own;
  }
  // A kind this run does not have (a storyboard or pictures in a scene-spec run) is the run's stage in its place.
  target = stageInRun(target, stages);
  return stageIndex(target, stages) > stageIndex(own, stages) ? own : target;
}

export function isStuck(startedAt: Date | null, now: Date, minutes: number = STUCK_MINUTES): boolean {
  if (!startedAt) return false;
  return now.getTime() - startedAt.getTime() > minutes * 60_000;
}

/**
 * A run is orphaned when it is running, has a pending engine stage, and no stage is currently running: nothing
 * will ever claim that stage unless something calls advanceRun again.
 */
export function isOrphaned(runState: string, stages: readonly { stage: string; state: string }[]): boolean {
  if (runState !== "running") return false;
  if (stages.some((s) => s.state === "running")) return false;
  return stages.some((s) => s.state === "pending" && isRunStage(s.stage));
}

/** One short line for the review card and the run timeline. */
export function stageSummary(stage: DirectorStage | PlanStage, result: unknown): string {
  const r = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
  if (stage === "html-design") {
    const scenes = Array.isArray(r.scenes) ? r.scenes : [];
    const secs = scenes.reduce((sum: number, s) => sum + (typeof s === "object" && s !== null && typeof (s as Record<string, unknown>).seconds === "number" ? ((s as Record<string, unknown>).seconds as number) : 0), 0);
    const files = Array.isArray(r.files) ? r.files.length : 0;
    return `A page Hermes designed: ${files} file${files === 1 ? "" : "s"}, ${scenes.length} scene${scenes.length === 1 ? "" : "s"}, about ${Math.round(secs)} seconds (research only)`;
  }
  if (stage === "scene-spec" || stage === "skill-brief") {
    const list = Array.isArray(r.scenes) ? r.scenes : Array.isArray(r.shots) ? r.shots : [];
    const secs = list.reduce((sum: number, s) => sum + (typeof s === "object" && s !== null && typeof (s as Record<string, unknown>).seconds === "number" ? ((s as Record<string, unknown>).seconds as number) : 0), 0);
    const what = stage === "scene-spec" ? "scene" : "shot";
    return `${list.length} ${what}${list.length === 1 ? "" : "s"}, about ${Math.round(secs)} seconds${stage === "skill-brief" && typeof r.skill === "string" && r.skill ? `, for ${r.skill}` : ""}`;
  }
  if (stage === "idea") {
    const n = Array.isArray(r.ideas) ? (r.ideas as Idea[]).length : 0;
    return `${n} idea${n === 1 ? "" : "s"}`;
  }
  if (stage === "research") {
    const notes = Array.isArray(r.notes) ? (r.notes as ResearchNote[]) : [];
    return `${notes.length} note${notes.length === 1 ? "" : "s"}, ${notes.filter((n) => n.sourced).length} with a source`;
  }
  if (stage === "script") {
    const script = typeof r.script === "string" ? r.script : "";
    const count = script.split(/\s+/).filter(Boolean).length;
    return `${count} words. ${script.slice(0, 160)}${script.length > 160 ? "..." : ""}`;
  }
  const shots = Array.isArray(r.shots) ? (r.shots as Shot[]) : [];
  const total = shots.reduce((sum, s) => sum + (typeof s.seconds === "number" ? s.seconds : 0), 0);
  const steered = shots.filter((s) => typeof s.provider === "string" || typeof s.needs === "string").length;
  const notes = Array.isArray(r.notes) ? r.notes.filter((n): n is string => typeof n === "string") : [];
  const extra = [
    steered > 0 ? `${steered} with an image backend preference` : "",
    notes.length > 0 ? `${notes.length} preference${notes.length === 1 ? "" : "s"} dropped: ${notes[0]}${notes.length > 1 ? " ..." : ""}` : "",
  ].filter(Boolean);
  return `${shots.length} shot${shots.length === 1 ? "" : "s"}, about ${Math.round(total)} seconds${extra.length ? `. ${extra.join(". ")}` : ""}`;
}
