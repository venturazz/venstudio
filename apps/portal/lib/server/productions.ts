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

export async function listProductions(limit = 30) {
  return db()`
    SELECT p.id, p.title, p.format, p.style_id, p.status, p.plan, p.created_at, c.name AS channel
    FROM productions p LEFT JOIN channels c ON c.id = p.channel_id
    ORDER BY p.created_at DESC
    LIMIT ${limit}
  `;
}
