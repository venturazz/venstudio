/**
 * Autonomy policy: when the owner is asked and when the studio may act alone. Pure functions.
 * Levels: 0 manual, 1 ideas and final approval by owner, 2 final approval only, 3 auto-publish when QC passes.
 * The owner alone sets channel category, worker mapping and autonomy level; nothing here changes them.
 */
import type { CombinedQc, ClaimStatus, GateId } from "./qc.ts";
import { isAutonomyEligible, type Template } from "./templates.ts";

export type AutonomyLevel = 0 | 1 | 2 | 3;
export type AutonomyAction = "ask-owner" | "auto-approve" | "auto-publish" | "revise" | "block";

export const AUTO_PUBLISH_MIN_SCORE = 85;
export const SPOT_CHECK_EVERY = 5;
export const MAX_AUTO_REVISIONS = 2;
/** Assets or compliance failures get one automatic revision, then go to the owner. */
export const MAX_HARD_GATE_REVISIONS = 1;

interface DecisionBase {
  level: AutonomyLevel;
  paused: boolean;
  template: Template;
  qc: CombinedQc;
  /** Videos auto-published since the owner last reviewed one. The next video is a spot check at SPOT_CHECK_EVERY minus 1. */
  videosSincePublishSpotCheck: number;
  /** Automatic revisions already made at this point. */
  attempts?: number;
}

/**
 * "stage" is an intermediate gate result and needs its stage id (at level 1 the owner approves the idea stage).
 * "final" (the default) is the approval before upload and publish.
 */
export type DecisionInput = DecisionBase & ({ point?: "final"; stage?: undefined } | { point: "stage"; stage: string });

export interface Decision {
  action: AutonomyAction;
  reason: string;
}

/** Paused channels and templates that are not proven behave like level 1 (never above it). */
export function effectiveLevel(level: AutonomyLevel, paused: boolean, template: Template): AutonomyLevel {
  if (paused || !isAutonomyEligible(template)) return level > 1 ? 1 : level;
  return level;
}

export function isSpotCheck(videosSincePublishSpotCheck: number): boolean {
  return videosSincePublishSpotCheck + 1 >= SPOT_CHECK_EVERY;
}

const HARD: GateId[] = ["G-assets", "G-compliance"];

export function decideNext(input: DecisionInput): Decision {
  const attempts = input.attempts ?? 0;
  const point = input.point ?? "final";
  const { qc, template } = input;
  if (template.status === "retired") return { action: "block", reason: "The template is retired" };
  if (qc.failedGates.includes("G-claims")) return { action: "block", reason: "A copyright claim or restriction blocks publishing" };
  const level = effectiveLevel(input.level, input.paused, template);

  if (!qc.passed) {
    if (qc.failedGates.length === 0 && (qc.missingGates ?? []).length > 0) {
      return { action: "ask-owner", reason: `${qc.missingGates.join(", ")} has not run yet` };
    }
    if (level === 0) return { action: "ask-owner", reason: "Manual mode: the owner reviews every result" };
    const hard = qc.failedGates.some((g) => HARD.includes(g));
    const cap = hard ? MAX_HARD_GATE_REVISIONS : MAX_AUTO_REVISIONS;
    if (attempts < cap) return { action: "revise", reason: `${qc.failedGates.join(", ")} failed; automatic revision ${attempts + 1} of ${cap}` };
    return { action: "ask-owner", reason: `${qc.failedGates.join(", ")} still failing after ${attempts} revision(s)` };
  }

  if (level === 0) return { action: "ask-owner", reason: "Manual mode: the owner approves every stage" };
  if (point === "stage" && !input.stage) return { action: "ask-owner", reason: "The stage of this result is unknown" };
  if (point === "stage" && level < 2 && input.stage === "idea") return { action: "ask-owner", reason: "At level 1 the owner approves ideas" };
  if (point === "stage" && level < 2 && input.stage === "assets") return { action: "ask-owner", reason: "At level 1 the owner approves the assets" };
  if (point === "stage") return { action: "auto-approve", reason: "All gates passed for this stage" };
  if (level < 3) return { action: "ask-owner", reason: "Final approval is the owner's at this level" };
  if (qc.score < AUTO_PUBLISH_MIN_SCORE) return { action: "ask-owner", reason: `QC score ${qc.score} is below ${AUTO_PUBLISH_MIN_SCORE}` };
  if (isSpotCheck(input.videosSincePublishSpotCheck)) return { action: "ask-owner", reason: `Spot check: every ${SPOT_CHECK_EVERY}th video goes to the owner` };
  return { action: "auto-publish", reason: `All gates passed, score ${qc.score}, proven template` };
}

export interface ChannelInfo {
  id: string;
  /** Owner-chosen home worker, or null. */
  homeWorkerId: string | null;
}

export interface WorkerInfo {
  id: string;
  lastSeenAt: Date | string | null;
  /** Jobs the worker is running right now. */
  running: number;
  capabilities: string[];
}

export type AssignResult =
  | { workerId: string; via: "home" | "idle"; reason: string }
  | { workerId: null; via: null; reason: string };

/** Same window as the worker presence rule in lib/server/workers.ts (seen within 75 minutes). */
export const WORKER_REACHABLE_MINUTES = 75;

function reachable(w: WorkerInfo, now: Date): boolean {
  if (!w.lastSeenAt) return false;
  return (now.getTime() - new Date(w.lastSeenAt).getTime()) / 60_000 < WORKER_REACHABLE_MINUTES;
}

/**
 * Picks a worker for one production: the channel's home worker first, then any idle capable worker.
 * Returns only a worker id. It never sets a channel's category or home worker; those are the owner's decisions.
 */
export function autoAssign(input: { channelId: string; channels: ChannelInfo[]; workers: WorkerInfo[]; requiredCapabilities: string[]; now: Date }): AssignResult {
  const capable = input.workers.filter((w) => reachable(w, input.now) && input.requiredCapabilities.every((c) => w.capabilities.includes(c)));
  const channel = input.channels.find((c) => c.id === input.channelId);
  if (channel?.homeWorkerId) {
    const home = capable.find((w) => w.id === channel.homeWorkerId);
    if (home) return { workerId: home.id, via: "home", reason: "The channel's home worker is reachable and capable" };
  }
  const idle = capable.filter((w) => w.running === 0).sort((a, b) => a.id.localeCompare(b.id))[0];
  if (idle) return { workerId: idle.id, via: "idle", reason: "An idle capable worker was free" };
  return { workerId: null, via: null, reason: "No reachable idle worker has the needed capabilities; the owner can assign one" };
}

export type DemotionAction = { action: "pause-channel-autonomy" | "demote-template" | "block-publish"; reason: string };

/** What must happen when YouTube reports a claim, restriction or strike. A clear status changes nothing. */
export function afterClaim(status: ClaimStatus): DemotionAction[] {
  if (status === "clear" || status === "unknown") return [];
  const reason = `YouTube reported a ${status}`;
  return [
    { action: "block-publish", reason },
    { action: "pause-channel-autonomy", reason },
    { action: "demote-template", reason },
  ];
}
