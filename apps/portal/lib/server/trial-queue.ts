import "server-only";
import { workflowForPack, workflowText } from "../studio/recipes.ts";
import { db } from "./db.ts";
import { env } from "./env.ts";
import { ensureSeedTemplates, listTemplates } from "./templates.ts";
import { reportedCapabilities } from "./workers.ts";
import { styleRegistry } from "./style-packs.ts";
import { isDesignedPack, isResearchEngine, newVideoStyles, researchGroupOf, researchSourceOf, type RegistryEntry } from "../studio/style-registry.ts";
import { parseTrialBatch, queueLines, type OfferedTemplate, type QueueLine, type QueueRun } from "../studio/trial-batch.ts";
import type { Template } from "../studio/templates.ts";

/**
 * What New Video offers, from stored worker rows and the vendored packs only (no call to a worker, Hermes or GitHub):
 * Listed styles, the Trial section (research styles grouped by their source), and the styles waiting for a worker.
 * The batch trial action checks its picks against the same list.
 */
export interface NewVideoOffer {
  listed: OfferedTemplate[];
  trial: OfferedTemplate[];
  waiting: string[];
  capabilities: string[];
  registry: RegistryEntry[];
  templates: Template[];
  hermes: boolean;
}

export function offeredTemplate(e: RegistryEntry, templates: readonly Template[], trial: boolean): OfferedTemplate | null {
  const t = templates.find((x) => x.styleId === e.id && x.status !== "retired");
  if (!t || !e.pack) return null;
  const research = isResearchEngine(e.pack.engine);
  const designed = isDesignedPack(e.pack);
  const source = researchSourceOf(e.pack);
  const group = researchGroupOf(e.pack);
  const flow = workflowForPack(e.pack);
  return {
    id: t.id,
    label: e.label,
    styleId: e.id,
    formats: [...e.pack.formats],
    trial,
    version: e.pack.version,
    engine: e.pack.engine,
    description: e.pack.description,
    ...(research ? { research: true } : {}),
    ...(designed ? { designed: true } : {}),
    ...(group ? { group } : {}),
    ...(research && e.pack.hermes ? { skill: e.pack.hermes.skill } : {}),
    ...(source && !designed && e.pack.provenance.some((p) => p.type === "skill" || p.type === "repo") ? { credit: creditOf(e) } : {}),
    ...(flow.ok ? { workflow: workflowText(flow.workflow) } : {}),
  };
}

/** "claude-animation-skills by Artem Novitckii (MIT)" from the pack's provenance, short enough for one line. */
export function creditOf(e: RegistryEntry): string {
  const src = e.pack?.provenance.find((p) => p.type === "skill" || p.type === "repo");
  if (!src || !e.pack) return "";
  const repo = researchSourceOf(e.pack) ?? "";
  const author = /Copyright \(c\) \d{4} ([^;,()]+)/.exec(src.licence)?.[1]?.trim();
  const licence = /^([A-Z][A-Za-z0-9.-]*)/.exec(src.licence)?.[1] ?? src.licence.slice(0, 20);
  return `From ${repo}${author ? ` by ${author}` : ""} (${licence})`;
}

export async function newVideoOffer(): Promise<NewVideoOffer> {
  await ensureSeedTemplates();
  const [templates, caps, registry] = await Promise.all([
    listTemplates(),
    // Stored worker rows only: no call to a worker while the page renders.
    reportedCapabilities().catch(() => [] as string[]),
    styleRegistry(),
  ]);
  const hermes = Boolean(env().HERMES_BASE_URL);
  const offer = newVideoStyles(registry, caps, { hermes });
  const pick = (list: RegistryEntry[], trial: boolean) => list.flatMap((e) => offeredTemplate(e, templates, trial) ?? []);
  return {
    listed: pick(offer.listed, false),
    trial: pick(offer.trial, true),
    waiting: offer.waiting.map((e) =>
      isResearchEngine(e.engine)
        ? `${e.label} (Trial, needs Hermes: set HERMES_BASE_URL)`
        : `${e.label} (${e.pack?.status === "trial" ? "Trial" : "Listed"}, needs pack:${e.id}@${e.pack?.version ?? "?"})`,
    ),
    capabilities: caps,
    registry,
    templates,
    hermes,
  };
}

/** The styles a batch trial may include: New Video's Trial section right now. */
export async function batchOffers(): Promise<OfferedTemplate[]> {
  return (await newVideoOffer()).trial;
}

export interface TrialQueueBatch {
  id: string;
  createdAt: Date | null;
  lines: QueueLine[];
}

/** The newest batch trials (at most `limit`), each run with where it is. Database only. Never throws. */
export async function trialQueue(limit = 3): Promise<TrialQueueBatch[]> {
  try {
    const [rows, registry] = await Promise.all([
      db()`
        SELECT r.id, r.state, r.created_at, r.config->'trialBatch' AS batch, r.config->'stylePack'->>'id' AS pack_id,
               coalesce(r.config->'stylePack'->>'engine' = 'hermes', false) AS research, s.stage, s.state AS stage_state, s.not_before
        FROM pipeline_runs r
        LEFT JOIN LATERAL (
          -- The stage the run is at: one that runs, waits or needs the owner before any finished one; skipped rows
          -- (the draft stage) never count.
          SELECT p.stage, p.state, p.not_before FROM pipeline_stages p WHERE p.run_id = r.id AND p.state <> 'skipped'
          ORDER BY CASE p.state WHEN 'running' THEN 0 WHEN 'pending' THEN 1 WHEN 'waiting-human' THEN 2 WHEN 'failed' THEN 3 ELSE 4 END,
                   p.started_at DESC NULLS LAST, p.finished_at DESC NULLS LAST, p.attempt DESC
          LIMIT 1
        ) s ON true
        WHERE r.config ? 'trialBatch'
        ORDER BY r.created_at DESC
        LIMIT 120
      `,
      styleRegistry(),
    ]);
    const batches = new Map<string, { createdAt: Date | null; runs: QueueRun[] }>();
    for (const r of rows) {
      const batch = parseTrialBatch(r.batch);
      if (!batch) continue;
      const packId = typeof r.pack_id === "string" ? r.pack_id : "";
      const until = r.not_before instanceof Date && r.not_before.getTime() > Date.now() ? r.not_before : null;
      const run: QueueRun = {
        runId: String(r.id),
        batch,
        label: registry.find((e) => e.id === packId)?.label ?? packId,
        research: r.research === true,
        state: String(r.state ?? ""),
        stage: typeof r.stage === "string" ? r.stage : "",
        stageState: typeof r.stage_state === "string" ? r.stage_state : "",
        waitingUntil: until,
      };
      const b = batches.get(batch.id) ?? { createdAt: r.created_at instanceof Date ? r.created_at : null, runs: [] };
      b.runs.push(run);
      batches.set(batch.id, b);
    }
    return [...batches.entries()].slice(0, limit).map(([id, b]) => ({ id, createdAt: b.createdAt, lines: queueLines(b.runs) }));
  } catch (err) {
    console.error("could not read the trial queue", err);
    return [];
  }
}
