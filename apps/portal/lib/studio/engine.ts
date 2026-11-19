/**
 * Run engine helpers, pure. Stage order, which stage a revision restarts, stuck-stage detection and the
 * one-line summary of a stage result. The database side lives in lib/server/director.ts.
 */
import { guessRevisionStage, type DirectorStage, type Idea, type ResearchNote, type RevisableStage, type Shot } from "./director.ts";

export const ENGINE_STAGES: readonly DirectorStage[] = ["idea", "research", "script", "storyboard"];
/** A stage that has been running this long is treated as lost (restart, crash) and failed. */
export const STUCK_MINUTES = 10;
/** Default video length when the owner does not pick one: inside the catalog range for each format. */
export const DEFAULT_DURATION_SEC = { short: 45, long: 600 } as const;

export function isEngineStage(s: string): s is DirectorStage {
  return ENGINE_STAGES.some((e) => e === s);
}

export function stageIndex(stage: DirectorStage): number {
  return ENGINE_STAGES.indexOf(stage);
}

/** The stage after `stage`, or null after the storyboard (work orders and assets come next, in Phase 4). */
export function nextStage(stage: DirectorStage): DirectorStage | null {
  return ENGINE_STAGES[stageIndex(stage) + 1] ?? null;
}

/**
 * Which stage an owner's revision note restarts. The classifier's answer wins; without one, keywords decide; a
 * note with no keyword restarts the stage the owner was looking at. The result is never later than that stage.
 */
export function revisionTarget(classified: DirectorStage | null, note: string, own: DirectorStage): DirectorStage {
  let target: DirectorStage;
  if (classified) target = classified;
  else {
    const a: RevisableStage = guessRevisionStage(note, "idea").stage;
    const b: RevisableStage = guessRevisionStage(note, "script").stage;
    // The two fallbacks differ only when no keyword matched.
    target = a === b ? a : own;
  }
  return stageIndex(target) > stageIndex(own) ? own : target;
}

export function isStuck(startedAt: Date | null, now: Date, minutes: number = STUCK_MINUTES): boolean {
  if (!startedAt) return false;
  return now.getTime() - startedAt.getTime() > minutes * 60_000;
}

/** One short line for the review card and the run timeline. */
export function stageSummary(stage: DirectorStage, result: unknown): string {
  const r = (typeof result === "object" && result !== null ? result : {}) as Record<string, unknown>;
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
  return `${shots.length} shot${shots.length === 1 ? "" : "s"}, about ${Math.round(total)} seconds`;
}
