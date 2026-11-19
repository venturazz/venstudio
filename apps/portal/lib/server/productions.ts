import "server-only";
import { db } from "./db.ts";
import type { ProductionPlan } from "../studio/planner.ts";
import type { Format, Workflow } from "../studio/catalog.ts";

export interface NewProduction {
  title: string;
  brief: string;
  channelId: string;
  format: Format;
  styleId: string;
  themeId: string;
  purposes: string[];
  language: string;
  subtitles: string[];
  workflow: Workflow;
  referenceAssetId: string;
  plan: ProductionPlan;
  createdBy: string;
}

export async function insertProduction(input: NewProduction): Promise<string> {
  const [row] = await db()`
    INSERT INTO productions (title, brief, channel_id, format, style_id, theme_id, purposes, language, subtitles,
                             workflow, reference_asset_id, plan, created_by)
    VALUES (${input.title}, ${input.brief}, ${input.channelId || null}, ${input.format}, ${input.styleId},
            ${input.themeId}, ${input.purposes}::text[], ${input.language}, ${input.subtitles}::text[],
            ${input.workflow}, ${input.referenceAssetId || null},
            ${JSON.stringify(input.plan)}::text::jsonb, ${input.createdBy})
    RETURNING id
  `;
  return row.id as string;
}

export async function getProduction(id: string) {
  const [row] = await db()`
    SELECT id, title, brief, channel_id, format, plan, preview_job_id FROM productions WHERE id = ${id}
  `;
  return row as
    | { id: string; title: string; brief: string; channel_id: string | null; format: Format; plan: ProductionPlan; preview_job_id: string | null }
    | undefined;
}

export async function setPreviewJob(id: string, jobId: string) {
  await db()`UPDATE productions SET preview_job_id = ${jobId}, status = 'in_progress', updated_at = now() WHERE id = ${id}`;
}

export async function listProductions(limit = 30) {
  return db()`
    SELECT p.id, p.title, p.format, p.style_id, p.status, p.plan, p.created_at, p.preview_job_id,
           c.name AS channel, j.status AS preview_status
    FROM productions p
    LEFT JOIN channels c ON c.id = p.channel_id
    LEFT JOIN jobs j ON j.id = p.preview_job_id
    ORDER BY p.created_at DESC
    LIMIT ${limit}
  `;
}
