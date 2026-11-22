/**
 * Batch trials: one brief, several research (or Trial) styles, one run each. Pure, so the form, the server action and
 * the tests share the rule.
 *
 * Every run of a batch is an ordinary trial run (startRun), marked with the batch in pipeline_runs.config.trialBatch
 * (additive). They are started together; Hermes works through them one ask at a time, because every portal call to
 * Hermes goes through its gate (lib/server/hermes-gate.ts, one model turn at a time unless HERMES_MAX_CONCURRENCY says
 * otherwise), and a Hermes render holds that slot for the whole render. The queue shows where each run is.
 */
import type { Format } from "./catalog.ts";

export const MIN_BATCH_TRIALS = 2;
/** Ten skills of claude-animation-skills plus the generic Hermes render, with room for one more. */
export const MAX_BATCH_TRIALS = 12;
export const TRY_THESE_STYLES = "Try these styles";

export interface TrialBatch {
  /** A UUID for the batch. */
  id: string;
  /** 1-based position in the batch. */
  index: number;
  total: number;
}

/**
 * A style New Video offers (a template of a Listed or Trial pack, or a lab trial). Strings and lists only, so it
 * crosses to the client as is.
 */
export interface OfferedTemplate {
  /** The template id (tpl-<style id>). */
  id: string;
  label: string;
  styleId: string;
  formats: Format[];
  /** In the Trial section: research only, not for publishing. */
  trial: boolean;
  /** The style pack version. */
  version?: string;
  /** The pack's renderer (for packs the catalogue does not know, the engine line reads it). */
  engine?: string;
  description?: string;
  /** Rendered by Hermes with its own tools: research only, never published (always a trial). */
  research?: boolean;
  /** The research group, e.g. "Hermes research styles (from claude-animation-skills)". */
  group?: string;
  /** The Hermes skill a research style renders with, e.g. "/graph". */
  skill?: string;
  /** The source credit, e.g. "From claude-animation-skills by Artem Novitckii (MIT)". */
  credit?: string;
  /** A lab trial of a Draft or Lab pack (from Styles or a study): research only, never published. */
  lab?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why the batch cannot start, or [] when it can. The order of `templateIds` is the order the runs are started in. */
export function batchTrialIssues(i: { templateIds: readonly string[]; offered: readonly OfferedTemplate[]; format: Format }): string[] {
  const issues: string[] = [];
  const ids = i.templateIds;
  if (ids.length < MIN_BATCH_TRIALS) issues.push(`Pick at least ${MIN_BATCH_TRIALS} styles to try together (for one style, use "Ask Hermes for ideas")`);
  if (ids.length > MAX_BATCH_TRIALS) issues.push(`Pick at most ${MAX_BATCH_TRIALS} styles in one batch`);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      issues.push(`${id} is picked twice`);
      continue;
    }
    seen.add(id);
    const o = i.offered.find((x) => x.id === id);
    if (!o || !o.trial || o.lab) issues.push(`${o?.label ?? id} is not a Trial or research style New Video offers right now`);
    else if (!o.formats.includes(i.format)) issues.push(`${o.label} does not make ${i.format} videos`);
  }
  return issues;
}

export function parseTrialBatch(raw: unknown): TrialBatch | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" && UUID_RE.test(r.id) ? r.id : null;
  const index = typeof r.index === "number" && Number.isInteger(r.index) ? r.index : 0;
  const total = typeof r.total === "number" && Number.isInteger(r.total) ? r.total : 0;
  if (!id || total < 1 || total > MAX_BATCH_TRIALS || index < 1 || index > total) return null;
  return { id, index, total };
}

export interface QueueRun {
  runId: string;
  batch: TrialBatch;
  label: string;
  state: string;
  /** The newest stage and its state, e.g. "render" / "running". */
  stage: string;
  stageState: string;
  /** The stage waits for a busy Hermes until then. */
  waitingUntil: Date | null;
}

export interface QueueLine {
  runId: string;
  position: string;
  label: string;
  status: string;
  tone: "ok" | "warn" | "info" | "neutral" | "danger";
}

const STAGE_TEXT: Record<string, string> = {
  idea: "ideas",
  research: "research",
  script: "script",
  storyboard: "storyboard",
  assets: "pictures",
  voice: "voice",
  render: "render",
  qc: "quality check",
};

/** One line per run of a batch, in batch order: where it is and whether it waits for the owner or for Hermes. */
export function queueLines(runs: readonly QueueRun[]): QueueLine[] {
  return [...runs]
    .sort((a, b) => a.batch.index - b.batch.index)
    .map((r) => {
      const step = STAGE_TEXT[r.stage] ?? r.stage;
      const position = `${r.batch.index} of ${r.batch.total}`;
      if (r.state === "done") return { runId: r.runId, position, label: r.label, status: "Finished", tone: "ok" };
      if (r.state === "cancelled" || r.state === "failed") return { runId: r.runId, position, label: r.label, status: r.state === "failed" ? "Stopped" : "Cancelled", tone: "danger" };
      if (r.waitingUntil) return { runId: r.runId, position, label: r.label, status: `Waiting for Hermes (${step})`, tone: "warn" };
      if (r.stageState === "running") return { runId: r.runId, position, label: r.label, status: r.stage === "render" ? "Hermes is rendering" : `Hermes is on the ${step}`, tone: "info" };
      if (r.state === "waiting-human" || r.stageState === "waiting-human" || r.stageState === "failed") return { runId: r.runId, position, label: r.label, status: `Waiting for you in Review (${step})`, tone: "warn" };
      if (r.stageState === "pending") return { runId: r.runId, position, label: r.label, status: `Queued for Hermes (${step})`, tone: "neutral" };
      return { runId: r.runId, position, label: r.label, status: `${step}: ${r.stageState || "started"}`, tone: "neutral" };
    });
}
