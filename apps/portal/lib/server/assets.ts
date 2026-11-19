import "server-only";
import { db } from "./db.ts";
import { createJob } from "./jobs.ts";
import type { AssetKind, AssetSource } from "../studio/catalog.ts";

export const VIDEO_KINDS: AssetKind[] = ["video", "reference-video"];

export interface AssetInput {
  title: string;
  kind: AssetKind;
  source: AssetSource;
  license: string;
  originUrl: string;
  tags: string;
  channelId: string;
  createdBy: string;
}

function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim().toLowerCase().slice(0, 40))
    .filter(Boolean)
    .slice(0, 20);
}

export async function insertAssetRow(input: AssetInput): Promise<string> {
  const [row] = await db()`
    INSERT INTO assets (title, kind, source, license, origin_url, tags, channel_id, created_by)
    VALUES (${input.title}, ${input.kind}, ${input.source}, ${input.license}, ${input.originUrl},
            ${parseTags(input.tags)}::text[], ${input.channelId || null}, ${input.createdBy})
    RETURNING id
  `;
  return row.id as string;
}

export async function finishAssetUpload(
  id: string,
  file: { contentType: string; bytes: number; sha256: string; storagePath: string },
) {
  await db()`
    UPDATE assets SET content_type = ${file.contentType}, bytes = ${file.bytes}, sha256 = ${file.sha256},
      storage_path = ${file.storagePath}
    WHERE id = ${id}
  `;
}

export async function deleteAssetRow(id: string) {
  await db()`DELETE FROM assets WHERE id = ${id}`;
}

export async function getAssetRow(id: string) {
  const [row] = await db()`SELECT * FROM assets WHERE id = ${id}`;
  return row as
    | {
        id: string;
        title: string;
        kind: AssetKind;
        source: AssetSource;
        license: string;
        origin_url: string;
        tags: string[];
        content_type: string | null;
        bytes: string | number | null;
        sha256: string | null;
        storage_path: string | null;
        metadata: Record<string, unknown>;
        created_at: Date;
      }
    | undefined;
}

export interface AnalysisSummary {
  cutCount: number;
  avgShotSeconds: number;
  firstCutSeconds: number | null;
  cutsPerMinute: number;
  loudnessLufs: number | null;
  durationSec: number;
}

/** Newest asset rows, with the latest successful analysis of each video attached. */
export async function listAssets(kind?: AssetKind, limit = 200) {
  return db()`
    SELECT a.id, a.title, a.kind, a.source, a.license, a.origin_url, a.tags, a.bytes, a.content_type, a.sha256,
           a.created_at, c.name AS channel,
           (SELECT j.result FROM jobs j
             WHERE j.type = 'analyze-video' AND j.status = 'succeeded'
               AND j.payload->'inputs' @> to_jsonb(ARRAY[a.id::text])
             ORDER BY j.finished_at DESC LIMIT 1) AS analysis
    FROM assets a LEFT JOIN channels c ON c.id = a.channel_id
    WHERE (${kind ?? null}::text IS NULL OR a.kind = ${kind ?? null})
    ORDER BY a.created_at DESC
    LIMIT ${limit}
  `;
}

/** Queues a study job for a reference video. The worker can only download this one asset. */
export async function queueAnalysis(assetId: string, createdBy: string): Promise<string> {
  return createJob({ type: "analyze-video", payload: { inputs: [assetId] }, createdBy });
}

/**
 * Makes a worker output visible in the library without copying bytes: the asset points at the artifact file.
 * Idempotent: promoting the same artifact twice returns the existing asset.
 */
export async function promoteArtifact(artifactId: string, createdBy: string): Promise<string | null> {
  const sql = db();
  const [existing] = await sql`SELECT id FROM assets WHERE metadata->>'artifactId' = ${artifactId}`;
  if (existing) return existing.id as string;
  const [a] = await sql`
    SELECT ar.id, ar.name, ar.content_type, ar.bytes, ar.sha256, ar.storage_path, j.id AS job_id, j.type AS job_type,
           w.host AS worker_host, j.channel_id
    FROM artifacts ar
    JOIN jobs j ON j.id = ar.job_id
    LEFT JOIN workers w ON w.id = j.worker_id
    WHERE ar.id = ${artifactId}
  `;
  if (!a) return null;
  const contentType = String(a.content_type);
  const kind: AssetKind = contentType.startsWith("video/")
    ? "video"
    : contentType.startsWith("image/")
      ? "image"
      : contentType.startsWith("audio/")
        ? "audio"
        : "other";
  const source: AssetSource = a.worker_host === "muse" ? "muse" : "worker";
  const [row] = await sql`
    INSERT INTO assets (title, kind, source, license, tags, channel_id, content_type, bytes, sha256, storage_path, metadata, created_by)
    VALUES (${`${a.job_type}: ${a.name}`}, ${kind}, ${source},
            ${"Own render made with VenStudio"}, '{}'::text[], ${a.channel_id}, ${a.content_type}, ${a.bytes},
            ${a.sha256}, ${a.storage_path}, ${JSON.stringify({ artifactId, jobId: a.job_id })}::text::jsonb, ${createdBy})
    RETURNING id
  `;
  return row.id as string;
}
