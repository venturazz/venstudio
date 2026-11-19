import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { openStored } from "./storage.ts";
import { saveDraftTemplate } from "./templates.ts";
import { STYLE_BY_ID } from "../studio/catalog.ts";
import {
  blendFingerprints,
  candidateFromDraft,
  draftFromFingerprint,
  fingerprint,
  originalityGuard,
  type AnalysisInput,
  type StructureFingerprint,
} from "../studio/template-lab.ts";
import type { Template } from "../studio/templates.ts";

/** UI for the Template Lab is Phase 7 (docs/architecture-autonomous-studio.md). This is the server path only. */

export type LabDraftResult =
  | { ok: true; template: Template; samples: number; readyForTrials: boolean; notes: string[] }
  | { ok: false; issues: string[] };

function isAnalysis(v: unknown): v is AnalysisInput {
  const a = v as Partial<AnalysisInput> | null;
  return (
    typeof a === "object" &&
    a !== null &&
    typeof a.video?.durationSec === "number" &&
    typeof a.video.width === "number" &&
    typeof a.video.height === "number" &&
    Array.isArray(a.cuts) &&
    typeof a.shots?.count === "number" &&
    typeof a.pacing?.cutsPerMinute === "number" &&
    a.hook !== undefined
  );
}

async function readText(storagePath: string): Promise<string> {
  const { stream } = await openStored(storagePath);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

interface Sample {
  fp: StructureFingerprint;
  sha256: string;
  title: string;
  channel: string;
}

/** Reads the analysis.json of one succeeded analyze-video job. Returns null when the job has no usable analysis. */
async function loadSample(jobId: string): Promise<Sample | null> {
  const [row] = await db()`
    SELECT ar.storage_path, ar.sha256 AS artifact_sha, j.payload,
           a.title AS asset_title, a.sha256 AS asset_sha, c.name AS channel_name
    FROM jobs j
    JOIN artifacts ar ON ar.job_id = j.id AND ar.name = 'analysis.json'
    LEFT JOIN assets a ON a.id::text = j.payload->'inputs'->>0
    LEFT JOIN channels c ON c.id = a.channel_id
    WHERE j.id = ${jobId} AND j.type = 'analyze-video' AND j.status = 'succeeded'
  `;
  if (!row) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(await readText(row.storage_path as string));
  } catch {
    return null;
  }
  if (!isAnalysis(doc)) return null;
  return {
    fp: fingerprint(doc),
    sha256: (row.asset_sha as string | null) ?? (row.artifact_sha as string),
    title: (row.asset_title as string | null) ?? "",
    channel: (row.channel_name as string | null) ?? "",
  };
}

/**
 * Blends the structure of one or more analyzed samples into a draft template. The draft is saved as a draft
 * whatever the sample count; `readyForTrials` is true only with three or more samples and a clean originality check.
 */
export async function blendDraft(jobIds: string[], baseStyleId: string): Promise<LabDraftResult> {
  const unique = [...new Set(jobIds)];
  if (unique.length === 0) return { ok: false, issues: ["Pick at least one analyzed sample"] };
  const style = STYLE_BY_ID[baseStyleId];
  if (!style) return { ok: false, issues: ["Unknown base style"] };
  const samples: Sample[] = [];
  for (const id of unique) {
    const s = await loadSample(id);
    if (!s) return { ok: false, issues: [`Job ${id} has no finished analysis`] };
    samples.push(s);
  }
  const blended = blendFingerprints(samples.map((s) => s.fp));
  // Only a hash of the sample set is kept. Titles and channel names are used for the originality check and then dropped.
  const sampleSha256 = createHash("sha256").update(samples.map((s) => s.sha256).sort().join(":")).digest("hex");
  const draft = draftFromFingerprint(blended, baseStyleId, {
    sampleSha256,
    analyzedAt: new Date().toISOString(),
    label: `Learned from ${samples.length} sample${samples.length === 1 ? "" : "s"}: ${style.label}`,
    idSuffix: randomUUID().slice(0, 8),
  });
  const notes: string[] = [];
  const guardIssues: string[] = [];
  for (const s of samples) {
    guardIssues.push(...originalityGuard(draft, { title: s.title, channel: s.channel, fingerprint: samples.length === 1 ? s.fp : undefined }));
  }
  if (guardIssues.length > 0) return { ok: false, issues: [...new Set(guardIssues)] };
  const candidate = candidateFromDraft(draft, { title: samples[0].title, channel: samples[0].channel });
  notes.push(...candidate.issues);
  const saved = await saveDraftTemplate(draft);
  if (!saved) return { ok: false, issues: ["The draft could not be saved"] };
  return { ok: true, template: draft, samples: samples.length, readyForTrials: candidate.issues.length === 0, notes };
}

export function createDraftFromAnalysisJob(jobId: string, baseStyleId: string): Promise<LabDraftResult> {
  return blendDraft([jobId], baseStyleId);
}
