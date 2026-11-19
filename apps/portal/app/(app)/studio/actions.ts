"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth.ts";
import { audit } from "@/lib/server/audit.ts";
import { getAssetRow } from "@/lib/server/assets.ts";
import { insertProduction } from "@/lib/server/productions.ts";
import { requestMeta } from "@/lib/server/request.ts";
import { fail, str, valuesFrom, type FormValues } from "@/lib/form.ts";
import { VIDEO_KINDS } from "@/lib/server/assets.ts";
import { buildPlan, detectTheme, suggestStyles, type ProductionPlan } from "@/lib/studio/planner.ts";

export type StudioState =
  | {
      error?: string;
      plan?: ProductionPlan;
      suggestions?: Array<{ styleId: string; label: string; matched: string[] }>;
      detectedThemeId?: string;
      saved?: string;
      values?: FormValues;
    }
  | undefined;

const schema = z.object({
  intent: z.enum(["suggest", "preview", "save"]),
  brief: z.string().max(4000),
  format: z.enum(["short", "long"]),
  styleId: z.string().max(60),
  themeId: z.string().max(40),
  workflow: z.enum(["original", "copycat-structure"]),
  channelId: z.union([z.uuid(), z.literal("")]),
  referenceAssetId: z.union([z.uuid(), z.literal("")]),
  title: z.string().max(120),
});

/** One action for suggest, preview and save. The button that was pressed sets `intent`. */
export async function studioAction(_prev: StudioState, fd: FormData): Promise<StudioState> {
  const user = await requireUser("editor");
  const parsed = schema.safeParse({
    intent: str(fd, "intent", 10),
    brief: str(fd, "brief", 4000),
    format: str(fd, "format", 10) || "short",
    styleId: str(fd, "styleId", 60),
    themeId: str(fd, "themeId", 40),
    workflow: str(fd, "workflow", 30) || "original",
    channelId: str(fd, "channelId", 40),
    referenceAssetId: str(fd, "referenceAssetId", 40),
    title: str(fd, "title", 120),
  });
  if (!parsed.success) return fail(fd, parsed.error.issues[0]?.message ?? "Check the form and try again.");
  const d = parsed.data;
  const values = valuesFrom(fd);

  if (d.intent === "suggest") {
    const themeId = d.themeId || detectTheme(d.brief)?.id || "";
    const suggestions = suggestStyles(d.brief, d.format, themeId || undefined).map((s) => ({
      styleId: s.style.id,
      label: s.style.label,
      matched: s.matched,
    }));
    if (suggestions.length === 0) return { suggestions, detectedThemeId: themeId, values, error: "No style matches that brief yet. Add more detail or pick one from the list." };
    return { suggestions, detectedThemeId: themeId, values };
  }

  if (d.referenceAssetId) {
    const ref = await getAssetRow(d.referenceAssetId);
    if (!ref || !VIDEO_KINDS.includes(ref.kind)) return fail(fd, "Pick a video from Assets as the reference.");
  }
  const built = buildPlan({
    brief: d.brief,
    format: d.format,
    styleId: d.styleId,
    themeId: d.themeId || undefined,
    workflow: d.workflow,
    hasReference: Boolean(d.referenceAssetId),
  });
  if (!built.ok) return fail(fd, built.error);

  if (d.intent === "preview") return { plan: built.plan, values };

  const title = d.title || `${built.plan.styleLabel}: ${d.brief.slice(0, 60)}`;
  const id = await insertProduction({
    title,
    brief: d.brief,
    channelId: d.channelId,
    format: d.format,
    styleId: d.styleId,
    themeId: d.themeId,
    workflow: d.workflow,
    referenceAssetId: d.referenceAssetId,
    plan: built.plan,
    createdBy: user.id,
  });
  await audit({ userId: user.id, action: "production.create", target: id, detail: { style: d.styleId, format: d.format }, ip: (await requestMeta()).ip });
  revalidatePath("/studio");
  return { plan: built.plan, saved: id, values };
}
