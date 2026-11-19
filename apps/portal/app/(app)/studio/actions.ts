"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/server/auth.ts";
import { db } from "@/lib/server/db.ts";
import { audit } from "@/lib/server/audit.ts";
import { getAssetRow, VIDEO_KINDS } from "@/lib/server/assets.ts";
import { getProduction, insertProduction, setPreviewJob } from "@/lib/server/productions.ts";
import { createJob } from "@/lib/server/jobs.ts";
import { previewSpec } from "@/lib/studio/preview.ts";
import { requestMeta } from "@/lib/server/request.ts";
import { fail, str, valuesFrom, type FormValues } from "@/lib/form.ts";
import { buildPlan, detectTheme, suggestStyles, type ProductionPlan } from "@/lib/studio/planner.ts";
import { LANGUAGE_BY_CODE } from "@/lib/studio/catalog.ts";

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
  purposes: z.array(z.string().max(40)).max(8),
  language: z.string().max(10).refine((c) => Boolean(LANGUAGE_BY_CODE[c]), "Choose a narration language from the list"),
  subtitles: z.array(z.string().max(10)).max(20),
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
    purposes: fd.getAll("purposes").filter((v): v is string => typeof v === "string"),
    language: str(fd, "language", 10) || "en",
    subtitles: fd.getAll("subtitles").filter((v): v is string => typeof v === "string"),
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
    if (suggestions.length === 0) {
      return { suggestions, detectedThemeId: themeId, values, error: "No style matches that brief yet. Add more detail or pick one from the list." };
    }
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
    purposeIds: d.purposes,
    language: d.language,
    subtitles: d.subtitles,
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
    purposes: built.plan.purposes.map((p) => p.id),
    language: built.plan.language.code,
    subtitles: built.plan.subtitles.map((s) => s.code),
    workflow: d.workflow,
    referenceAssetId: d.referenceAssetId,
    plan: built.plan,
    createdBy: user.id,
  });
  await audit({
    userId: user.id,
    action: "production.create",
    target: id,
    detail: { style: d.styleId, format: d.format, language: built.plan.language.code, purposes: built.plan.purposes.map((p) => p.id) },
    ip: (await requestMeta()).ip,
  });
  revalidatePath("/studio");
  return { plan: built.plan, saved: id, values };
}


/** Queues a test render for a saved production, then opens the job so its progress and video can be checked. */
export async function queuePreviewAction(productionId: string) {
  const user = await requireUser("editor");
  if (!z.uuid().safeParse(productionId).success) return;
  const production = await getProduction(productionId);
  if (!production) return;
  const spec = previewSpec(production.plan, production.brief);
  // The newest font in the library gives the cards real text; without one the render still runs, without text.
  const [font] = await db()`SELECT id FROM assets WHERE kind = 'font' AND storage_path IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
  const fontAssetId = font ? (font.id as string) : null;
  const jobId = await createJob({
    type: "render-preview",
    payload: { ...spec, productionId, fontAssetId, inputs: fontAssetId ? [fontAssetId] : [] },
    channelId: production.channel_id,
    createdBy: user.id,
  });
  await setPreviewJob(productionId, jobId);
  await audit({ userId: user.id, action: "production.preview", target: productionId, detail: { jobId }, ip: (await requestMeta()).ip });
  revalidatePath("/studio");
  redirect(`/jobs/${jobId}`);
}
